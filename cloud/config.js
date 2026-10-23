// File: cloud/config.js · CommonJS · Parse Server 7.x (Back4app: Node 19 — no Node 20+ only features here)
// Tunables, the schema definition and the SETUP_ENABLED switch, shared by cloud/main.js, the scripts and the
// tests. Upload this file together with main.js.
'use strict';

// Highest level the game has. submitScore rejects levels outside 1..MAX_LEVEL.
const MAX_LEVEL = 100;

// Per-level score ceiling. A score above the ceiling cannot be produced by legitimate play of that level,
// so it is rejected and logged. Replace with your own table or formula.
function ceilingForLevel(level) {
  return 10000 * level;
}

// Per-player rate limit for submitScore: at most `max` submissions (accepted or rejected) per `windowMs`.
// Tracked on Player.submitWindowStart / Player.submitCount (fixed window, not sliding).
const RATE_LIMIT = { max: 10, windowMs: 60 * 1000 };

// Cloud saves: slots 0..SLOTS-1, blob is a JSON string of at most MAX_BLOB_BYTES (UTF-8).
const SLOTS = 3;
const MAX_BLOB_BYTES = 500 * 1024;

// Leaderboard page size cap.
const MAX_LEADERBOARD_LIMIT = 100;
const DEFAULT_LEADERBOARD_LIMIT = 10;

// Display name constraints (ensurePlayer).
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 24;

// Client nonce: opaque, 8..64 URL-safe chars (a UUID fits).
const CLIENT_NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Week key "YYYY-Www": ISO 8601 week, computed in UTC. Weekly boards "reset" implicitly because
// each submission is stamped with the week it arrived in and the weekly board filters by that key.
function weekKey(date) {
  const d = date || new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7; // Monday=1 … Sunday=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // nearest Thursday decides the ISO year
  const isoYear = t.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return isoYear + '-W' + (week < 10 ? '0' + week : String(week));
}
const WEEK_KEY_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

// ---------------------------------------------------------------------------------------------------------
// Setup helpers (setupSchema, seedBest, testReset, testInspect, testPatch in cloud/main.js)
// ---------------------------------------------------------------------------------------------------------
// These Cloud functions run with the master key on behalf of an UNAUTHENTICATED caller, so that a fresh
// Back4app app can be set up, seeded and tested with the REST key only (the master key never leaves the
// dashboard). They exist for the window between "app created" and "players arrive".
//
//   >>> Before you publish the game: set SETUP_ENABLED = false, upload config.js again and Deploy. <<<
//
// With SETUP_ENABLED=false every one of them answers SETUP_DISABLED and nothing else changes. Keep it true on a
// staging app you run the test suite against. While it is true, anyone with the App ID can create Best rows,
// read every row of every class and delete rows: it is a setup tool, not a feature.
const SETUP_ENABLED = true;

// seedBest accepts at most this many rows per call (the REST /batch limit, so one call = one request).
const SEED_BATCH_MAX = 50;

// The schema setupSchema (Cloud Code) and scripts/setup.mjs (REST, master key) apply: fields, class-level
// permissions, indexes. One definition for the local parse-server (Postgres) and for Back4app (MongoDB).
const CLP_MASTER_ONLY = {};                      // nobody but the master key
const CLP_PUBLIC = { '*': true };                // anyone, including unauthenticated
const CLP_AUTHENTICATED = { requiresAuthentication: true };
const pointerToUser = { type: 'Pointer', targetClass: '_User' };

const SCHEMA = [
  {
    className: 'Player',
    why: 'profile + anti-abuse counters; owner read via ACL, writes via Cloud Code',
    fields: {
      user: pointerToUser,
      displayName: { type: 'String' },
      country: { type: 'String' },
      lastSessionCounter: { type: 'Number' },
      submitWindowStart: { type: 'Date' },
      submitCount: { type: 'Number' },
    },
    classLevelPermissions: {
      find: CLP_AUTHENTICATED, get: CLP_AUTHENTICATED, count: CLP_MASTER_ONLY,
      create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
      protectedFields: { '*': ['submitWindowStart', 'submitCount'] },
    },
    indexes: {
      player_user: { user: 1 },
    },
  },
  {
    className: 'Score',
    why: 'per-submission history; owner read via ACL',
    fields: {
      player: pointerToUser,
      playerName: { type: 'String' },
      level: { type: 'Number' },
      score: { type: 'Number' },
      week: { type: 'String' },
      sessionCounter: { type: 'Number' },
      clientNonce: { type: 'String' },
    },
    classLevelPermissions: {
      find: CLP_AUTHENTICATED, get: CLP_AUTHENTICATED, count: CLP_MASTER_ONLY,
      create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
    },
    indexes: {
      score_player_createdAt: { player: 1, createdAt: -1 },
      score_player_nonce: { player: 1, clientNonce: 1 }, // replay lookup in submitScore
    },
  },
  {
    className: 'Best',
    why: 'one row per player+level; the leaderboards read this class only. Public read: scores are public.',
    fields: {
      player: pointerToUser,          // null on rows created by seedBest (synthetic benchmark data)
      playerName: { type: 'String' },
      level: { type: 'Number' },
      score: { type: 'Number' },      // all-time best
      week: { type: 'String' },       // week of the most recent submission
      weekScore: { type: 'Number' },  // best within `week`
      seeded: { type: 'Boolean' },    // true on rows created by seedBest
      seedKey: { type: 'String' },    // caller-supplied unique key of a seeded row (lets seedBest skip duplicates)
    },
    classLevelPermissions: {
      find: CLP_PUBLIC, get: CLP_PUBLIC, count: CLP_PUBLIC,
      create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
    },
    indexes: {
      best_alltime: { level: 1, score: -1, createdAt: 1 },
      best_weekly: { level: 1, week: 1, weekScore: -1, createdAt: 1 },
      best_player_level: { player: 1, level: 1 },
      best_seedKey: { seedKey: 1 },
    },
  },
  {
    className: 'Save',
    why: 'cloud saves, 3 slots per player; owner read via ACL, optimistic version',
    fields: {
      player: pointerToUser,
      slot: { type: 'Number' },
      version: { type: 'Number' },
      blob: { type: 'String' },
      bytes: { type: 'Number' },
    },
    classLevelPermissions: {
      find: CLP_AUTHENTICATED, get: CLP_AUTHENTICATED, count: CLP_MASTER_ONLY,
      create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
    },
    indexes: {
      save_player_slot: { player: 1, slot: 1 },
    },
  },
  {
    className: 'RejectedScore',
    why: 'audit log of rejected submissions; master key only',
    fields: {
      player: pointerToUser,
      reason: { type: 'String' },
      level: { type: 'Number' },
      score: { type: 'Number' },
      sessionCounter: { type: 'Number' },
    },
    classLevelPermissions: {
      find: CLP_MASTER_ONLY, get: CLP_MASTER_ONLY, count: CLP_MASTER_ONLY,
      create: CLP_MASTER_ONLY, update: CLP_MASTER_ONLY, delete: CLP_MASTER_ONLY, addField: CLP_MASTER_ONLY,
    },
    indexes: {
      rejected_player_createdAt: { player: 1, createdAt: -1 },
    },
  },
];

module.exports = {
  SETUP_ENABLED,
  SEED_BATCH_MAX,
  SCHEMA,
  MAX_LEVEL,
  ceilingForLevel,
  RATE_LIMIT,
  SLOTS,
  MAX_BLOB_BYTES,
  MAX_LEADERBOARD_LIMIT,
  DEFAULT_LEADERBOARD_LIMIT,
  DISPLAY_NAME_MIN,
  DISPLAY_NAME_MAX,
  CLIENT_NONCE_RE,
  WEEK_KEY_RE,
  weekKey,
};
