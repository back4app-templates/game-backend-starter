// File: scripts/run-tests.mjs · Node 22 ESM
// `npm test`: starts the local parse-server if nothing answers at SERVER_URL, applies the schema, runs the
// node:test suite serially, then stops the server it started. Exit code = test result.
//
// Against a staging Back4app app (no master key, Cloud Code deployed with SETUP_ENABLED = true):
//   TEST_SERVER_URL=https://parseapi.back4app.com npm test
// The suite then goes through the setup helpers (setupSchema, seedBest, testReset, testInspect, testPatch)
// instead of the master key. Never point it at an app with real players: it creates users and Best rows.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './lib/env.mjs';
import { sleep } from './lib/rest.mjs';

const env = loadEnv({ test: true });
const healthUrl = env.SERVER_URL + '/health';
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(env.SERVER_URL + '/');

async function healthy() {
  try {
    const r = await fetch(healthUrl);
    const j = await r.json();
    return r.status === 200 && j.status === 'ok';
  } catch { return false; }
}

let server = null;
if (await healthy()) {
  // Something answers: make sure it is *our* app (another Parse Server on the same port answers 403 to our keys).
  // Without a master key the probe inside scripts/setup.mjs (ensurePlayer) is the check.
  if (env.MASTER_KEY) {
    const info = await fetch(env.SERVER_URL + '/serverInfo', { headers: { 'X-Parse-Application-Id': env.APP_ID, 'X-Parse-Master-Key': env.MASTER_KEY } });
    if (info.status !== 200) {
      console.error(`a Parse Server answers at ${env.SERVER_URL} but rejects APP_ID/MASTER_KEY from .env (HTTP ${info.status}). Another project's dev server? Change PARSE_PORT and SERVER_URL in .env.`);
      process.exit(1);
    }
  }
} else if (!isLocal) {
  console.log(`${healthUrl} did not answer {"status":"ok"}; continuing against ${env.SERVER_URL} anyway (remote server)`);
} else if (!env.MASTER_KEY) {
  console.error(`no server at ${healthUrl} and no MASTER_KEY in .env to start one: run npm run dev:server (with MASTER_KEY) in another terminal, or set TEST_SERVER_URL`);
  process.exit(1);
} else {
  console.log(`no server at ${healthUrl}; starting scripts/dev-server.mjs`);
  server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.mjs')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  const deadline = Date.now() + 40000;
  while (!(await healthy())) {
    if (Date.now() > deadline || server.exitCode !== null) { console.error('server did not become healthy'); server.kill('SIGTERM'); process.exit(1); }
    await sleep(300);
  }
}

const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env: process.env, cwd: ROOT });
  p.on('exit', (code) => resolve(code ?? 1));
});

// --allow-rerun: the Cloud Code path of setup.mjs refuses once Best has rows unless told so; a test target
// is expected to have rows from earlier runs.
let code = await run([path.join(ROOT, 'scripts', 'setup.mjs'), '--allow-rerun']);
if (code === 0) {
  const files = readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(ROOT, 'test', f));
  code = await run(['--test', '--test-concurrency=1', ...files]);
}

if (server) {
  server.kill('SIGTERM');
  await Promise.race([new Promise((r) => server.on('exit', r)), sleep(3000)]);
}
process.exit(code);
