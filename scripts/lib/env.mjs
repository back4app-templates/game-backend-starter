// File: scripts/lib/env.mjs · Node 22 ESM
// Reads .env (never committed) into process.env without overriding variables already set, then validates.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadDotenv(file = path.join(ROOT, '.env')) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim(); // unquoted values may carry a trailing "# comment" (as .env.example does)
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
  return true;
}

/**
 * @param {{ master?: boolean, test?: boolean }} [opts]
 *   master: require MASTER_KEY too (only the local dev server needs it; setup/seed/tests work without one)
 *   test:   honour TEST_SERVER_URL as an override of SERVER_URL (point the suite at a staging backend)
 */
export function loadEnv(opts = {}) {
  loadDotenv();
  if (opts.test && process.env.TEST_SERVER_URL && process.env.TEST_SERVER_URL !== process.env.SERVER_URL) {
    // The suite targets another server than .env describes: its MASTER_KEY belongs to the .env server, so the
    // run goes through the Cloud Code setup helpers instead (see cloud/config.js SETUP_ENABLED).
    process.env.SERVER_URL = process.env.TEST_SERVER_URL;
    process.env.MASTER_KEY = '';
  }
  const required = ['APP_ID', 'SERVER_URL'];
  if (opts.master) required.push('MASTER_KEY');
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing ${missing.join(', ')} — copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return {
    APP_ID: process.env.APP_ID,
    JS_KEY: process.env.JS_KEY || '',
    REST_KEY: process.env.REST_KEY || '',
    MASTER_KEY: process.env.MASTER_KEY || '',
    SERVER_URL: process.env.SERVER_URL.replace(/\/+$/, ''),
    DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5433/game_dev',
    PARSE_PORT: Number(process.env.PARSE_PORT) || 1337,
  };
}

/** Parse command-line flags of the form --name value / --name=value / --flag. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq !== -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}
