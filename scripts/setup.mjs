// File: scripts/setup.mjs · Node 22 ESM
// Creates or updates the classes, class-level permissions and indexes. Idempotent: run it again after editing
// the schema in cloud/config.js. Two paths, same definition:
//   - MASTER_KEY in .env (local dev server): schema REST API with the master key, no Cloud Code needed.
//   - no MASTER_KEY (Back4app, where the key stays in the dashboard): calls the Cloud function setupSchema
//     with the REST key; Cloud Code must be deployed first and config.SETUP_ENABLED must still be true.
// Usage: npm run setup [-- --dry-run] [-- --allow-rerun]   (--allow-rerun: Cloud path, Best already has rows)
import { loadEnv, parseArgs } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import { CLASSES } from './lib/schema.mjs';

const args = parseArgs();
const env = loadEnv({ test: true });
const api = makeClient(env, { retry: true });

let failures = 0;
if (env.MASTER_KEY) {
  await setupWithMasterKey();
} else {
  await setupWithCloudCode();
}

// Smoke-test that Cloud Code is live: an anonymous call to ensurePlayer must be rejected by the function
// itself (code 209 + UNAUTHENTICATED), not with "Invalid function".
const probe = await api.call('ensurePlayer', {});
if (!probe.ok && probe.error.code === 'UNAUTHENTICATED') console.log('cloud code: live (ensurePlayer rejects anonymous calls)');
else if (!probe.ok && /Invalid function/.test(probe.error.message || '')) { failures++; console.error('cloud code: NOT deployed (Invalid function "ensurePlayer") — upload cloud/main.js and cloud/config.js'); }
else console.log(`cloud code: unexpected probe result ${JSON.stringify(probe)}`);

process.exit(failures ? 1 : 0);

async function setupWithMasterKey() {
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
      printIndexes(def.className, (r.json && r.json.indexes) || {});
    }
  }
}

async function setupWithCloudCode() {
  console.log(`no MASTER_KEY in .env: applying the schema through the Cloud function setupSchema at ${env.SERVER_URL}`);
  if (args['dry-run']) { console.log('dry-run has no effect on the Cloud Code path (setupSchema is idempotent)'); }
  const r = await api.call('setupSchema', { allowRerun: !!args['allow-rerun'] });
  if (!r.ok) {
    failures++;
    const e = r.error;
    if (/Invalid function/.test(e.message || '')) console.error('setupSchema: NOT deployed (Invalid function) — upload cloud/main.js and cloud/config.js, Deploy, then run again');
    else if (e.code === 'SETUP_DISABLED') console.error('setupSchema: disabled (cloud/config.js SETUP_ENABLED = false). Re-enable it on a staging app, or run this script with MASTER_KEY in .env');
    else if (e.code === 'SETUP_LOCKED') console.error(`setupSchema: ${e.message} (npm run setup -- --allow-rerun)`);
    else console.error(`setupSchema failed: ${JSON.stringify(e)}`);
    return;
  }
  for (const c of r.result.classes) {
    if (c.action === 'created') console.log(`schema ${c.className}: created (${c.newFields.length} field(s), ${c.newIndexes.length} index(es))`);
    else console.log(`schema ${c.className}: updated (${c.newFields.length} new field(s), ${c.newIndexes.length} new index(es), CLP set)`);
  }
  for (const [className, idx] of Object.entries(r.result.indexes)) printIndexes(className, idx);
}

function printIndexes(className, idx) {
  console.log(`indexes ${className}: ${Object.entries(idx).map(([n, k]) => `${n}${JSON.stringify(k)}`).join(' ') || '(none reported)'}`);
}
