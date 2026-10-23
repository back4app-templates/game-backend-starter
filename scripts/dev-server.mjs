// File: scripts/dev-server.mjs · Node 22 ESM
// Local Parse Server 7 with the Postgres adapter, Cloud Code mounted from cloud/main.js. Mirrors the Back4app
// settings that matter for this template: allowClientClassCreation=false, anonymous users enabled.
// Usage: npm run dev:server   (reads .env; DATABASE_URL defaults to postgres://localhost:5433/game_dev)
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import express from 'express';
import { ParseServer } from 'parse-server';
import { loadEnv, ROOT } from './lib/env.mjs';

const env = loadEnv({ master: true });
const PG_BIN = process.env.PG_BIN || '/opt/homebrew/opt/postgresql@17/bin';

ensureDatabase(env.DATABASE_URL);

const mountPath = new URL(env.SERVER_URL).pathname.replace(/\/+$/, '') || '/parse';
const port = env.PARSE_PORT;

const parseServer = new ParseServer({
  appId: env.APP_ID,
  masterKey: env.MASTER_KEY,
  javascriptKey: env.JS_KEY || undefined,
  restAPIKey: env.REST_KEY || undefined,
  serverURL: env.SERVER_URL,
  databaseURI: env.DATABASE_URL,
  cloud: path.join(ROOT, 'cloud', 'main.js'),
  appName: 'game-backend-starter (local)',
  allowClientClassCreation: false,
  enableAnonymousUsers: true,
  enableInsecureAuthAdapters: false, // anonymous is not an 'insecure adapter'; this only silences the 7.x deprecation warning
  allowExpiredAuthDataToken: false,
  encodeParseObjectInCloudFunction: true,
  enforcePrivateUsers: true,
  directAccess: true,
  masterKeyIps: ['127.0.0.1', '::1', '::ffff:127.0.0.1'],
  logLevel: process.env.PARSE_LOG_LEVEL || 'warn',
  silent: process.env.PARSE_LOG_LEVEL ? false : true,
  verbose: false,
});

await parseServer.start();

const app = express();
app.disable('x-powered-by');
app.use(mountPath, parseServer.app);
app.listen(port, () => {
  console.log(`parse-server ${parseServerVersion()} on http://localhost:${port}${mountPath} (db ${redact(env.DATABASE_URL)}, cloud/main.js mounted)`);
});

function ensureDatabase(databaseUrl) {
  const u = new URL(databaseUrl);
  const db = u.pathname.replace(/^\//, '');
  const port = u.port || '5432';
  const host = u.hostname || 'localhost';
  const args = ['-h', host, '-p', port, db];
  const createdb = path.join(PG_BIN, 'createdb');
  const r = spawnSync(createdb, args, { encoding: 'utf8' });
  if (r.error) {
    console.warn(`createdb not found at ${createdb} (set PG_BIN); assuming database "${db}" exists.`);
    return;
  }
  if (r.status === 0) console.log(`created database ${db} on ${host}:${port}`);
  else if (!/already exists/.test(r.stderr)) {
    console.error(r.stderr.trim());
    process.exit(1);
  }
}

function parseServerVersion() {
  try {
    const require = createRequire(import.meta.url);
    return require('parse-server/package.json').version;
  } catch { return ''; }
}

function redact(url) {
  try { const u = new URL(url); if (u.password) u.password = '***'; return u.toString(); } catch { return url; }
}
