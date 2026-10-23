// File: scripts/setup.mjs · Node 22 ESM
// Creates or updates the classes, class-level permissions and indexes through the schema REST API using the
// master key. Idempotent: run it again after editing scripts/lib/schema.mjs. Works against the local
// parse-server and against Back4app (same API). Usage: npm run setup [-- --dry-run]
import { loadEnv, parseArgs } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import { CLASSES } from './lib/schema.mjs';

const args = parseArgs();
const env = loadEnv({ master: true });
const api = makeClient(env, { retry: true });

let failures = 0;
for (const def of CLASSES) {
  const existing = await api.request('GET', `/schemas/${def.className}`, { master: true });
  if (existing.status === 200) {
    const have = existing.json;
    const newFields = {};
    for (const [name, spec] of Object.entries(def.fields)) if (!have.fields || !have.fields[name]) newFields[name] = spec;
    const haveIdx = have.indexes || {};
    const newIndexes = {};
    for (const [name, key] of Object.entries(def.indexes || {})) if (!haveIdx[name]) newIndexes[name] = key;
    const body = { className: def.className, fields: newFields, classLevelPermissions: def.classLevelPermissions };
    if (Object.keys(newIndexes).length) body.indexes = newIndexes;
    if (args['dry-run']) { console.log(`schema ${def.className}: would update`, JSON.stringify(body)); continue; }
    const r = await api.request('PUT', `/schemas/${def.className}`, { master: true, body });
    if (r.status === 200) {
      console.log(`schema ${def.className}: updated (${Object.keys(newFields).length} new field(s), ${Object.keys(newIndexes).length} new index(es), CLP set)`);
    } else {
      failures++;
      console.error(`schema ${def.className}: update failed ${r.status} ${JSON.stringify(r.json)}`);
    }
  } else if (existing.status === 400 && existing.json && existing.json.code === 103) {
    const body = { className: def.className, fields: def.fields, classLevelPermissions: def.classLevelPermissions, indexes: def.indexes };
    if (args['dry-run']) { console.log(`schema ${def.className}: would create`); continue; }
    const r = await api.request('POST', `/schemas/${def.className}`, { master: true, body });
    if (r.status === 200 || r.status === 201) {
      console.log(`schema ${def.className}: created (${Object.keys(def.fields).length} field(s), ${Object.keys(def.indexes || {}).length} index(es))`);
    } else {
      failures++;
      console.error(`schema ${def.className}: create failed ${r.status} ${JSON.stringify(r.json)}`);
    }
  } else {
    failures++;
    console.error(`schema ${def.className}: GET failed ${existing.status} ${JSON.stringify(existing.json)}`);
  }
}

// Report the indexes the server now believes it has (Back4app: compare with Dashboard → Database → Indexes).
if (!args['dry-run'] && !failures) {
  for (const def of CLASSES) {
    const r = await api.request('GET', `/schemas/${def.className}`, { master: true });
    const idx = (r.json && r.json.indexes) || {};
    console.log(`indexes ${def.className}: ${Object.entries(idx).map(([n, k]) => `${n}${JSON.stringify(k)}`).join(' ') || '(none reported)'}`);
  }
}

// Smoke-test that Cloud Code is live: an anonymous call to ensurePlayer must be rejected by the function
// itself (code 209 + UNAUTHENTICATED), not with "Invalid function".
const probe = await api.call('ensurePlayer', {});
if (!probe.ok && probe.error.code === 'UNAUTHENTICATED') console.log('cloud code: live (ensurePlayer rejects anonymous calls)');
else if (!probe.ok && /Invalid function/.test(probe.error.message || '')) { failures++; console.error('cloud code: NOT deployed (Invalid function "ensurePlayer") — upload cloud/main.js and cloud/config.js'); }
else console.log(`cloud code: unexpected probe result ${JSON.stringify(probe)}`);

process.exit(failures ? 1 : 0);
