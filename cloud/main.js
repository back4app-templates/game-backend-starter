// File: cloud/main.js · CommonJS · Parse Server 7.x (Back4app runs Cloud Code on Node 19: no Node 20+ only features)
//
// Everything that writes to Player, Score, Best, Save or RejectedScore goes through the functions below,
// which run with the master key. The beforeSave/beforeDelete hooks at the bottom reject every non-master
// write, and the class-level permissions (section 4, also scripts/setup.mjs) close create/update/delete to
// clients. Section 4 also holds the setup helpers (setupSchema, seedBest, testReset, testInspect, testPatch):
// unauthenticated functions, gated by config.SETUP_ENABLED, for a fresh app whose master key is not available
// to the scripts. Set SETUP_ENABLED = false in config.js and redeploy before the game goes public.
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
  q.select('player', 'playerName', 'level', 'score', 'week', 'weekScore', 'seeded');
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
    const player = row.get('player'); // null on rows created by seedBest (synthetic benchmark data)
    entries.push({
      rank: rank,
      playerId: player ? player.id : null,
      playerName: row.get('playerName'),
      score: s,
      since: iso(row.createdAt),
      seeded: !!row.get('seeded'),
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
  // Measured on Back4app (MongoDB 3.6, 1,000,000 Best rows, 2026-10-23): without a hint the planner ran this count
  // in ~3 s whatever the selectivity (298 or 300,000 matching rows), with the hint it is an index range again
  // (~0.5-1 s of database time at 300,000 rows). The PostgreSQL adapter ignores hints, so local runs are unaffected.
  q.hint(scope === 'weekly' ? 'best_weekly' : 'best_alltime');
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
// 4. Setup helpers: schema, synthetic seed, test access — all behind config.SETUP_ENABLED
// ---------------------------------------------------------------------------------------------------------
// Why they exist: on Back4app the master key lives in the dashboard; an agent or a CI job that only has the
// REST key cannot create classes, cannot seed Best rows (writes are Cloud-Code-only) and cannot inspect the
// master-only state the tests assert on. Cloud Code runs with master rights, so these functions do it on the
// caller's behalf. Nothing authenticates the caller: that is what SETUP_ENABLED is for. Flip it to false,
// upload config.js again, Deploy, and verify with a call (expect SETUP_DISABLED) before players arrive.

function requireSetupEnabled() {
  if (!config.SETUP_ENABLED) {
    fail('SETUP_DISABLED', 'Setup helpers are disabled (cloud/config.js SETUP_ENABLED = false).', null, PE.OPERATION_FORBIDDEN);
  }
}

const SETUP_CLASSES = config.SCHEMA.map((def) => def.className);

function requireSetupClass(className) {
  if (SETUP_CLASSES.indexOf(className) === -1) {
    fail('INVALID_ARGS', 'className must be one of ' + SETUP_CLASSES.join(', '), { field: 'className' });
  }
  return className;
}

function requireWhere(where) {
  if (!where || typeof where !== 'object' || Array.isArray(where) || !Object.keys(where).length) {
    fail('INVALID_ARGS', 'where must be a non-empty object of field → value equalities', { field: 'where' });
  }
  return where;
}

// A Parse.Query from a `where` object of field → value equalities (values REST-encoded: a pointer is
// {__type:'Pointer', className, objectId}, a date {__type:'Date', iso}). Operators ($gt, $in, …) are not
// accepted: the suite only needs equality, and decoding the values here keeps the Postgres adapter happy.
function queryFromWhere(className, where) {
  const q = new Parse.Query(className);
  Object.keys(where).forEach((key) => {
    const value = decodeParam(where[key]);
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Parse.Object) && !(value instanceof Date)) {
      fail('INVALID_ARGS', 'where.' + key + ' must be a plain value or a REST-encoded pointer/date (no operators)', { field: 'where.' + key });
    }
    q.equalTo(key, value);
  });
  return q;
}

// Parse Server may hand Cloud functions their params already decoded (pointers as Parse.Object when
// encodeParseObjectInCloudFunction is on, as on the local server) or raw (REST JSON, as on Back4app).
function decodeParam(value) {
  if (value instanceof Parse.Object || value instanceof Date) return value;
  return Parse._decode(null, value);
}

async function fetchSchema(className) {
  try {
    return await new Parse.Schema(className).get();
  } catch (e) {
    if (e && e.code === PE.INVALID_CLASS_NAME) return null; // 103: class does not exist
    throw e;
  }
}

function addFieldsTo(schema, fields) {
  Object.keys(fields).forEach((name) => {
    const spec = fields[name];
    if (spec.type === 'Pointer') schema.addPointer(name, spec.targetClass);
    else schema.addField(name, spec.type);
  });
}

// setupSchema({allowRerun?}) → {classes: [{className, action, newFields, newIndexes}], bestCount}
//   Creates the five classes with fields, class-level permissions and indexes, or brings existing ones up to
//   date: missing fields and missing indexes are added, CLPs are always re-applied, nothing is removed.
//   Idempotent. Parse.Schema indexes are plain (non-unique), as in scripts/setup.mjs.
//   Tripwire: refuses once Best holds 2 or more rows unless params.allowRerun === true, so a stray call on an
//   app that already has data is noisy rather than silent. It is not a security boundary: SETUP_ENABLED is.
Parse.Cloud.define('setupSchema', async (request) => {
  requireSetupEnabled();
  const p = request.params || {};
  const bestCount = (await fetchSchema('Best')) ? await new Parse.Query('Best').count(MASTER) : 0;
  if (bestCount >= 2 && p.allowRerun !== true) {
    fail('SETUP_LOCKED', 'Best already holds ' + bestCount + ' rows; pass {allowRerun: true} to re-apply the schema.', { bestCount: bestCount });
  }

  const classes = [];
  for (const def of config.SCHEMA) {
    const have = await fetchSchema(def.className);
    const schema = new Parse.Schema(def.className);
    schema.setCLP(def.classLevelPermissions);
    if (!have) {
      addFieldsTo(schema, def.fields);
      Object.keys(def.indexes || {}).forEach((name) => schema.addIndex(name, def.indexes[name]));
      await schema.save();
      classes.push({ className: def.className, action: 'created', newFields: Object.keys(def.fields), newIndexes: Object.keys(def.indexes || {}) });
      continue;
    }
    const newFields = {};
    Object.keys(def.fields).forEach((name) => { if (!have.fields || !have.fields[name]) newFields[name] = def.fields[name]; });
    const haveIdx = have.indexes || {};
    const newIndexes = Object.keys(def.indexes || {}).filter((name) => !haveIdx[name]);
    addFieldsTo(schema, newFields);
    newIndexes.forEach((name) => schema.addIndex(name, def.indexes[name]));
    await schema.update();
    classes.push({ className: def.className, action: 'updated', newFields: Object.keys(newFields), newIndexes: newIndexes });
  }

  // What the server believes it has now (Back4app: compare with Dashboard → Database → Indexes).
  const indexes = {};
  for (const def of config.SCHEMA) {
    const now = await fetchSchema(def.className);
    indexes[def.className] = (now && now.indexes) || {};
  }
  return { classes: classes, indexes: indexes, bestCount: bestCount };
});

// seedBest({rows}) → {created, skipped}
//   rows: up to SEED_BATCH_MAX objects {playerName, level, score, week, weekScore, seedKey?}. Creates one public
//   Best row each with player = null and seeded = true: synthetic leaderboard data for the benchmark, no
//   _User and no _Session per row. Rows whose seedKey already exists are skipped (re-runs are idempotent).
//   Budget: 1,000,000 rows / 50 per call = 20,000 requests (≈ 21 min at 16 req/s).
Parse.Cloud.define('seedBest', async (request) => {
  requireSetupEnabled();
  const p = request.params || {};
  const rows = p.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > config.SEED_BATCH_MAX) {
    fail('INVALID_ARGS', 'rows must be an array of 1..' + config.SEED_BATCH_MAX + ' objects', { field: 'rows', max: config.SEED_BATCH_MAX });
  }
  const seedKeys = [];
  rows.forEach((row, i) => {
    const at = 'rows[' + i + ']';
    if (!row || typeof row !== 'object') fail('INVALID_ARGS', at + ' must be an object', { field: at });
    if (typeof row.playerName !== 'string' || !row.playerName.length || row.playerName.length > 64) fail('INVALID_ARGS', at + '.playerName must be a string of 1..64 characters', { field: at + '.playerName' });
    requireLevel(row.level);
    const ceiling = config.ceilingForLevel(row.level);
    if (!isInt(row.score) || row.score < 0 || row.score > ceiling) fail('INVALID_ARGS', at + '.score must be an integer in 0..' + ceiling, { field: at + '.score' });
    if (typeof row.week !== 'string' || !config.WEEK_KEY_RE.test(row.week)) fail('INVALID_ARGS', at + '.week must look like 2026-W43', { field: at + '.week' });
    if (!isInt(row.weekScore) || row.weekScore < 0 || row.weekScore > row.score) fail('INVALID_ARGS', at + '.weekScore must be an integer in 0..score', { field: at + '.weekScore' });
    if (row.seedKey !== undefined) {
      if (typeof row.seedKey !== 'string' || !row.seedKey.length || row.seedKey.length > 128) fail('INVALID_ARGS', at + '.seedKey must be a string of 1..128 characters', { field: at + '.seedKey' });
      seedKeys.push(row.seedKey);
    }
  });

  let existing = {};
  if (seedKeys.length) {
    const q = new Parse.Query('Best');
    q.containedIn('seedKey', seedKeys);
    q.select('seedKey');
    q.limit(seedKeys.length);
    (await q.find(MASTER)).forEach((b) => { existing[b.get('seedKey')] = true; });
  }

  const objects = [];
  let skipped = 0;
  rows.forEach((row) => {
    if (row.seedKey !== undefined && existing[row.seedKey]) { skipped++; return; }
    const best = new Parse.Object('Best');
    best.set('playerName', row.playerName);
    best.set('level', row.level);
    best.set('score', row.score);
    best.set('week', row.week);
    best.set('weekScore', row.weekScore);
    best.set('seeded', true);
    if (row.seedKey !== undefined) best.set('seedKey', row.seedKey);
    best.setACL(publicReadAcl());
    objects.push(best);
  });
  if (objects.length) await Parse.Object.saveAll(objects, MASTER);
  return { created: objects.length, skipped: skipped };
});

// testReset({className, where}) → {deleted}. Deletes every row of one of the five classes matching `where`
// (field → value equalities, must be non-empty). The suite uses it to clear a level before seeding it.
Parse.Cloud.define('testReset', async (request) => {
  requireSetupEnabled();
  const p = request.params || {};
  const className = requireSetupClass(p.className);
  const where = requireWhere(p.where);
  let deleted = 0;
  for (;;) {
    const q = queryFromWhere(className, where);
    q.select('objectId');
    q.limit(1000);
    const rows = await q.find(MASTER);
    if (!rows.length) break;
    await Parse.Object.destroyAll(rows, MASTER);
    deleted += rows.length;
  }
  return { className: className, deleted: deleted };
});

// testInspect({className, where, limit?, count?}) → {results} or {count}. Reads rows of one of the five
// classes with master rights (RejectedScore, other players' Player/Save, hidden Player counters). Rows come
// back as plain JSON (toJSON), Dates as {__type:'Date', iso}.
Parse.Cloud.define('testInspect', async (request) => {
  requireSetupEnabled();
  const p = request.params || {};
  const className = requireSetupClass(p.className);
  const where = p.where === undefined ? {} : p.where;
  if (!where || typeof where !== 'object' || Array.isArray(where)) fail('INVALID_ARGS', 'where must be an object', { field: 'where' });
  const q = queryFromWhere(className, where);
  if (p.count === true) return { className: className, count: await q.count(MASTER) };
  const limit = p.limit === undefined ? 100 : p.limit;
  if (!isInt(limit) || limit < 1 || limit > 1000) fail('INVALID_ARGS', 'limit must be an integer in 1..1000', { field: 'limit' });
  q.limit(limit);
  q.ascending('createdAt');
  const rows = await q.find(MASTER);
  return { className: className, results: rows.map((r) => r.toJSON()) };
});

// testPatch({className, objectId, set}) → {objectId, updatedAt}. Sets plain fields on one row with master
// rights: the suite rewinds Player.submitWindowStart to expire a rate-limit window without sleeping 60 s and
// stamps a Best row with an old week. `set` values use REST encoding ({__type:'Date', iso} for dates).
Parse.Cloud.define('testPatch', async (request) => {
  requireSetupEnabled();
  const p = request.params || {};
  const className = requireSetupClass(p.className);
  if (typeof p.objectId !== 'string' || !p.objectId.length) fail('INVALID_ARGS', 'objectId must be a string', { field: 'objectId' });
  if (!p.set || typeof p.set !== 'object' || Array.isArray(p.set) || !Object.keys(p.set).length) fail('INVALID_ARGS', 'set must be a non-empty object', { field: 'set' });
  const forbidden = ['objectId', 'createdAt', 'updatedAt', 'ACL'];
  Object.keys(p.set).forEach((k) => { if (forbidden.indexOf(k) !== -1) fail('INVALID_ARGS', k + ' cannot be set', { field: 'set.' + k }); });
  const obj = new Parse.Object(className);
  obj.id = p.objectId;
  Object.keys(p.set).forEach((k) => obj.set(k, decodeParam(p.set[k])));
  await obj.save(null, MASTER);
  return { className: className, objectId: obj.id, updatedAt: iso(obj.updatedAt) };
});

// ---------------------------------------------------------------------------------------------------------
// 5. Security: nothing in the client writes these classes directly
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
