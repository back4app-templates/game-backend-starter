// Player accounts: anonymous → upgrade keeps the same _User and therefore Player, Best and Save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guest, upgrade, login, call, nonce, uniqueName, master, userPointer } from './helpers.mjs';

test('ensurePlayer creates the profile once and updates optional fields', async () => {
  const u = await guest();
  const first = await call('ensurePlayer', {}, u.session);
  assert.ok(first.ok, JSON.stringify(first));
  assert.equal(first.result.created, true);
  assert.equal(first.result.userId, u.id);
  assert.match(first.result.displayName, /^Guest-/);

  const second = await call('ensurePlayer', { displayName: '  Ada   Lovelace ', country: 'gb' }, u.session);
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.result.created, false);
  assert.equal(second.result.id, first.result.id);
  assert.equal(second.result.displayName, 'Ada Lovelace');
  assert.equal(second.result.country, 'GB');

  const bad = await call('ensurePlayer', { displayName: 'x' }, u.session);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'INVALID_ARGS');

  assert.equal(await master.count('Player', { user: userPointer(u.id) }), 1);
});

test('anonymous guest upgrades to username/password and keeps Player, Best and Save', async () => {
  const u = await guest();
  const player = await call('ensurePlayer', { displayName: 'Keeper' }, u.session);
  assert.ok(player.ok, JSON.stringify(player));
  const submit = await call('submitScore', { level: 1, score: 4200, sessionCounter: 1, clientNonce: nonce() }, u.session);
  assert.ok(submit.ok, JSON.stringify(submit));
  const save = await call('putSave', { slot: 0, baseVersion: 0, blob: JSON.stringify({ hp: 3 }) }, u.session);
  assert.ok(save.ok, JSON.stringify(save));

  const username = uniqueName('upgraded');
  const password = 'correct horse battery staple ' + username;
  const up = await upgrade(u, username, password);
  assert.equal(up.status, 200, JSON.stringify(up.json));

  const logged = await login(username, password);
  assert.equal(logged.status, 200, JSON.stringify(logged.json));
  assert.equal(logged.json.objectId, u.id, 'same _User after the upgrade');
  assert.equal(logged.json.authData?.anonymous ?? null, null, 'anonymous authData is gone');
  const session = logged.json.sessionToken;

  const again = await call('ensurePlayer', {}, session);
  assert.ok(again.ok);
  assert.equal(again.result.id, player.result.id, 'same Player row');
  assert.equal(again.result.displayName, 'Keeper');
  assert.equal(again.result.lastSessionCounter, 1);

  const rank = await call('myRank', { level: 1 }, session);
  assert.ok(rank.ok);
  assert.equal(rank.result.best.score, 4200, 'Best row still attached');

  const loaded = await call('getSave', { slot: 0 }, session);
  assert.ok(loaded.ok);
  assert.equal(loaded.result.version, 1);
  assert.deepEqual(JSON.parse(loaded.result.blob), { hp: 3 });

  const dupUsername = await upgrade(await guest(), username, 'another password 12345');
  assert.equal(dupUsername.status, 400);
  assert.equal(dupUsername.json.code, 202, 'username taken is reported, not silently merged');
});
