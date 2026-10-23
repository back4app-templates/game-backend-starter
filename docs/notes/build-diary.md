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
