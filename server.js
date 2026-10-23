// File: server.js · Node 22 · Express 5
// Serves the static demo client, exposes the public Parse keys from env vars, and answers the platform health
// check. Deployed on Back4app Containers with the Node.js buildpack (port 8080, health check /healthz).
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// Local development only: read .env if present (Containers injects real env vars; nothing is read from disk
// there). The master and REST keys are deliberately skipped: the web process never sees them.
try {
  for (const line of readFileSync(path.join(here, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined && !['MASTER_KEY', 'REST_KEY', 'DATABASE_URL'].includes(m[1])) process.env[m[1]] = m[2];
  }
} catch { /* no .env: fine */ }
const PORT = Number(process.env.PORT) || 8080;

const required = ['APP_ID', 'JS_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')} — set them in Containers → Settings → Environment variables.`);
  process.exit(1);
}

const config = {
  appId: process.env.APP_ID,
  jsKey: process.env.JS_KEY,
  serverUrl: process.env.SERVER_URL || 'https://parseapi.back4app.com',
};

// Version marker for deploy checks: package.json version plus the commit when the build exposes it.
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
let commit = process.env.SOURCE_VERSION || process.env.GIT_COMMIT || process.env.COMMIT_SHA || '';
if (!commit) {
  try { commit = readFileSync(path.join(here, 'COMMIT'), 'utf8').trim(); } catch { commit = 'unknown'; }
}

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (req, res) => {
  res.json({ ok: true, version: pkg.version, commit, uptime: Math.round(process.uptime()) });
});

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
});

app.use(express.static(path.join(here, 'public'), { extensions: ['html'], maxAge: '1h' }));

app.use((req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

app.listen(PORT, () => {
  console.log(`game-backend-starter ${pkg.version} listening on :${PORT} (commit ${commit}, parse ${config.serverUrl})`);
});
