// Setup helpers (cloud/main.js section 4): unauthenticated, gated by config.SETUP_ENABLED, used when the master
// key is not available to the scripts. These tests assume SETUP_ENABLED = true (the default for a fresh app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, call, guest, nonce, master, userPointer, config, seedBest } from './helpers.mjs';
import { CLASSES } from '../scripts/lib/schema.mjs';

test('setupSchema is idempotent and refuses a bare re-run once Best has rows', async () => {
  await seedBest([{ playerName: 'lock-a', level: 90, score: 1, week: '2020-W01', weekScore: 1 }, { playerName: 'lock-b', level: 90, score: 2, week: '2020-W01', weekScore: 2 }]);
  const locked = await call('setupSchema', {});
  assert.equal(locked.ok, false);
  assert.equal(locked.error.code, 'SETUP_LOCKED');
  assert.ok(locked.error.bestCount >= 2);

  const rerun = await call('setupSchema', { allowRerun: true });
  assert.ok(rerun.ok, JSON.stringify(rerun.error));
  assert.deepEqual(rerun.result.classes.map((c) => c.className), CLASSES.map((c) => c.className));
  for (const c of rerun.result.classes) {
    assert.equal(c.action, 'updated', c.className);
    assert.deepEqual(c.newFields, [], `${c.className}: schema already applied by npm test`);
    assert.deepEqual(c.newIndexes, [], `${c.className}: indexes already present`);
  }
  for (const def of CLASSES) {
    for (const name of Object.keys(def.indexes)) assert.ok(rerun.result.indexes[def.className][name], `${def.className}.${name} reported`);
  }
  await master.purge('Best', { level: 90 });
});

test('seedBest validates rows, caps the batch at 50 and skips rows whose seedKey exists', async () => {
  const week = config.weekKey(new Date());
  const tooMany = await call('seedBest', { rows: Array.from({ length: config.SEED_BATCH_MAX + 1 }, (_, i) => ({ playerName: `x${i}`, level: 91, score: 1, week, weekScore: 1 })) });
  assert.equal(tooMany.error.code, 'INVALID_ARGS');
  for (const bad of [
    { playerName: '', level: 91, score: 1, week, weekScore: 1 },
    { playerName: 'p', level: 0, score: 1, week, weekScore: 1 },
    { playerName: 'p', level: 91, score: config.ceilingForLevel(91) + 1, week, weekScore: 1 },
    { playerName: 'p', level: 91, score: 5, week: '2026-13', weekScore: 1 },
    { playerName: 'p', level: 91, score: 5, week, weekScore: 6 },
  ]) {
    const r = await call('seedBest', { rows: [bad] });
    assert.equal(r.error.code, 'INVALID_ARGS', JSON.stringify(bad));
  }
  assert.equal((await call('seedBest', { rows: [] })).error.code, 'INVALID_ARGS');

  await master.purge('Best', { level: 91 });
  const key = `test-${Date.now()}`;
  const rows = [{ playerName: 'dup', level: 91, score: 50, week, weekScore: 40, seedKey: `${key}:1` }, { playerName: 'dup2', level: 91, score: 60, week, weekScore: 60, seedKey: `${key}:2` }];
  const first = await seedBest(rows);
  assert.deepEqual(first, { created: 2, skipped: 0 });
  const again = await seedBest([...rows, { playerName: 'new', level: 91, score: 70, week, weekScore: 70 }]);
  assert.deepEqual(again, { created: 1, skipped: 2 }, 're-run creates only the row without an existing seedKey');
  assert.equal(await master.count('Best', { level: 91 }), 3);

  // Seeded rows are public, carry no player and rank like any other row.
  const top = await call('leaderboard', { level: 91, limit: 10 });
  assert.deepEqual(top.result.entries.map((e) => [e.playerName, e.score, e.playerId, e.seeded]), [['new', 70, null, true], ['dup2', 60, null, true], ['dup', 50, null, true]]);
  const pub = await api.request('GET', `/classes/Best?${new URLSearchParams({ where: JSON.stringify({ level: 91 }) })}`);
  assert.equal(pub.json.results.length, 3);
  const u = await guest();
  const sub = await call('submitScore', { level: 91, score: 55, sessionCounter: 1, clientNonce: nonce() }, u.session);
  assert.ok(sub.ok, JSON.stringify(sub));
  assert.equal((await call('myRank', { level: 91 }, u.session)).result.rank, 3);
  await master.purge('Best', { level: 91 });
});

test('testReset / testInspect / testPatch: class whitelist and non-empty where', async () => {
  for (const [fn, params] of [
    ['testReset', { className: '_User', where: { objectId: 'x' } }],
    ['testReset', { className: 'Best', where: {} }],
    ['testInspect', { className: '_Session' }],
    ['testPatch', { className: 'Player', objectId: 'x', set: {} }],
    ['testPatch', { className: 'Best', objectId: 'x', set: { ACL: {} } }],
  ]) {
    const r = await call(fn, params);
    assert.equal(r.ok, false, fn);
    assert.equal(r.error.code, 'INVALID_ARGS', `${fn} ${JSON.stringify(params)} → ${JSON.stringify(r.error)}`);
  }
  // A hidden class is readable through testInspect (the suite relies on this for RejectedScore).
  const u = await guest();
  await call('submitScore', { level: 1, score: 10 ** 9, sessionCounter: 1, clientNonce: nonce() }, u.session);
  const rows = (await call('testInspect', { className: 'RejectedScore', where: { player: userPointer(u.id) } })).result.results;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'CEILING_EXCEEDED');
});
