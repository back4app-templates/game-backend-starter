// File: scripts/run-tests.mjs · Node 22 ESM
// `npm test`: starts the local parse-server if nothing answers at SERVER_URL, applies the schema, runs the
// node:test suite serially, then stops the server it started. Exit code = test result.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, ROOT } from './lib/env.mjs';
import { sleep } from './lib/rest.mjs';

const env = loadEnv({ master: true });
const healthUrl = env.SERVER_URL + '/health';

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
  const info = await fetch(env.SERVER_URL + '/serverInfo', { headers: { 'X-Parse-Application-Id': env.APP_ID, 'X-Parse-Master-Key': env.MASTER_KEY } });
  if (info.status !== 200) {
    console.error(`a Parse Server answers at ${env.SERVER_URL} but rejects APP_ID/MASTER_KEY from .env (HTTP ${info.status}). Another project's dev server? Change PARSE_PORT and SERVER_URL in .env.`);
    process.exit(1);
  }
} else {
  console.log(`no server at ${healthUrl}; starting scripts/dev-server.mjs`);
  server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'dev-server.mjs')], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  const deadline = Date.now() + 40000;
  while (!(await healthy())) {
    if (Date.now() > deadline || server.exitCode !== null) { console.error('server did not become healthy'); process.exit(1); }
    await sleep(300);
  }
}

const run = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { stdio: 'inherit', env: process.env, cwd: ROOT });
  p.on('exit', (code) => resolve(code ?? 1));
});

let code = await run([path.join(ROOT, 'scripts', 'setup.mjs')]);
if (code === 0) {
  const files = readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(ROOT, 'test', f));
  code = await run(['--test', '--test-concurrency=1', ...files]);
}

if (server) {
  server.kill('SIGTERM');
  await Promise.race([new Promise((r) => server.on('exit', r)), sleep(3000)]);
}
process.exit(code);
