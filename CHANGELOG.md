# Changelog

## 0.2.0 — 2026-10-23

Everything privileged can now run without the master key, which on Back4app is only ever shown in the dashboard.

- Cloud Code setup helpers, unauthenticated and gated by `SETUP_ENABLED` in `cloud/config.js` (default `true`;
  set to `false` and redeploy before the game goes public): `setupSchema({allowRerun?})` (idempotent schema via
  `Parse.Schema`, refuses once `Best` has ≥ 2 rows unless `allowRerun`), `seedBest({rows})` (≤ 50 synthetic
  `Best` rows per call, `player = null`, `seeded = true`, `seedKey` dedup), `testReset`, `testInspect`,
  `testPatch` (what the test suite used the master key for).
- The schema definition moved from `scripts/lib/schema.mjs` into `cloud/config.js` (`SCHEMA`), so the Cloud
  function and the REST path apply the same thing. `Best` gains `seeded`, `seedKey` and the `best_seedKey` index.
- `scripts/setup.mjs`, `scripts/seed.mjs`, `test/helpers.mjs`: master-key path kept for the local server; without
  `MASTER_KEY` they call the helpers. Seed budget without the key: 1,000,000 rows / 50 per call = 20,000 requests
  (≈ 21 min at 16 req/s), same token bucket, retry on HTTP 400 code 155, `--n`, `--from`, `--levels`, `--seed`.
- `scripts/bench.mjs` needs the REST key only; it submits the player's seeded score first when the player has no
  `Best` row on the level (Cloud-seeded data has no users).
- `npm test`: `TEST_SERVER_URL=https://parseapi.back4app.com npm test` runs the suite against a staging app
  without the key (one master-only test skipped); `MASTER_KEY= npm test` does the same locally. Three new tests
  cover the helpers (19 total).
- `leaderboard` returns `playerId: null, seeded: true` for seeded rows.
- `.env` loader strips trailing `# comments` (as written in `.env.example`).

## 0.1.0 — 2026-10-23

First release, companion to the article "Game backend: player accounts, leaderboards and cloud saves on a general
backend-as-a-service (Back4app / Parse Server)".

- Player accounts: anonymous sign-up, upgrade to username/password on the same `_User`, `Player` profile via
  `ensurePlayer` (owner read, Cloud Code writes).
- Scores: `submitScore` with per-level ceiling, monotonic `sessionCounter`, per-player rate limit (10/60 s),
  `clientNonce` replay dedup, `RejectedScore` audit log; `Score` history + `Best` (one row per player+level with
  all-time and weekly best).
- Leaderboards: `leaderboard` (top-N, all-time or weekly by ISO week key, ties share rank) and `myRank`
  (1 + count of greater scores).
- Cloud saves: `putSave`/`getSave`, 3 slots, JSON blob ≤ 500 KB, optimistic version (`STALE_SAVE`).
- Security: CLPs close create/update/delete on all classes; `beforeSave`/`beforeDelete` hooks reject non-master
  writes; `Best` public read, `Player`/`Score`/`Save` owner-only, `RejectedScore` master-only.
- Tooling: local parse-server 7 (Postgres), schema setup via REST, node:test suite (16 tests), deterministic
  seeder with throttle-aware token bucket, latency benchmark to CSV, Express web client for Containers.
