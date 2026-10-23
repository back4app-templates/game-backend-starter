// Raw REST security: nothing in the client can write Score/Best/Save/Player directly or read another player's data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, guest, call, nonce, master, userPointer } from './helpers.mjs';

test('direct POST /classes/Score with a session token is denied', async () => {
  const u = await guest();
  const r = await api.request('POST', '/classes/Score', { session: u.session, body: { player: userPointer(u.id), level: 1, score: 999999 } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.equal(r.json.code, 119, 'OPERATION_FORBIDDEN by the class-level permission (never reaches the hook)');
  assert.equal(await master.count('Score', { player: userPointer(u.id) }), 0);
});

test('direct PUT /classes/Best is denied even for the owner of the row', async () => {
  const u = await guest();
  const sub = await call('submitScore', { level: 1, score: 10, sessionCounter: 1, clientNonce: nonce() }, u.session);
  assert.ok(sub.ok);
  const [best] = await master.find('Best', { player: userPointer(u.id), level: 1 });
  const r = await api.request('PUT', `/classes/Best/${best.objectId}`, { session: u.session, body: { score: 999999 } });
  assert.equal(r.json.code, 119, JSON.stringify(r.json));
  const del = await api.request('DELETE', `/classes/Best/${best.objectId}`, { session: u.session });
  assert.equal(del.json.code, 119);
  const [after] = await master.find('Best', { objectId: best.objectId });
  assert.equal(after.score, 10);
  // Best is publicly readable (leaderboards), including without a session.
  const pub = await api.request('GET', `/classes/Best/${best.objectId}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.score, 10);
});

test("another player's Save is unreadable; own Save is readable but not writable", async () => {
  const a = await guest();
  const b = await guest();
  const put = await call('putSave', { slot: 0, baseVersion: 0, blob: JSON.stringify({ secret: 'a' }) }, a.session);
  assert.ok(put.ok);
  const [save] = await master.find('Save', { player: userPointer(a.id), slot: 0 });

  const asB = await api.request('GET', `/classes/Save/${save.objectId}`, { session: b.session });
  assert.equal(asB.status, 404, JSON.stringify(asB.json));
  const listAsB = await api.request('GET', `/classes/Save?where=${encodeURIComponent(JSON.stringify({ player: userPointer(a.id) }))}`, { session: b.session });
  assert.equal(listAsB.status, 200);
  assert.equal(listAsB.json.results.length, 0);
  const anon = await api.request('GET', `/classes/Save/${save.objectId}`);
  assert.equal(anon.json.code, 101, 'find/get require authentication (Parse answers 101 "object not found" to anonymous readers)');

  const asA = await api.request('GET', `/classes/Save/${save.objectId}`, { session: a.session });
  assert.equal(asA.status, 200);
  const writeAsA = await api.request('PUT', `/classes/Save/${save.objectId}`, { session: a.session, body: { version: 42 } });
  assert.equal(writeAsA.json.code, 119);
  const getAsB = await call('getSave', { slot: 0 }, b.session);
  assert.equal(getAsB.result.blob, null);
});

test("Player is readable by its owner only; counters are protected fields; writes denied", async () => {
  const a = await guest();
  const b = await guest();
  const p = await call('ensurePlayer', {}, a.session);
  const asA = await api.request('GET', `/classes/Player/${p.result.id}`, { session: a.session });
  assert.equal(asA.status, 200);
  assert.equal(asA.json.submitCount, undefined, 'protectedFields hide the rate-limit counters');
  const asB = await api.request('GET', `/classes/Player/${p.result.id}`, { session: b.session });
  assert.equal(asB.status, 404);
  const write = await api.request('PUT', `/classes/Player/${p.result.id}`, { session: a.session, body: { lastSessionCounter: 0 } });
  assert.equal(write.json.code, 119);
  const create = await api.request('POST', '/classes/Player', { session: a.session, body: { user: userPointer(a.id), displayName: 'x' } });
  assert.equal(create.json.code, 119);
});

test('unauthenticated calls to player functions are denied; leaderboard is public; RejectedScore is master-only', async () => {
  for (const [fn, params] of [['submitScore', { level: 1, score: 1, sessionCounter: 1, clientNonce: nonce() }], ['ensurePlayer', {}], ['myRank', { level: 1 }], ['putSave', { slot: 0, baseVersion: 0, blob: '{}' }], ['getSave', { slot: 0 }]]) {
    const r = await call(fn, params);
    assert.equal(r.ok, false, fn);
    assert.equal(r.status, 400, fn);
    assert.equal(r.error.parseCode, 209, fn);
    assert.equal(r.error.code, 'UNAUTHENTICATED', fn);
  }
  const lb = await call('leaderboard', { level: 1, limit: 3 });
  assert.ok(lb.ok);
  const rej = await api.request('GET', '/classes/RejectedScore', { session: (await guest()).session });
  assert.equal(rej.json.code, 119);
  const newClass = await api.request('POST', '/classes/Cheat', { session: (await guest()).session, body: { x: 1 } });
  assert.equal(newClass.json.code, 119, 'allowClientClassCreation=false: ' + JSON.stringify(newClass.json));
});

test('master key can write Score/Best (the hooks allow master writes, which is how Cloud Code works)', async () => {
  const u = await guest();
  const r = await api.request('POST', '/classes/Score', { master: true, body: { player: userPointer(u.id), level: 1, score: 1, week: '2026-W01', playerName: 'm', sessionCounter: 0, clientNonce: 'master-' + Date.now() } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await api.request('DELETE', `/classes/Score/${r.json.objectId}`, { master: true });
});
