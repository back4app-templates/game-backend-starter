# Build diary — game-backend-starter

## 2026-10-23 — first version, local run green

**Decisions**

- Score storage: `Score` is append-only history; leaderboards read `Best` (one row per player+level) with
  `score` (all-time) and `week` + `weekScore` (most recent week). Rejected the alternative "upsert best into
  Score" because the per-submission log is what you want when a rejection pattern shows up, and the alternative
  "separate weekly Best rows" because one row per player+level keeps the upsert a single query and the index set
  small. The brief listed an `allTime` field; here it is simply `score`, and the weekly best is `weekScore`.
- Weekly board = filter by ISO week key (UTC), no job. Documented the trade-off: no archive of past weeks.
- Tie-break for display is `Best.createdAt` ascending (covered by the index); rank itself is shared among equals
  (`1 + count(greater)`), in both `leaderboard` and `myRank`, and the test checks them against a brute force on
  500 rows (50 distinct scores × 10 players, plus a sixth player moved through the distribution).
- Replay handling: the nonce is stored on `Score` and looked up with a `{player, clientNonce}` index (added to
  the brief's index list). A replay returns the original result and consumes neither rate budget nor counter.
  Rejections *do* consume the session counter, so a cheater cannot retry the same counter with a lower score.
- Errors: JSON envelope inside `Parse.Error.message` (`{"code":"STALE_SAVE","currentVersion":3}`); Parse errors
  only carry a number and a string. `UNAUTHENTICATED` uses Parse 209 so SDK clients drop a dead session.
- Cloud Code stays CommonJS; `cloud/package.json` with `"type":"commonjs"` keeps the local `require()` working
  under the ESM root package. Back4app does not need that file.

**Findings while running it locally (parse-server 7.5.4, Postgres 17 on :5433, Node 25 with engines >=22)**

- The JS SDK's `signUp()` on an anonymous user is what strips anonymity: it sends `authData: {anonymous: null}`
  with username/password. Parse Server does not do it by itself, so the REST test sends the same body.
- Master-key sign-ups still create `_Session` rows (`RestWrite.createSessionTokenIfNeeded` skips only
  `installationId === 'cloud'`). The 1M seed therefore also makes 1M sessions. Documented, not worked around.
- Postgres adapter and indexes: `CREATE INDEX IF NOT EXISTS name ON "Best" (level, score, "createdAt")` — column
  order kept, directions dropped (`$3:name` with an object formats its keys). `GET /schemas/Best` then reports
  the keys in jsonb order. Both are Postgres-only; must be re-verified on Back4app/MongoDB.
- Permission failures are HTTP 400 + Parse 119 (CLP) and HTTP 404 + Parse 101 (`requiresAuthentication` without
  a session). First draft of the security tests expected 403; fixed to assert on the Parse code.
- Cloud function results encode `Date` as `{__type:'Date', iso}`; the functions now return ISO strings.
- Port 1337 was taken by another project's dev server on this machine; added a `/serverInfo` check to the test
  runner so a foreign server produces a clear message instead of "unauthorized" on every schema call. Local
  `.env` uses 1338; `.env.example` keeps 1337.
- Full suite: 16 tests, ~0.9 s against the local server. Seed 1000 × 3 levels: 80 batched requests, 0.6 s at
  200 rps. Local bench (3,000 `Best` rows, level 1 has 1,000): top-100 p50 1.7 ms, weekly 2.9 ms, myRank ~1.2 ms —
  loopback Postgres numbers, meaningless for Back4app; the live run is step 12 in AGENTS.md.

**Open for the live run**

- Index directions and names in Dashboard → Database → Best → Indexes.
- `myRank` count latency at 1M rows (player near the bottom of the board is the worst case).
- Whether Back4app's batch endpoint accepts `/users` sign-ups with `authData.anonymous` under the master key the
  way parse-server 7.5.4 does (the seeder depends on it).
- Throttle behaviour at 16 req/s with 50-item batches (code 155 retries are counted in the seed output).

## 2026-10-23 — live run on Back4app (backend `game-backend-starter`, Parse Server 7.5.2, Free plan)

- **Cloud Code upload.** `config.js` only lands when the `cloud` folder is selected in the explorer before *Upload →
  Upload Files*; without the selection the file is silently dropped. The first Deploy of a fresh backend shipped
  `config.js` but not the edited `main.js` (the editor's unsaved buffer is not part of the deploy); a second edit +
  Deploy shipped it. Proof: `POST /functions/setupSchema` → 141 until then, then the full schema report.
- **`setupSchema` from the REST key** created Player, Score, Best, Save, RejectedScore with their fields, CLPs and
  indexes in one call. Index Manager afterwards shows the directions preserved on MongoDB:
  `best_alltime {level:1, score:-1, createdAt:1}`, `best_weekly {level:1, week:1, weekScore:-1, createdAt:1}`,
  `best_player_level`, `best_seedKey`, `score_player_createdAt {player:1, createdAt:-1}`, `score_player_nonce` —
  unlike the local PostgreSQL adapter, which drops directions.
- **Live test suite without the master key:** 17 pass, 1 skip (master-only write test), 1 finding — `POST
  /classes/Cheat` with a guest session created a class (HTTP 201). *Client Class Creation* lives under App
  Settings → Advanced Options and is fixed at **Yes on the Free plan** ("Upgrade your plan to change custom parse
  options"); the test now records the observation instead of failing, and deletes its row. The empty class had to be
  removed in the dashboard (Browser → ⋮ → Delete this class; a class with rows cannot be deleted).
- **Seed 1,000,000 `Best` rows via `seedBest`, REST key only:** 20,000 requests of 50 rows at the 16 req/s bucket;
  first 400k rows in 963 s (≈425 rows/s); 150 rows skipped by `seedKey` after a throttled request was retried —
  the dedup path working as designed. Full numbers in `docs/evidence/seed-live-2026-10-23.log`.

### Leaderboard at 1,000,000 rows — why the first live bench was slow, and the two fixes

First bench after the seed (`bench-back4app-2026-10-23T14-44-40.csv`): top-100 **p50 4.56 s**, myRank **p50 2.45 s**,
against a network baseline of ~1.2 s (`GET /health` p50 1.178 s, 30 runs, same client — the same machine measured
160 ms sign-ins on another app earlier in the day; the route to the platform was slow this afternoon).

1. **Index key names.** `Parse.Schema` (and the schema REST API) create MongoDB indexes with the field names you
   pass, untranslated: `createdAt` becomes an index on a key that no document has — MongoDB stores it as
   `_created_at`. So `{level:1, score:-1, createdAt:1}` served `where level=1 order -score` (1.3 s, = baseline)
   but not `order -score,createdAt` (6.6 s: in-memory sort of 1M rows). The dashboard's Index Manager *does* map
   `createdAt` → `_created_at`: `best_alltime_ca` and `best_weekly_ca` created there (built in ~3 min on 1M rows)
   brought the tie-break sort back to 1.26 s. README step 5 rewritten.
2. **The count's query plan.** `count where level=1 and score>X` took ~4.4 s whether X matched 298 rows or
   300,000, while the weekly variant (`level, week, weekScore>X`) took 1.2 s and `score=9999` (equality) 1.4 s.
   `hint=best_alltime_ca` → 1.15 s; `hint=best_alltime` (the schema-created one) → 2.2 s at 300k matches. The
   MongoDB 3.6 planner on this (sharded, Free-plan) cluster picks a bad plan for the range count; `myRank` now
   hints `best_alltime` / `best_weekly` (Postgres adapter ignores hints; 19/19 locally).
- Both Free-plan backends used today run **MongoDB 3.6** (App Settings → General); MVP and up advertise "latest
  MongoDB". The feasibility backend is also over its 25K monthly requests ("can stop responding at any moment").
- **Third bench (hinted, 15:36 UTC):** top-100 468/426 ms p50, myRank 2,365/2,363 ms p50 at rank 545,293 — the hint
  did not move the function's number. `docs/evidence/myrank-by-position-2026-10-23.txt` explains why: the count is
  linear in the rows above the player (1.2 s at rank 36 → 4.1 s at rank 783,956, ≈3.7 µs per row), i.e. MongoDB 3.6
  walks every matching row for `countDocuments`. The hint only removed the planner's extra ~3 s. Design consequence
  for the article: rank for players deep in the board should be cached, bucketed or shown as a percentile.
- Round trips for identical calls varied between ~0.43 s and ~1.3 s within the hour (route, not backend): compare the
  three bench runs by the gap between operations, not by absolute values.
