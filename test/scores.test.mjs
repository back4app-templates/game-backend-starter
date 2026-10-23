// Scores and leaderboards: ceiling, counter monotonicity, rate limit, replay, ties and rank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guest, call, nonce, submitMany, master, userPointer, config, api } from './helpers.mjs';

test('submitScore rejects a score above the level ceiling and logs it', async () => {
  const u = await guest();
  const ceiling = config.ceilingForLevel(2);
  const r = await call('submitScore', { level: 2, score: ceiling + 1, sessionCounter: 1, clientNonce: nonce() }, u.session);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CEILING_EXCEEDED');
  assert.equal(r.error.ceiling, ceiling);
  const rejected = await master.find('RejectedScore', { player: userPointer(u.id) });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'CEILING_EXCEEDED');
  assert.equal(rejected[0].level, 2);
  assert.equal(rejected[0].score, ceiling + 1);
  assert.equal(await master.count('Score', { player: userPointer(u.id) }), 0, 'no Score row for a rejection');

  const ok = await call('submitScore', { level: 2, score: ceiling, sessionCounter: 2, clientNonce: nonce() }, u.session);
  assert.ok(ok.ok, 'a score equal to the ceiling is accepted: ' + JSON.stringify(ok));
});

test('sessionCounter must be strictly increasing per player (consumed even when the score is rejected)', async () => {
  const u = await guest();
  const a = await call('submitScore', { level: 1, score: 10, sessionCounter: 5, clientNonce: nonce() }, u.session);
  assert.ok(a.ok);
  for (const c of [5, 4, 1]) {
    const r = await call('submitScore', { level: 1, score: 10, sessionCounter: c, clientNonce: nonce() }, u.session);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'COUNTER_NOT_MONOTONIC');
    assert.equal(r.error.lastSessionCounter, 5);
  }
  const b = await call('submitScore', { level: 1, score: 10, sessionCounter: 6, clientNonce: nonce() }, u.session);
  assert.ok(b.ok);
  // A ceiling rejection still consumes its counter.
  const rejected = await call('submitScore', { level: 1, score: 10 ** 9, sessionCounter: 7, clientNonce: nonce() }, u.session);
  assert.equal(rejected.error.code, 'CEILING_EXCEEDED');
  const reuse = await call('submitScore', { level: 1, score: 10, sessionCounter: 7, clientNonce: nonce() }, u.session);
  assert.equal(reuse.error.code, 'COUNTER_NOT_MONOTONIC');
  assert.equal(reuse.error.lastSessionCounter, 7);
  const rejectedRows = await master.find('RejectedScore', { player: userPointer(u.id) });
  assert.equal(rejectedRows.filter((r) => r.reason === 'COUNTER_NOT_MONOTONIC').length, 4);
});

test('rate limit: the 11th submission inside 60 s is rejected, the window expires', async () => {
  const u = await guest();
  const results = await submitMany(u, { level: 1, n: config.RATE_LIMIT.max });
  assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)));
  assert.equal(results.at(-1).result.rateLimit.used, config.RATE_LIMIT.max);
  const eleventh = await call('submitScore', { level: 1, score: 1, sessionCounter: 99, clientNonce: nonce() }, u.session);
  assert.equal(eleventh.ok, false);
  assert.equal(eleventh.error.code, 'RATE_LIMITED');
  assert.ok(eleventh.error.retryAfterMs > 0 && eleventh.error.retryAfterMs <= config.RATE_LIMIT.windowMs);
  assert.equal((await master.find('RejectedScore', { player: userPointer(u.id), reason: 'RATE_LIMITED' })).length, 1);

  // Simulate the window expiring instead of sleeping 60 s: move the window start back (master key, test only).
  const [player] = await master.find('Player', { user: userPointer(u.id) });
  await master.update('Player', player.objectId, { submitWindowStart: { __type: 'Date', iso: new Date(Date.now() - config.RATE_LIMIT.windowMs - 1000).toISOString() } });
  const afterWindow = await call('submitScore', { level: 1, score: 1, sessionCounter: 100, clientNonce: nonce() }, u.session);
  assert.ok(afterWindow.ok, JSON.stringify(afterWindow));
  assert.equal(afterWindow.result.rateLimit.used, 1);
});

test('replay with the same clientNonce is counted once and returns the original result', async () => {
  const u = await guest();
  const n = nonce();
  const params = { level: 1, score: 777, sessionCounter: 1, clientNonce: n };
  const first = await call('submitScore', params, u.session);
  assert.ok(first.ok);
  assert.equal(first.result.replay, false);
  const second = await call('submitScore', params, u.session);
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.result.replay, true);
  assert.equal(second.result.scoreId, first.result.scoreId);
  assert.equal(await master.count('Score', { player: userPointer(u.id) }), 1);
  // The replay did not consume rate-limit budget or the counter.
  const next = await call('submitScore', { level: 1, score: 1, sessionCounter: 2, clientNonce: nonce() }, u.session);
  assert.ok(next.ok);
  assert.equal(next.result.rateLimit.used, 2);
  // A nonce reused by a different player is a different submission.
  const other = await guest();
  const otherSubmit = await call('submitScore', { ...params }, other.session);
  assert.ok(otherSubmit.ok);
  assert.equal(otherSubmit.result.replay, false);
});

test('Best keeps the all-time best and the weekly best; weekly board uses the current week key', async () => {
  const u = await guest();
  const week = config.weekKey(new Date());
  const r1 = await call('submitScore', { level: 3, score: 500, sessionCounter: 1, clientNonce: nonce() }, u.session);
  const r2 = await call('submitScore', { level: 3, score: 300, sessionCounter: 2, clientNonce: nonce() }, u.session);
  const r3 = await call('submitScore', { level: 3, score: 900, sessionCounter: 3, clientNonce: nonce() }, u.session);
  assert.deepEqual([r1.result.improvedAllTime, r2.result.improvedAllTime, r3.result.improvedAllTime], [true, false, true]);
  assert.equal(r3.result.best.score, 900);
  assert.equal(r3.result.best.weekScore, 900);
  assert.equal(r3.result.best.week, week);
  assert.equal(await master.count('Best', { player: userPointer(u.id), level: 3 }), 1, 'one Best row per player+level');
  assert.equal(await master.count('Score', { player: userPointer(u.id), level: 3 }), 3, 'Score keeps every submission');

  // Pretend the row was last touched last week: the weekly board forgets it, the all-time board keeps it.
  const [best] = await master.find('Best', { player: userPointer(u.id), level: 3 });
  await master.update('Best', best.objectId, { week: '2020-W01', weekScore: 900 });
  const weekly = await call('myRank', { level: 3, scope: 'weekly' }, u.session);
  assert.equal(weekly.result.rank, null);
  const alltime = await call('myRank', { level: 3, scope: 'alltime' }, u.session);
  assert.equal(typeof alltime.result.rank, 'number');
  const r4 = await call('submitScore', { level: 3, score: 100, sessionCounter: 4, clientNonce: nonce() }, u.session);
  assert.equal(r4.result.best.score, 900, 'all-time unchanged');
  assert.equal(r4.result.best.weekScore, 100, 'weekly reset by the new week key');
  assert.equal(r4.result.best.week, week);
  const weeklyNow = await call('myRank', { level: 3, scope: 'weekly' }, u.session);
  assert.equal(weeklyNow.result.score, 100);

  const badWeek = await call('leaderboard', { level: 3, scope: 'weekly', week: '2026-13' }, u.session);
  assert.equal(badWeek.error.code, 'INVALID_ARGS');
});

test('ties share a rank: leaderboard and myRank agree with a brute-force ranking of 500 seeded Best rows', async () => {
  const LEVEL = 77; // dedicated level, reset before the test
  await master.purge('Best', { level: LEVEL });

  // 500 rows: players are real _Users; 50 distinct scores × 10 players each, so the top-100 spans ten tie groups;
  // written with the master key straight into Best (the hooks allow master writes), as scripts/seed.mjs does.
  const scores = Array.from({ length: 500 }, (_, i) => 1000 + (i % 50) * 10);
  const users = [];
  for (let i = 0; i < 500; i += 50) {
    const r = await api.batch(Array.from({ length: 50 }, (_, j) => ({ method: 'POST', path: '/users', body: { authData: { anonymous: { id: `tie-${Date.now()}-${i + j}-${Math.random().toString(36).slice(2)}` } } } })), { master: true });
    assert.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    for (const item of r.json) { assert.ok(item.success, JSON.stringify(item)); users.push(item.success.objectId); }
  }
  for (let i = 0; i < 500; i += 50) {
    const r = await api.batch(users.slice(i, i + 50).map((id, j) => ({
      method: 'POST', path: '/classes/Best',
      body: { player: userPointer(id), playerName: `tie-${i + j}`, level: LEVEL, score: scores[i + j], week: config.weekKey(new Date()), weekScore: scores[i + j], ACL: { '*': { read: true } } },
    })), { master: true });
    assert.equal(r.status, 200);
    for (const item of r.json) assert.ok(item.success, JSON.stringify(item));
  }

  // Brute force: rank = 1 + number of strictly greater scores.
  const expectedRank = (s) => 1 + scores.filter((x) => x > s).length;

  const top = await call('leaderboard', { level: LEVEL, scope: 'alltime', limit: 100 });
  assert.ok(top.ok, JSON.stringify(top));
  assert.equal(top.result.entries.length, 100);
  for (let i = 0; i < top.result.entries.length; i++) {
    const e = top.result.entries[i];
    assert.equal(e.rank, expectedRank(e.score), `entry ${i} rank`);
    if (i > 0) {
      const prev = top.result.entries[i - 1];
      assert.ok(prev.score > e.score || (prev.score === e.score && new Date(prev.since) <= new Date(e.since)), 'ordered by score desc, createdAt asc');
    }
  }
  assert.deepEqual(top.result.entries.slice(0, 11).map((e) => e.rank), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 11]);
  assert.equal(top.result.entries[99].rank, 91);
  assert.equal(top.result.entries[99].score, 1400);

  // myRank for a handful of the seeded players: log in with their anonymous id is not available here, so
  // sign in a fresh player, give it each distinct score in turn and compare (the fresh player adds one more
  // row to the set, which the brute force accounts for).
  const me = await guest();
  let counter = 0;
  for (const s of [1500, 1490, 1485, 1250, 1000, 5]) {
    await master.purge('Best', { level: LEVEL, player: userPointer(me.id) });
    const sub = await call('submitScore', { level: LEVEL, score: s, sessionCounter: ++counter, clientNonce: `rank-${counter}-${Date.now()}` }, me.session);
    assert.ok(sub.ok, JSON.stringify(sub));
    const r = await call('myRank', { level: LEVEL, scope: 'alltime' }, me.session);
    assert.equal(r.result.rank, expectedRank(s), `myRank for score ${s}`);
    const w = await call('myRank', { level: LEVEL, scope: 'weekly' }, me.session);
    assert.equal(w.result.rank, expectedRank(s), `weekly myRank for score ${s}`);
  }
  const total = await master.count('Best', { level: LEVEL });
  assert.equal(total, 501);
});
