// Cloud saves: put/get, optimistic versioning, limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guest, call, config } from './helpers.mjs';

test('putSave / getSave round trip with versions; stale baseVersion is rejected with the current version', async () => {
  const u = await guest();
  const empty = await call('getSave', { slot: 0 }, u.session);
  assert.deepEqual([empty.result.version, empty.result.blob], [0, null]);

  const v1 = await call('putSave', { slot: 0, baseVersion: 0, blob: JSON.stringify({ level: 1 }) }, u.session);
  assert.ok(v1.ok, JSON.stringify(v1));
  assert.equal(v1.result.version, 1);
  const v2 = await call('putSave', { slot: 0, baseVersion: 1, blob: JSON.stringify({ level: 2 }) }, u.session);
  assert.equal(v2.result.version, 2);

  const stale = await call('putSave', { slot: 0, baseVersion: 1, blob: JSON.stringify({ level: 99 }) }, u.session);
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_SAVE');
  assert.equal(stale.error.currentVersion, 2);

  const loaded = await call('getSave', { slot: 0 }, u.session);
  assert.equal(loaded.result.version, 2);
  assert.deepEqual(JSON.parse(loaded.result.blob), { level: 2 }, 'the stale write did not land');

  const wrongBaseOnEmpty = await call('putSave', { slot: 1, baseVersion: 3, blob: '{}' }, u.session);
  assert.equal(wrongBaseOnEmpty.error.code, 'STALE_SAVE');
  assert.equal(wrongBaseOnEmpty.error.currentVersion, 0);
});

test('putSave validates slot, JSON and size', async () => {
  const u = await guest();
  assert.equal((await call('putSave', { slot: config.SLOTS, baseVersion: 0, blob: '{}' }, u.session)).error.code, 'INVALID_SLOT');
  assert.equal((await call('putSave', { slot: -1, baseVersion: 0, blob: '{}' }, u.session)).error.code, 'INVALID_SLOT');
  assert.equal((await call('getSave', { slot: 'a' }, u.session)).error.code, 'INVALID_SLOT');
  assert.equal((await call('putSave', { slot: 0, baseVersion: 0, blob: 'not json' }, u.session)).error.code, 'INVALID_ARGS');
  assert.equal((await call('putSave', { slot: 0, baseVersion: 0, blob: { a: 1 } }, u.session)).error.code, 'INVALID_ARGS');
  const big = JSON.stringify({ pad: 'x'.repeat(config.MAX_BLOB_BYTES) });
  const tooBig = await call('putSave', { slot: 0, baseVersion: 0, blob: big }, u.session);
  assert.equal(tooBig.error.code, 'BLOB_TOO_LARGE');
  const overhead = Buffer.byteLength(JSON.stringify({ pad: '' }));
  const justFits = JSON.stringify({ pad: 'x'.repeat(config.MAX_BLOB_BYTES - overhead) });
  assert.equal(Buffer.byteLength(justFits), config.MAX_BLOB_BYTES);
  const okBig = await call('putSave', { slot: 2, baseVersion: 0, blob: justFits }, u.session);
  assert.ok(okBig.ok, JSON.stringify(okBig).slice(0, 300));
  assert.equal(okBig.result.bytes, config.MAX_BLOB_BYTES);
});
