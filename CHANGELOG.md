# Changelog

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
