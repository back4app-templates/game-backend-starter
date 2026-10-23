# game-backend-starter

Player accounts, leaderboards and cloud saves for a game, on a general backend-as-a-service: **Back4app** (Parse
Server 7, MongoDB) for the data and Cloud Code, **Back4app Containers** for the tiny demo web client. Companion
repository for the article *"Game backend: player accounts, leaderboards and cloud saves on a general
backend-as-a-service"*. MIT licensed, by Back4app Engineering.

In scope: anonymous sign-up and account upgrade, a `Player` profile, score submission with abuse bounds, all-time
and weekly leaderboards with tie-aware ranks, three versioned cloud-save slots. Out of scope on purpose: no
virtual economy or currency, no matchmaking, no real-time play.

## How it fits together

```text
browser / game client ── Parse SDK or REST ──▶ Parse Server (Back4app)
   signs in anonymously, later upgrades             │
   calls Cloud functions only                       ├─ cloud/main.js  ensurePlayer · submitScore · leaderboard · myRank · putSave · getSave
   reads Best directly for leaderboards (public)    ├─ hooks: beforeSave/beforeDelete on Player, Score, Best, Save, RejectedScore → non-master writes rejected
                                                    └─ classes (created by scripts/setup.mjs, with CLPs and indexes)
```

| Class | One row per | Who reads | Who writes |
|---|---|---|---|
| `Player` | user | owner (ACL) | Cloud Code |
| `Score` | accepted submission (history) | owner (ACL) | Cloud Code |
| `Best` | player + level | everyone (leaderboards) | Cloud Code |
| `Save` | player + slot (0..2) | owner (ACL) | Cloud Code |
| `RejectedScore` | rejected submission | master key only | Cloud Code |

| Cloud function | Sign-in | Does |
|---|---|---|
| `ensurePlayer({displayName?, country?})` | yes | creates the `Player` profile on first call, updates the optional fields later |
| `submitScore({level, score, sessionCounter, clientNonce})` | yes | validates, logs rejections, appends a `Score`, upserts `Best` |
| `leaderboard({level, scope?, week?, limit?})` | no | top-N from `Best`, ranks with ties shared |
| `myRank({level, scope?, week?})` | yes | `1 + count(Best with greater score)` |
| `putSave({slot, baseVersion, blob})` | yes | optimistic write; `STALE_SAVE` with `currentVersion` when `baseVersion` is behind |
| `getSave({slot})` | yes | `{version, blob}`; `version 0, blob null` for an empty slot |

Setup helpers, unauthenticated, gated by `SETUP_ENABLED` in `cloud/config.js` (see "Without the master key"):

| Cloud function | Does |
|---|---|
| `setupSchema({allowRerun?})` | creates/updates the five classes (fields, CLPs, indexes); refuses once `Best` has ≥ 2 rows unless `allowRerun: true` |
| `seedBest({rows})` | ≤ 50 rows `{playerName, level, score, week, weekScore, seedKey?}` → public `Best` rows with `player = null`, `seeded = true`; rows whose `seedKey` exists are skipped |
| `testReset({className, where})` | deletes the rows of one class matching `where` (field → value equalities, non-empty) |
| `testInspect({className, where?, limit?, count?})` | reads rows (or a count) of one class with master rights |
| `testPatch({className, objectId, set})` | sets plain fields on one row with master rights |

Tunables (ceiling per level, rate limit, slot count, blob size, week key), the schema definition and the
`SETUP_ENABLED` switch live in `cloud/config.js`.

### Design choices worth knowing

- **Score history + Best.** `Score` is append-only (one row per accepted submission; useful for audits and
  "recent games"). Leaderboards never scan it: `Best` holds one row per player+level with `score` (all-time best),
  `week` (ISO week of the most recent submission) and `weekScore` (best within that week). The function upserts
  it on every accepted submission. Top-N is a single indexed query on `Best`; rank is a single indexed count.
- **Weekly reset without a job.** The week key is `YYYY-Www` (ISO 8601 week, UTC). A submission in a new week
  overwrites `week`/`weekScore`; rows nobody touched this week do not match the weekly filter. No cron, nothing to
  forget. Trade-off: last week's board is only available for players who did not play since (there is no weekly
  history table; add one if you need archives).
- **Ties share a rank** (1, 2, 2, 4 …): `myRank` = 1 + number of strictly greater scores; `leaderboard` assigns
  ranks the same way. Display order among equals is `Best.createdAt` ascending (the player who reached the board
  first is listed first); it is part of the index, so the sort is covered.
- **Anonymous first.** Players start with `authData.anonymous`; upgrading sets username/password on the same
  `_User` (the JS SDK's `signUp()` sends `authData.anonymous = null`), so `Player`, `Best` and `Save` stay attached.
- **Errors carry a code.** Functions throw `Parse.Error(142 or 209, '{"code":"STALE_SAVE","message":"…",
  "currentVersion":3}')`. Parse errors are (number, string) only, so the string is a JSON envelope.
  `parseCloudError()` in `public/app.js` and `scripts/lib/rest.mjs` unwraps it. Codes: `UNAUTHENTICATED` (209),
  `INVALID_ARGS`, `CEILING_EXCEEDED`, `COUNTER_NOT_MONOTONIC`, `RATE_LIMITED`, `INVALID_SLOT`, `BLOB_TOO_LARGE`,
  `STALE_SAVE`, `SETUP_DISABLED` (119), `SETUP_LOCKED`; direct writes get Parse 119 (`CLOUD_CODE_ONLY` from the
  hook, or the plain CLP message).
- **Seeded rows have no player.** `scripts/seed.mjs` without a master key creates `Best` rows through `seedBest`
  with `player = null` and `seeded = true` (creating 1M `_User` rows from the REST key is not possible and not
  desirable). `leaderboard` returns `playerId: null, seeded: true` for them; `myRank` counts them like any other
  row. Real players always have a pointer.

## What is and is not validated — read this before trusting a leaderboard

`submitScore` **bounds abuse; it does not prove gameplay.** The server cannot know that a score came from playing
the level. What it does:

| Check | Rejects | Logged as |
|---|---|---|
| per-level ceiling (`cloud/config.js`, default `10000 × level`) | impossible scores | `CEILING_EXCEEDED` |
| monotonic `sessionCounter` per player | replays and out-of-order sessions (a counter ≤ the last one, also consumed by rejected submissions) | `COUNTER_NOT_MONOTONIC` |
| per-player rate limit (10 per 60 s, fixed window, accepted + rejected) | floods | `RATE_LIMITED` |
| `clientNonce` dedup | network retries: the same nonce from the same player returns the original result and counts once | — (not a rejection) |
| sign-in required, writes only through the function | direct inserts, forged rows | Parse 119 |

What it does not do: verify a replay of the game, check timing against level length, detect a modified client
that produces plausible scores, or rate-limit per IP/device (a cheater with many anonymous accounts gets many
budgets — pair this with Back4app's rate limiting or an account cap per installation if that matters to you).
Every rejection is a `RejectedScore` row, so you can at least see who is probing.

## Deploy on Back4app

Steps marked *manual* need the dashboard; everything else is a script. The same sequence, written for an agent,
is in `AGENTS.md`.

1. **Backend app** (*manual*): Dashboard → New App → *Build your Backend* → name it. Then App Settings →
   Server Settings → make sure **Allow Client Class Creation is off** (the scripts create every class) and
   **anonymous users are enabled** (default).
2. **Keys** (*manual*): App Settings → Security & Keys → copy App ID, JavaScript key, REST key, Master key into
   `.env` (copy `.env.example`; set `SERVER_URL=https://parseapi.back4app.com`). `.env` is gitignored. Never
   give the master key to the web client or to Containers.
3. **Schema**: `npm run setup` — creates `Player`, `Score`, `Best`, `Save`, `RejectedScore` with fields, CLPs and
   indexes; idempotent. With `MASTER_KEY` in `.env` it uses the schema REST API directly; without one it calls the
   Cloud function `setupSchema` (so deploy Cloud Code, step 4, first — see "Without the master key"). It ends
   with a probe of Cloud Code.
4. **Cloud Code** (*manual*): Dashboard → Cloud Code → Upload → `cloud/main.js` **and** `cloud/config.js`
   (`cloud/package.json` is not needed) → Deploy. On a fresh backend the first Deploy has been seen to report
   "Success" while shipping nothing: reload, make the files dirty again, confirm the "Files pending deploy (2)"
   badge, Deploy, and prove it with a request, not the dialog:

   ```text
   $ curl -s -X POST https://parseapi.back4app.com/functions/ensurePlayer \
       -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" -H "Content-Type: application/json" -d '{}'
   {"code":209,"error":"{\"code\":\"UNAUTHENTICATED\",...}"}   ← live (function exists, rejects anonymous calls)
   {"code":141,"error":"Invalid function: \"ensurePlayer\""}   ← not deployed
   ```
   `npm run setup` prints the same verdict as its last line.
5. **Tie-break index** (*manual check*): Dashboard → Database → `Best` → Indexes. You should see `best_alltime`
   `{level:1, score:-1, createdAt:1}`, `best_weekly` `{level:1, week:1, weekScore:-1, createdAt:1}`,
   `best_player_level` and `best_seedKey`. If an index is missing (the schema API on MongoDB creates them
   asynchronously), create it there with exactly those keys; the leaderboard sort and `myRank` count rely on
   them at scale.
6. **Smoke test**: `TEST_SERVER_URL=https://parseapi.back4app.com npm test` points the suite at Back4app without
   touching the master key; it creates throw-away anonymous users and 500 `Best` rows on level 77. Do that on a
   staging app, not where real players live.
7. **Disable the setup helpers** (*manual*, before players arrive): in `cloud/config.js` set
   `SETUP_ENABLED = false`, upload `config.js` again, Deploy, and prove it:

   ```text
   $ curl -s -X POST https://parseapi.back4app.com/functions/setupSchema \
       -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" -H "Content-Type: application/json" -d '{}'
   {"code":119,"error":"{\"code\":\"SETUP_DISABLED\",...}"}   ← done
   ```
   Keep the flag in the repo at `true` only if the repo is for a staging app; the committed default is `true`
   because a fresh app needs it for steps 3 and 6.
8. **Web client**: push the repo to GitHub, then Containers → Deploy a web app → GitHub repository → *Build &
   run* → **Node.js Buildpack** → Port `8080`, Health check `/healthz` → env vars `APP_ID`, `JS_KEY`,
   `SERVER_URL=https://parseapi.back4app.com` → Create app. `curl https://<app>.b4a.run/healthz` →
   `{"ok":true,…}`. The buildpack installs devDependencies (parse-server) during the build; set
   `NPM_CONFIG_PRODUCTION=true` to skip them.

### Without the master key (agent / CI path)

On Back4app the master key is shown in the dashboard and nowhere else; an agent or a CI job typically has only
`APP_ID`, `JS_KEY`, `REST_KEY` and `SERVER_URL`. Everything privileged then runs **inside Cloud Code**, which has
master rights, through the setup helpers listed above. Leave `MASTER_KEY` empty in `.env` and the scripts switch
over by themselves:

```text
# Cloud Code deployed (step 4) with SETUP_ENABLED = true, .env without MASTER_KEY
npm run setup                                   # → setupSchema; add -- --allow-rerun once Best has rows
npm run seed -- --n 1000000 --levels 1          # → seedBest, 50 rows per call: 20,000 requests ≈ 21 min at 16 req/s
npm run bench -- --level 1 --label back4app     # leaderboard + myRank with the REST key and a guest session
TEST_SERVER_URL=https://parseapi.back4app.com npm test   # suite via testReset / testInspect / testPatch
# then: SETUP_ENABLED = false in cloud/config.js, upload, Deploy, curl → SETUP_DISABLED (step 7)
```

What differs from the master-key path: seeded `Best` rows have `player = null` (no `_User`, no `_Session`),
re-running the seed skips rows whose `seedKey` (`seed-<seed>-<i>:<level>`) exists, and one test (`master key can
write Score/Best`) is skipped. Do not mix the two seed paths on one app: the master-key seed has no `seedKey`, so
the Cloud path would add a second row per player. While `SETUP_ENABLED` is true, **anyone with the App ID can
create `Best` rows, read every row of every class and delete rows** — it is a setup tool for the window between
"app created" and "players arrive", not a feature.

### Live benchmark (optional)

```text
npm run seed -- --n 1000000 --levels 1        # resumable with --from; ≈ 42 min with the master key (users + bests, ≈ 40k requests),
                                              # ≈ 21 min without it (seedBest, 20,000 requests), both at 16 req/s
npm run bench -- --level 1 --label back4app   # top-100 and myRank, all-time and weekly, 20 warm-ups + 100 runs
```

The seeder is deterministic from `--seed` and retries Back4app's throttle (HTTP 400, Parse code 155). With the
master key it creates one anonymous `_User` (username `seed-<seed>-<i>`, plus the `_Session` row Parse creates
for every sign-up) and one `Best` row per level per player; without it, `Best` rows only (see above). The
benchmark signs in as seeded player `--player` through its deterministic anonymous id; when that player has no
`Best` row on the level (Cloud path, or a fresh id) it submits the score the seed assigned to it first, so
`myRank` measures the same position either way. Results land in `docs/evidence/` (gitignored CSVs; commit the
ones you want to publish).

## Local development

Requirements: Node 22+, PostgreSQL 17 (`/opt/homebrew/opt/postgresql@17/bin`, set `PG_BIN` otherwise) listening
on 5433. The dev server creates the `game_dev` database if missing.

```text
cp .env.example .env            # fill in random keys; SERVER_URL=http://localhost:1337/parse
npm install
npm run dev:server              # parse-server 7 + Postgres adapter, Cloud Code from cloud/main.js, port 1337
npm run setup                   # schema, CLPs, indexes
npm test                        # node:test; starts the dev server itself if nothing answers at SERVER_URL
npm run seed && npm run bench   # 1000 players × 3 levels, then latency CSVs
npm run dev:web                 # Express on :8080 serving public/ and /config.js
MASTER_KEY= npm test            # same suite through the Cloud Code setup helpers (dev server already running)
```

The local server needs `MASTER_KEY` to start; `setup`, `seed`, `bench` and the tests do not (they fall back to
the setup helpers). `MASTER_KEY= <command>` exercises the no-master-key path against the running dev server.

If another Parse Server already uses the port, change `PARSE_PORT` and `SERVER_URL` in `.env`; the test runner
refuses to run against a server that rejects your keys.

`cloud/` is CommonJS (Back4app runs Cloud Code on Node 19); `cloud/package.json` marks it so because the root
package is ESM. Do not use Node 20+ features in `cloud/`.

### Local Postgres vs Back4app MongoDB — re-verify these live

The local server exists to run the tests fast; Back4app runs MongoDB, and a few things differ:

- **Index sort direction.** The Postgres adapter creates indexes as `CREATE INDEX … (level, score, "createdAt")`
  — it keeps the column order but drops the `-1` directions (btree indexes are scanned both ways, so this is fine
  on Postgres). MongoDB honours the directions; check them in the dashboard (step 5).
- **Index metadata order.** `GET /schemas/Best` on Postgres reports keys in jsonb order
  (`{"week":1,"level":1,"createdAt":1,"weekScore":-1}`); the real index has the declared order. MongoDB reports
  the declared order.
- **count.** `myRank` is a `count` with an inequality. Postgres counts exactly; Parse Server on MongoDB uses
  `countDocuments` (also exact, index-backed when the filter is covered) but the cost grows with the number of
  rows above the player — measure it with the 1M seed, and check whether Back4app applies a count time limit.
- **Permission errors** come back as HTTP 400 with Parse code 119 (CLP) or 101 (`requiresAuthentication`,
  reported as "object not found"); the tests assert on the Parse code, which is the same on both.
- **Date encoding.** Cloud function results return `Date` values as `{__type:"Date", iso}`; the functions here
  convert them to ISO strings before returning. Same on both servers.

## Guarantees and limits (do not overstate them)

- Every rule is enforced in Cloud Code: **validation, not database constraints.** Two concurrent first calls to
  `ensurePlayer` can create two `Player` rows (the function deletes the newer one on the next read); two
  concurrent `submitScore` calls can both pass the rate-limit or counter check (read-modify-write on `Player`);
  two `putSave` calls with the same `baseVersion` can both succeed (no compare-and-set in the Parse API). The
  windows are milliseconds wide and only hurt a player racing against themself.
- The rate limit is a fixed window per player, not sliding, and not per IP or device.
- `leaderboard` returns at most 100 rows; `myRank` is a count, which is O(rows above you).
- `Best` is public: anyone can list every player's best scores and display names. Do not put private data in
  `displayName`.
- The setup helpers (`setupSchema`, `seedBest`, `testReset`, `testInspect`, `testPatch`) are unauthenticated
  while `SETUP_ENABLED` is true. The `SETUP_LOCKED` tripwire in `setupSchema` is a courtesy, not a boundary:
  anyone can pass `allowRerun: true`. Disabling the flag and redeploying is the only switch that counts.
- Nothing here backs up data off-platform.

## Repository map

```text
cloud/main.js, cloud/config.js   Cloud Code (upload both); config.js  scripts/setup.mjs      schema, CLPs, indexes (master key → REST,
                                 holds the schema and SETUP_ENABLED                           otherwise Cloud function setupSchema)
scripts/dev-server.mjs           local parse-server 7 + Postgres      scripts/seed.mjs       deterministic players/bests, throttle-aware
scripts/run-tests.mjs            `npm test` orchestration             scripts/bench.mjs      latency CSVs → docs/evidence/
test/*.test.mjs                  node:test suites (REST only)         public/                demo client (Parse JS SDK from CDN)
server.js                        Express for Containers               docs/notes/            build diary
AGENTS.md                        the deploy runbook for agents        CHANGELOG.md
```

## License

MIT — see `LICENSE`. © 2026 Back4app Engineering.
