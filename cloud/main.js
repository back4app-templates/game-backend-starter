// File: cloud/main.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19: no Node 20+ only features)
//
// Everything that writes to Player, Score, Best, Save or RejectedScore goes through the functions below,
// which run with the master key. The beforeSave/beforeDelete hooks at the bottom reject every non-master
// write, and the class-level permissions created by scripts/setup.mjs close create/update/delete to clients.
//
// Error convention: functions throw Parse.Error with a numeric Parse code and a JSON string message
// {"code":"STALE_SAVE","message":"…", …extra}. Parse.Error only carries (number, string), so the string is
// the envelope. Clients: `const e = parseCloudError(err)` (see public/app.js) → e.code, e.currentVersion, …
'use strict';

const config = require('./config.js');

const MASTER = { useMasterKey: true };
const PE = Parse.Error;

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

function fail(code, message, extra, parseCode) {
  const payload = Object.assign({ code: code, message: message }, extra || {});
  throw new PE(parseCode || PE.VALIDATION_ERROR, JSON.stringify(payload));
}

function requireUser(request) {
  if (!request.user) {
    fail('UNAUTHENTICATED', 'Sign in (a guest session is fine) before calling this function.', null, PE.INVALID_SESSION_TOKEN);
  }
  return request.user;
}

// Dates go out as ISO strings: Cloud function results otherwise encode Date as {__type:'Date', iso} objects.
function iso(d) {
  return d instanceof Date ? d.toISOString() : d || null;
}

function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

function requireLevel(level) {
  if (!isInt(level) || level < 1 || level > config.MAX_LEVEL) {
    fail('INVALID_ARGS', 'level must be an integer in 1..' + config.MAX_LEVEL, { field: 'level' });
  }
  return level;
}

function requireScope(scope) {
  const s = scope === undefined ? 'alltime' : scope;
  if (s !== 'alltime' && s !== 'weekly') fail('INVALID_ARGS', "scope must be 'alltime' or 'weekly'", { field: 'scope' });
  return s;
}

function resolveWeek(scope, week) {
  if (scope !== 'weekly') return null;
  if (week === undefined || week === null) return config.weekKey(new Date());
  if (typeof week !== 'string' || !config.WEEK_KEY_RE.test(week)) {
    fail('INVALID_ARGS', 'week must look like 2026-W43', { field: 'week' });
  }
  return week;
}

function ownerReadAcl(user) {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(false);
  acl.setPublicWriteAccess(false);
  acl.setReadAccess(user, true);
  acl.setWriteAccess(user, false);
  return acl;
}

function publicReadAcl() {
  const acl = new Parse.ACL();
  acl.setPublicReadAccess(true);
  acl.setPublicWriteAccess(false);
  return acl;
}

function defaultDisplayName(user) {
  return 'Guest-' + String(user.id).slice(0, 4).toUpperCase();
}

function cleanDisplayName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('INVALID_ARGS', 'displayName must be a string', { field: 'displayName' });
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length < config.DISPLAY_NAME_MIN || trimmed.length > config.DISPLAY_NAME_MAX) {
    fail('INVALID_ARGS', 'displayName must be ' + config.DISPLAY_NAME_MIN + '..' + config.DISPLAY_NAME_MAX + ' characters', { field: 'displayName' });
  }
  return trimmed;
}

function cleanCountry(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value)) {
    fail('INVALID_ARGS', 'country must be a two-letter ISO 3166-1 code or empty', { field: 'country' });
  }
  return value.toUpperCase();
}

// The Player profile for a user. Self-heals the (unlikely) duplicate created by two concurrent first calls:
// the oldest row wins, newer ones are deleted. There is no unique index on Player.user (Parse schema API
// cannot declare one), so this is best effort — see README "Guarantees and limits".
async function findPlayer(user) {
  const q = new Parse.Query('Player');
  q.equalTo('user', user);
  q.ascending('createdAt');
  q.limit(5);
  const rows = await q.find(MASTER);
  if (rows.length > 1) {
    await Parse.Object.destroyAll(rows.slice(1), MASTER);
  }
  return rows[0] || null;
}

async function getOrCreatePlayer(user) {
  let player = await findPlayer(user);
  let created = false;
  if (!player) {
    player = new Parse.Object('Player');
    player.set('user', user);
    player.set('displayName', defaultDisplayName(user));
    player.set('country', '');
    player.set('lastSessionCounter', 0);
    player.set('submitWindowStart', new Date(0));
    player.set('submitCount', 0);
    player.setACL(ownerReadAcl(user));
    await player.save(null, MASTER);
    created = true;
  }
  return { player: player, created: created };
}

function playerJson(player, created) {
  return {
    id: player.id,
    userId: player.get('user').id,
    displayName: player.get('displayName'),
    country: player.get('country') || '',
    lastSessionCounter: player.get('lastSessionCounter') || 0,
    created: !!created,
  };
}

async function logRejection(user, reason, level, score, sessionCounter) {
  const row = new Parse.Object('RejectedScore');
  row.set('player', user);
  row.set('reason', reason);
  if (isInt(level)) row.set('level', level);
  if (typeof score === 'number' && Number.isFinite(score)) row.set('score', score);
  if (isInt(sessionCounter)) row.set('sessionCounter', sessionCounter);
  row.setACL(new Parse.ACL()); // nobody but the master key reads the log
  await row.save(null, MASTER);
}

async function findBest(user, level) {
  const q = new Parse.Query('Best');
  q.equalTo('player', user);
  q.equalTo('level', level);
  return q.first(MASTER);
}

function bestJson(best) {
  if (!best) return null;
  return {
    level: best.get('level'),
    score: best.get('score'),
    week: best.get('week'),
    weekScore: best.get('weekScore'),
    since: iso(best.createdAt),
  };
}

// ---------------------------------------------------------------------------------------------------------
// 1. Player accounts
// ---------------------------------------------------------------------------------------------------------

// ensurePlayer({displayName?, country?}) → Player profile. Creates the profile on first call, updates the
// optional fields on later calls. Works for anonymous and for upgraded users alike (same _User, same Player).
Parse.Cloud.define('ensurePlayer', async (request) => {
  const user = requireUser(request);
  const params = request.params || {};
  const displayName = cleanDisplayName(params.displayName);
  const country = cleanCountry(params.country);

  const found = await getOrCreatePlayer(user);
  const player = found.player;
  let dirty = false;
  if (displayName !== undefined && displayName !== player.get('displayName')) {
    player.set('displayName', displayName);
    dirty = true;
  }
  if (country !== undefined && country !== player.get('country')) {
    player.set('country', country);
    dirty = true;
  }
  if (dirty) {
    await player.save(null, MASTER);
    if (displayName !== undefined) {
      // Best rows carry a denormalised playerName for cheap leaderboard reads: keep them in sync.
      const q = new Parse.Query('Best');
      q.equalTo('player', user);
      q.limit(config.MAX_LEVEL);
      const bests = await q.find(MASTER);
      bests.forEach((b) => b.set('playerName', displayName));
      if (bests.length) await Parse.Object.saveAll(bests, MASTER);
    }
  }
  return playerJson(player, found.created);
});

// ---------------------------------------------------------------------------------------------------------
// 2. Scores and leaderboards
// ---------------------------------------------------------------------------------------------------------

// submitScore({level, score, sessionCounter, clientNonce})
//   Order of checks: args → replay (same clientNonce → return the original result, counted once) →
//   rate limit → monotonic counter → ceiling. Every rejection writes a RejectedScore row and throws.
//   Accepted: appends a Score row (per-submission history) and upserts the player's Best row for the level.
//   This bounds abuse (impossible scores, floods, replays, out-of-order sessions); it does not prove that the
//   score came from real gameplay. See README "What is and is not validated".
Parse.Cloud.define('submitScore', async (request) => {
  const user = requireUser(request);
  const p = request.params || {};
  const level = requireLevel(p.level);
  const score = p.score;
  const sessionCounter = p.sessionCounter;
  const clientNonce = p.clientNonce;
  if (!isInt(score) || score < 0) fail('INVALID_ARGS', 'score must be a non-negative integer', { field: 'score' });
  if (!isInt(sessionCounter) || sessionCounter < 1) fail('INVALID_ARGS', 'sessionCounter must be a positive integer', { field: 'sessionCounter' });
  if (typeof clientNonce !== 'string' || !config.CLIENT_NONCE_RE.test(clientNonce)) {
    fail('INVALID_ARGS', 'clientNonce must be 8..64 URL-safe characters (a UUID is fine)', { field: 'clientNonce' });
  }

  const player = (await getOrCreatePlayer(user)).player;

  // Replay: the same nonce from the same player is the same submission (network retry). Return the original
  // result; do not count it against the rate limit, do not touch the counter.
  const dupQ = new Parse.Query('Score');
  dupQ.equalTo('player', user);
  dupQ.equalTo('clientNonce', clientNonce);
  const dup = await dupQ.first(MASTER);
  if (dup) {
    const existingBest = await findBest(user, dup.get('level'));
    return {
      accepted: true,
      replay: true,
      scoreId: dup.id,
      level: dup.get('level'),
      score: dup.get('score'),
      week: dup.get('week'),
      best: bestJson(existingBest),
    };
  }

  // Rate limit: fixed window on the Player row. Rejected attempts count too.
  const now = new Date();
  let windowStart = player.get('submitWindowStart') || new Date(0);
  let count = player.get('submitCount') || 0;
  if (now.getTime() - windowStart.getTime() >= config.RATE_LIMIT.windowMs) {
    windowStart = now;
    count = 0;
  }
  count += 1;
  player.set('submitWindowStart', windowStart);
  player.set('submitCount', count);
  if (count > config.RATE_LIMIT.max) {
    await player.save(null, MASTER);
    await logRejection(user, 'RATE_LIMITED', level, score, sessionCounter);
    const retryAfterMs = Math.max(0, config.RATE_LIMIT.windowMs - (now.getTime() - windowStart.getTime()));
    fail('RATE_LIMITED', 'Too many submissions; try again later.', { retryAfterMs: retryAfterMs, max: config.RATE_LIMIT.max, windowMs: config.RATE_LIMIT.windowMs });
  }

  // Monotonic session counter: a counter at or below the last accepted/consumed one is a replay or a reorder.
  const last = player.get('lastSessionCounter') || 0;
  if (sessionCounter <= last) {
    await player.save(null, MASTER);
    await logRejection(user, 'COUNTER_NOT_MONOTONIC', level, score, sessionCounter);
    fail('COUNTER_NOT_MONOTONIC', 'sessionCounter must be greater than ' + last, { lastSessionCounter: last });
  }
  player.set('lastSessionCounter', sessionCounter); // consumed even if the ceiling check fails below

  // Ceiling.
  const ceiling = config.ceilingForLevel(level);
  if (score > ceiling) {
    await player.save(null, MASTER);
    await logRejection(user, 'CEILING_EXCEEDED', level, score, sessionCounter);
    fail('CEILING_EXCEEDED', 'score exceeds the ceiling for level ' + level, { ceiling: ceiling });
  }

  // Accept: history row.
  const week = config.weekKey(now);
  const playerName = player.get('displayName');
  const scoreRow = new Parse.Object('Score');
  scoreRow.set('player', user);
  scoreRow.set('playerName', playerName);
  scoreRow.set('level', level);
  scoreRow.set('score', score);
  scoreRow.set('week', week);
  scoreRow.set('sessionCounter', sessionCounter);
  scoreRow.set('clientNonce', clientNonce);
  scoreRow.setACL(ownerReadAcl(user));
  await scoreRow.save(null, MASTER);

  // Upsert Best (one row per player+level). `score` is the all-time best; `week`/`weekScore` the best of the
  // most recent week the player submitted in. A new week overwrites them: that is the implicit weekly reset.
  let best = await findBest(user, level);
  let improvedAllTime = false;
  let improvedWeekly = false;
  if (!best) {
    best = new Parse.Object('Best');
    best.set('player', user);
    best.set('level', level);
    best.set('score', score);
    best.set('week', week);
    best.set('weekScore', score);
    best.setACL(publicReadAcl());
    improvedAllTime = true;
    improvedWeekly = true;
  } else {
    if (score > (best.get('score') || 0)) {
      best.set('score', score);
      improvedAllTime = true;
    }
    if (best.get('week') !== week) {
      best.set('week', week);
      best.set('weekScore', score);
      improvedWeekly = true;
    } else if (score > (best.get('weekScore') || 0)) {
      best.set('weekScore', score);
      improvedWeekly = true;
    }
  }
  best.set('playerName', playerName);
  await best.save(null, MASTER);
  await player.save(null, MASTER);

  return {
    accepted: true,
    replay: false,
    scoreId: scoreRow.id,
    level: level,
    score: score,
    week: week,
    improvedAllTime: improvedAllTime,
    improvedWeekly: improvedWeekly,
    best: bestJson(best),
    rateLimit: { used: count, max: config.RATE_LIMIT.max, windowMs: config.RATE_LIMIT.windowMs },
  };
});

// leaderboard({level, scope?: 'alltime'|'weekly', week?, limit?}) → top-N. No sign-in needed: scores are public.
// Order: score desc, then Best.createdAt asc (the player who has been on this level's board longest is listed
// first among equals). Equal scores share a rank (1, 2, 2, 4 …), consistent with myRank.
Parse.Cloud.define('leaderboard', async (request) => {
  const p = request.params || {};
  const level = requireLevel(p.level);
  const scope = requireScope(p.scope);
  const week = resolveWeek(scope, p.week);
  const limit = p.limit === undefined ? config.DEFAULT_LEADERBOARD_LIMIT : p.limit;
  if (!isInt(limit) || limit < 1 || limit > config.MAX_LEADERBOARD_LIMIT) {
    fail('INVALID_ARGS', 'limit must be an integer in 1..' + config.MAX_LEADERBOARD_LIMIT, { field: 'limit' });
  }
  const field = scope === 'weekly' ? 'weekScore' : 'score';

  const q = new Parse.Query('Best');
  q.equalTo('level', level);
  if (scope === 'weekly') q.equalTo('week', week);
  q.descending(field);
  q.addAscending('createdAt');
  q.limit(limit);
  q.select('player', 'playerName', 'level', 'score', 'week', 'weekScore');
  const rows = await q.find(MASTER);

  const entries = [];
  let rank = 0;
  let prevScore = null;
  rows.forEach((row, i) => {
    const s = row.get(field);
    if (s !== prevScore) {
      rank = i + 1;
      prevScore = s;
    }
    entries.push({
      rank: rank,
      playerId: row.get('player').id,
      playerName: row.get('playerName'),
      score: s,
      since: iso(row.createdAt),
    });
  });
  return { level: level, scope: scope, week: week, limit: limit, entries: entries };
});

// myRank({level, scope?, week?}) → { rank, score, … } for the caller. rank = 1 + number of Best rows with a
// strictly greater score, so equal scores share a rank. rank is null when the player has no score in scope.
Parse.Cloud.define('myRank', async (request) => {
  const user = requireUser(request);
  const p = request.params || {};
  const level = requireLevel(p.level);
  const scope = requireScope(p.scope);
  const week = resolveWeek(scope, p.week);
  const field = scope === 'weekly' ? 'weekScore' : 'score';

  const mine = await findBest(user, level);
  const inScope = mine && (scope === 'alltime' || mine.get('week') === week);
  if (!inScope) return { level: level, scope: scope, week: week, rank: null, score: null, best: bestJson(mine) };

  const myScore = mine.get(field);
  const q = new Parse.Query('Best');
  q.equalTo('level', level);
  if (scope === 'weekly') q.equalTo('week', week);
  q.greaterThan(field, myScore);
  const above = await q.count(MASTER);
  return { level: level, scope: scope, week: week, rank: above + 1, score: myScore, best: bestJson(mine) };
});

// ---------------------------------------------------------------------------------------------------------
// 3. Cloud saves
// ---------------------------------------------------------------------------------------------------------

function requireSlot(slot) {
  if (!isInt(slot) || slot < 0 || slot >= config.SLOTS) {
    fail('INVALID_SLOT', 'slot must be an integer in 0..' + (config.SLOTS - 1), { field: 'slot', slots: config.SLOTS });
  }
  return slot;
}

async function findSave(user, slot) {
  const q = new Parse.Query('Save');
  q.equalTo('player', user);
  q.equalTo('slot', slot);
  return q.first(MASTER);
}

// putSave({slot, baseVersion, blob}) → {slot, version}. Optimistic concurrency: baseVersion must equal the
// stored version (0 when the slot is empty); otherwise STALE_SAVE with currentVersion so the client can reload
// and merge. Two writers racing with the same baseVersion can both pass (no compare-and-set in Parse) — see
// README "Guarantees and limits".
Parse.Cloud.define('putSave', async (request) => {
  const user = requireUser(request);
  const p = request.params || {};
  const slot = requireSlot(p.slot);
  const baseVersion = p.baseVersion;
  const blob = p.blob;
  if (!isInt(baseVersion) || baseVersion < 0) fail('INVALID_ARGS', 'baseVersion must be a non-negative integer (0 for an empty slot)', { field: 'baseVersion' });
  if (typeof blob !== 'string') fail('INVALID_ARGS', 'blob must be a JSON string', { field: 'blob' });
  const bytes = Buffer.byteLength(blob, 'utf8');
  if (bytes > config.MAX_BLOB_BYTES) fail('BLOB_TOO_LARGE', 'blob exceeds ' + config.MAX_BLOB_BYTES + ' bytes', { bytes: bytes, max: config.MAX_BLOB_BYTES });
  try {
    JSON.parse(blob);
  } catch (e) {
    fail('INVALID_ARGS', 'blob must be valid JSON', { field: 'blob' });
  }

  const existing = await findSave(user, slot);
  const current = existing ? existing.get('version') || 0 : 0;
  if (baseVersion !== current) {
    fail('STALE_SAVE', 'The slot has version ' + current + '; reload it before saving.', { currentVersion: current, slot: slot });
  }

  const save = existing || new Parse.Object('Save');
  if (!existing) {
    save.set('player', user);
    save.set('slot', slot);
    save.setACL(ownerReadAcl(user));
  }
  save.set('version', current + 1);
  save.set('blob', blob);
  save.set('bytes', bytes);
  await save.save(null, MASTER);
  return { slot: slot, version: current + 1, bytes: bytes, updatedAt: iso(save.updatedAt) };
});

// getSave({slot}) → {slot, version, blob|null}. version 0 and blob null for an empty slot.
Parse.Cloud.define('getSave', async (request) => {
  const user = requireUser(request);
  const p = request.params || {};
  const slot = requireSlot(p.slot);
  const save = await findSave(user, slot);
  if (!save) return { slot: slot, version: 0, blob: null, bytes: 0, updatedAt: null };
  return { slot: slot, version: save.get('version'), blob: save.get('blob'), bytes: save.get('bytes') || 0, updatedAt: iso(save.updatedAt) };
});

// ---------------------------------------------------------------------------------------------------------
// 4. Security: nothing in the client writes these classes directly
// ---------------------------------------------------------------------------------------------------------

['Player', 'Score', 'Best', 'Save', 'RejectedScore'].forEach((className) => {
  const deny = (action) => (request) => {
    if (!request.master) {
      throw new PE(PE.OPERATION_FORBIDDEN, JSON.stringify({
        code: 'CLOUD_CODE_ONLY',
        message: className + ' rows are ' + action + ' by Cloud Code only.',
      }));
    }
  };
  Parse.Cloud.beforeSave(className, deny('written'));
  Parse.Cloud.beforeDelete(className, deny('deleted'));
});
