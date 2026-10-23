// File: scripts/lib/schema.mjs · Node 22 ESM
// The schema (fields, class-level permissions, indexes) that scripts/setup.mjs applies through the schema
// REST API. Same definition for the local parse-server (Postgres) and for Back4app (MongoDB).
const MASTER_ONLY = {};                           // nobody but the master key
const PUBLIC = { '*': true };                     // anyone, including unauthenticated
const AUTHENTICATED = { requiresAuthentication: true };

const pointerToUser = { type: 'Pointer', targetClass: '_User' };

export const CLASSES = [
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
      find: AUTHENTICATED, get: AUTHENTICATED, count: MASTER_ONLY,
      create: MASTER_ONLY, update: MASTER_ONLY, delete: MASTER_ONLY, addField: MASTER_ONLY,
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
      find: AUTHENTICATED, get: AUTHENTICATED, count: MASTER_ONLY,
      create: MASTER_ONLY, update: MASTER_ONLY, delete: MASTER_ONLY, addField: MASTER_ONLY,
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
      player: pointerToUser,
      playerName: { type: 'String' },
      level: { type: 'Number' },
      score: { type: 'Number' },      // all-time best
      week: { type: 'String' },       // week of the most recent submission
      weekScore: { type: 'Number' },  // best within `week`
    },
    classLevelPermissions: {
      find: PUBLIC, get: PUBLIC, count: PUBLIC,
      create: MASTER_ONLY, update: MASTER_ONLY, delete: MASTER_ONLY, addField: MASTER_ONLY,
    },
    indexes: {
      best_alltime: { level: 1, score: -1, createdAt: 1 },
      best_weekly: { level: 1, week: 1, weekScore: -1, createdAt: 1 },
      best_player_level: { player: 1, level: 1 },
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
      find: AUTHENTICATED, get: AUTHENTICATED, count: MASTER_ONLY,
      create: MASTER_ONLY, update: MASTER_ONLY, delete: MASTER_ONLY, addField: MASTER_ONLY,
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
      find: MASTER_ONLY, get: MASTER_ONLY, count: MASTER_ONLY,
      create: MASTER_ONLY, update: MASTER_ONLY, delete: MASTER_ONLY, addField: MASTER_ONLY,
    },
    indexes: {
      rejected_player_createdAt: { player: 1, createdAt: -1 },
    },
  },
];
