// File: cloud/config.js · CommonJS · Parse Server 7.x (Back4app: Node 19 — no Node 20+ only features here)
// Tunables shared by cloud/main.js, the scripts and the tests. Upload this file together with main.js.
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

module.exports = {
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
