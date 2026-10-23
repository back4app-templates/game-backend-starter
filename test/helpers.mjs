// File: test/helpers.mjs · Node 22 ESM · shared by the node:test files (REST only, no SDK)
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../scripts/lib/env.mjs';
import { makeClient } from '../scripts/lib/rest.mjs';
import config from '../cloud/config.js';

// MASTER_KEY in .env: the helpers below read/reset hidden state through the REST API with the master key.
// No MASTER_KEY (TEST_SERVER_URL=https://parseapi.back4app.com, staging app): the same helpers go through the
// Cloud functions testInspect / testReset / testPatch, which need config.SETUP_ENABLED = true on the server.
export const env = loadEnv({ test: true });
export const api = makeClient(env, { retry: true });
export const hasMasterKey = !!env.MASTER_KEY;
export { config };

/** Anonymous sign-up (authData.anonymous). Returns { id, session, anonymousId }. */
export async function guest() {
  const anonymousId = randomUUID();
  const r = await api.request('POST', '/users', { body: { authData: { anonymous: { id: anonymousId } } } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`anonymous sign-up failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.objectId, session: r.json.sessionToken, anonymousId };
}

/** Upgrade an anonymous user to username/password, the way the JS SDK's signUp() does it. */
export async function upgrade(user, username, password) {
  return api.request('PUT', `/users/${user.id}`, {
    session: user.session,
    body: { username, password, authData: { anonymous: null } },
  });
}

export async function login(username, password) {
  return api.request('POST', '/login', { body: { username, password } });
}

export const call = (name, params, session) => api.call(name, params, { session });

export function nonce() {
  return randomUUID();
}

/** Submit n valid scores for a player, counters starting at `from`. Returns the results. */
export async function submitMany(user, { level = 1, n = 1, from = 1, score = 100 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await call('submitScore', { level, score, sessionCounter: from + i, clientNonce: nonce() }, user.session));
  }
  return out;
}

export function uniqueName(prefix = 'test') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Unwrap a Cloud function result or throw with the envelope (setup helpers must not fail silently). */
async function must(name, params) {
  const r = await api.call(name, params);
  if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
  return r.result;
}

/** Privileged helpers used to inspect or reset state the API deliberately hides from clients. */
export const master = hasMasterKey ? {
  find: (cls, where) => api.request('GET', `/classes/${cls}?${new URLSearchParams({ where: JSON.stringify(where), limit: '1000' })}`, { master: true }).then((r) => r.json.results || []),
  count: (cls, where) => api.request('GET', `/classes/${cls}?${new URLSearchParams({ where: JSON.stringify(where), count: '1', limit: '0' })}`, { master: true }).then((r) => r.json.count),
  async purge(cls, where) {
    for (;;) {
      const rows = await api.request('GET', `/classes/${cls}?${new URLSearchParams({ where: JSON.stringify(where), limit: '1000', keys: 'objectId' })}`, { master: true }).then((r) => r.json.results || []);
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += 50) {
        await api.batch(rows.slice(i, i + 50).map((r) => ({ method: 'DELETE', path: `/classes/${cls}/${r.objectId}` })), { master: true });
      }
    }
  },
  async update(cls, id, body) {
    const r = await api.request('PUT', `/classes/${cls}/${id}`, { master: true, body });
    if (r.status !== 200) throw new Error(`update ${cls}/${id} failed: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  },
} : {
  find: (cls, where) => must('testInspect', { className: cls, where, limit: 1000 }).then((r) => r.results),
  count: (cls, where) => must('testInspect', { className: cls, where, count: true }).then((r) => r.count),
  purge: (cls, where) => must('testReset', { className: cls, where }),
  update: (cls, id, body) => must('testPatch', { className: cls, objectId: id, set: body }),
};

/** Seed public Best rows through the Cloud function seedBest (player = null, seeded = true); ≤ 50 per call. */
export async function seedBest(rows) {
  let created = 0, skipped = 0;
  for (let i = 0; i < rows.length; i += config.SEED_BATCH_MAX) {
    const r = await must('seedBest', { rows: rows.slice(i, i + config.SEED_BATCH_MAX) });
    created += r.created; skipped += r.skipped;
  }
  return { created, skipped };
}

export const userPointer = (id) => ({ __type: 'Pointer', className: '_User', objectId: id });
