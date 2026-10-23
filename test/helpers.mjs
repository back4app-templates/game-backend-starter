// File: test/helpers.mjs · Node 22 ESM · shared by the node:test files (REST only, no SDK)
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../scripts/lib/env.mjs';
import { makeClient } from '../scripts/lib/rest.mjs';
import config from '../cloud/config.js';

export const env = loadEnv({ master: true });
export const api = makeClient(env);
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

/** Master-key helpers used to inspect or reset state the API deliberately hides from clients. */
export const master = {
  find: (cls, where, extra = {}) => api.request('GET', `/classes/${cls}?${new URLSearchParams({ where: JSON.stringify(where), limit: '1000', ...extra })}`, { master: true }).then((r) => r.json.results || []),
  count: (cls, where) => api.request('GET', `/classes/${cls}?${new URLSearchParams({ where: JSON.stringify(where), count: '1', limit: '0' })}`, { master: true }).then((r) => r.json.count),
  async purge(cls, where) {
    for (;;) {
      const rows = await this.find(cls, where, { keys: 'objectId' });
      if (!rows.length) return;
      for (let i = 0; i < rows.length; i += 50) {
        await api.batch(rows.slice(i, i + 50).map((r) => ({ method: 'DELETE', path: `/classes/${cls}/${r.objectId}` })), { master: true });
      }
    }
  },
  async update(cls, id, body) {
    return api.request('PUT', `/classes/${cls}/${id}`, { master: true, body });
  },
};

export const userPointer = (id) => ({ __type: 'Pointer', className: '_User', objectId: id });
