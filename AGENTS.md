# AGENTS.md — running this project end to end without a human unsticking you

For an AI agent (or a developer in a hurry) that has to set up, verify or redeploy the game backend starter.
Every step, which ones are unavoidably manual, and what to hand back to a human.

## What you are deploying

- **Backend**: a Back4app app (Parse Server 7, MongoDB). Classes `Player`, `Score`, `Best`, `Save`,
  `RejectedScore`; every write goes through 6 Cloud functions in `cloud/main.js` (+ `cloud/config.js`).
  `beforeSave`/`beforeDelete` hooks reject non-master writes. Clients read `Best` directly (public), their own
  `Player`/`Score`/`Save` via ACL; `RejectedScore` is master-only.
- **Setup helpers** (also in `cloud/main.js`, gated by `SETUP_ENABLED` in `cloud/config.js`, default `true`):
  `setupSchema`, `seedBest`, `testReset`, `testInspect`, `testPatch`. Unauthenticated functions that do the
  master-key work for you, because **the master key is not available to the scripts on Back4app** (it stays in
  the dashboard). The last step of every deploy is turning them off.
- **Web**: `server.js` (Express) serves `public/` and `/config.js`; Back4app Containers from GitHub, Node.js
  Buildpack, port 8080, health check `/healthz`.

## Secrets and where they live

- `.env` (gitignored): `APP_ID`, `JS_KEY`, `REST_KEY`, `SERVER_URL`, optionally `MASTER_KEY` (+ `DATABASE_URL`,
  `PARSE_PORT` for the local server). Scripts read it. Never commit it, never print `MASTER_KEY`. On Back4app
  leave `MASTER_KEY` empty: `setup`, `seed`, `bench` and `npm test` then go through the setup helpers. Only the
  local dev server (`npm run dev:server`) requires it.
- `TEST_SERVER_URL` (environment, not `.env`): points `npm test` at another server than `.env` describes and
  blanks `MASTER_KEY` for that run (`.env`'s key belongs to `.env`'s server).
- The Containers app gets only `APP_ID`, `JS_KEY`, `SERVER_URL`. Never give it the master key.
- Seeded test users (`seed-<seed>-<i>`) sign in through a deterministic anonymous id; they are synthetic.

## Steps (in order)

| # | Step | Manual? | Command / where |
|---|---|---|---|
| 1 | Create a Back4app account | **yes** | https://www.back4app.com/signup |
| 2 | Create a backend app | **yes** (dashboard) | Dashboard → New App → *Build your Backend* → name it → Create |
| 3 | Server settings | **yes** (dashboard) | App Settings → Server Settings: *Allow Client Class Creation* **off**; anonymous users **on** (default) |
| 4 | Copy keys into `.env` | **yes** | App Settings → Security & Keys → App ID, JavaScript key, REST key; `SERVER_URL=https://parseapi.back4app.com`. `MASTER_KEY` stays empty (not needed). |
| 5 | Deploy Cloud Code | **yes** (dashboard) | Cloud Code → *Upload* → `cloud/main.js` and `cloud/config.js` (`SETUP_ENABLED = true`) → badge "Files pending deploy (2)" → Deploy. See quirk below. |
| 6 | Create classes, CLPs, indexes | no | `npm run setup` → Cloud function `setupSchema` (idempotent; `-- --allow-rerun` once `Best` has ≥ 2 rows; last line reports whether Cloud Code is live) |
| 7 | Verify indexes | **yes** (dashboard) | Database → `Best` → Indexes: `best_alltime`, `best_weekly`, `best_player_level`, `best_seedKey` present with the keys in `cloud/config.js` (`SCHEMA`) |
| 8 | Verify functions | no | `TEST_SERVER_URL=https://parseapi.back4app.com npm test` against a **staging** app (suite goes through `testReset`/`testInspect`/`testPatch`; one master-key test is skipped), or the curl probe below |
| 9 | Live benchmark (optional) | no | `npm run seed -- --n 1000000 --levels 1` (→ `seedBest`, 20,000 requests ≈ 21 min at 16 req/s, resumable with `--from`) then `npm run bench -- --level 1 --label back4app`; CSVs in `docs/evidence/` |
| 10 | **Disable the setup helpers** | **yes** (dashboard) | `cloud/config.js`: `SETUP_ENABLED = false` → upload `config.js` → badge → Deploy → prove it: `curl … /functions/setupSchema` → `SETUP_DISABLED` (below). Skip only on a staging app that will keep running the suite. |
| 11 | Push the repo to GitHub | no | `git push` |
| 12 | Create the Containers app | **yes** (dashboard) | Containers → Deploy a web app → GitHub repository → *Build & run* → **Node.js Buildpack** → Port 8080, Health check `/healthz` → env vars `APP_ID`, `JS_KEY`, `SERVER_URL` → Create app |
| 13 | Confirm the deploy | no | `curl -s https://<app>.b4a.run/healthz` → `{"ok":true,"version":"0.2.0",…}` |

Steps marked **yes** need a browser session that belongs to the account owner; hand them back with the exact path above.
Order matters: Cloud Code (5) before `npm run setup` (6), because without a master key the schema is applied by
the Cloud function. Step 10 is not optional on an app that will have real players.

## Without the master key: what each script does

| Script | With `MASTER_KEY` (local dev server) | Without (Back4app) |
|---|---|---|
| `npm run setup` | schema REST API | `setupSchema({allowRerun})` — needs Cloud Code deployed + `SETUP_ENABLED` |
| `npm run seed` | `/batch`: anonymous `_User` + `Best` per player (≈ 40k requests for 1M × 1 level) | `seedBest({rows})`, 50 rows/call, `player = null`, `seeded = true`, `seedKey = seed-<seed>-<i>:<level>` (re-runs skip existing keys). **Budget: 1,000,000 rows / 50 = 20,000 requests**, ≈ 21 min at 16 req/s; token bucket + retry on HTTP 400 code 155 as before |
| `npm run bench` | REST key only in both cases: anonymous sign-in, `leaderboard`, `myRank`; submits the seeded score first when the player has no `Best` row on the level | same |
| `npm test` | `master.*` helpers hit `/classes` with the master key | `testInspect` / `testReset` / `testPatch`; `seedBest` for the 500 tie rows in both modes |

Do not mix the two seed paths on one app (the master-key seed writes no `seedKey`, so the Cloud path would add
a second row per player).

### Setup helper reference (`cloud/main.js`, section 4)

| Function | Params | Returns | Errors |
|---|---|---|---|
| `setupSchema` | `{allowRerun?: boolean}` | `{classes: [{className, action: created\|updated, newFields[], newIndexes[]}], indexes: {class: {name: keys}}, bestCount}` | `SETUP_DISABLED` (119), `SETUP_LOCKED` (142, `bestCount`) |
| `seedBest` | `{rows: [{playerName, level, score, week, weekScore, seedKey?}]}` (1..50) | `{created, skipped}` | `SETUP_DISABLED`, `INVALID_ARGS` (`field`) |
| `testReset` | `{className, where}` (`where` non-empty, field → value) | `{className, deleted}` | same |
| `testInspect` | `{className, where?, limit? (≤ 1000), count?: true}` | `{className, results: [json]}` or `{className, count}` | same |
| `testPatch` | `{className, objectId, set}` (REST-encoded values; no `objectId`/`createdAt`/`updatedAt`/`ACL`) | `{className, objectId, updatedAt}` | same |

`className` is one of `Player`, `Score`, `Best`, `Save`, `RejectedScore`. All five answer `SETUP_DISABLED` once
`SETUP_ENABLED = false` is deployed.

## Commands and expected output

```text
$ npm run setup                                   # no MASTER_KEY in .env
no MASTER_KEY in .env: applying the schema through the Cloud function setupSchema at https://parseapi.back4app.com
schema Player: created (6 field(s), 1 index(es))
schema Score: created (7 field(s), 2 index(es))
schema Best: created (8 field(s), 4 index(es))
schema Save: created (5 field(s), 1 index(es))
schema RejectedScore: created (5 field(s), 1 index(es))
indexes Best: _id_{"_id":1} best_alltime{"level":1,"score":-1,"createdAt":1} best_weekly{…} best_player_level{…} best_seedKey{…}
…
cloud code: live (ensurePlayer rejects anonymous calls)
  ← setupSchema: NOT deployed (Invalid function)      → redo step 5
  ← setupSchema: disabled (SETUP_ENABLED = false)     → re-enable on a staging app, or run with MASTER_KEY
  ← setupSchema: Best already holds N rows            → npm run setup -- --allow-rerun

$ TEST_SERVER_URL=https://parseapi.back4app.com npm test
…
﹣ master key can write Score/Best … # no MASTER_KEY (remote run)
ℹ tests 19
ℹ pass 18
ℹ fail 0
ℹ skipped 1

$ npm run seed -- --n 1000 --levels 3                # no MASTER_KEY
seeding 1000 players × 3 level(s) at https://parseapi.back4app.com — Cloud function seedBest (no master key; player = null)
players 1000/1000 · bests +3000 (skipped 0) · 63 req · N s · eta 0 s
seeded 1000 players × 3 level(s) (seed 42, week 2026-W43) in N.N s · 63 requests

$ npm run bench -- --level 1 --label back4app
target https://parseapi.back4app.com · level 1 · as seed-42-0 (submitted the seeded score 941 (no Best row yet)) · 20 warm-ups + 100 runs
leaderboard_alltime_top100   p50 … ms · p95 … ms …
wrote docs/evidence/bench-back4app-<ts>.csv and docs/evidence/bench-back4app-<ts>-samples.csv

$ curl -s -X POST https://parseapi.back4app.com/functions/setupSchema \
    -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" -H "Content-Type: application/json" -d '{}'
{"code":119,"error":"{\"code\":\"SETUP_DISABLED\",\"message\":\"Setup helpers are disabled …\"}"}   ← step 10 done
```

Local run: `npm test` starts `scripts/dev-server.mjs` (parse-server 7 + Postgres at `DATABASE_URL`, default
`postgres://localhost:5433/game_dev`, created with `createdb` if missing) when nothing answers at `SERVER_URL`,
and stops it afterwards; that needs `MASTER_KEY` in `.env`. If a *different* Parse Server answers there (another
project on the same port), the runner stops with a message: change `PARSE_PORT` and `SERVER_URL` in `.env`.
`MASTER_KEY= npm test` against a running dev server exercises the no-master-key path locally (19 tests, 1 skipped).

## Cloud Code deploy quirk (Back4app, observed September–October 2026 on other templates)

On a freshly created backend, the first Deploy in the Cloud Code editor can report "Success" while shipping
nothing (Logs → System: `Warning: main.js not found`). A Deploy clicked without the "Files pending deploy (N)"
badge also ships nothing. Recipe: reload the Cloud Code page, open each file, make it dirty again (edit and
restore a character, or re-upload), confirm the badge, Deploy. Prove it with a request, never with the dialog:

```text
$ curl -s -X POST https://parseapi.back4app.com/functions/ensurePlayer \
    -H "X-Parse-Application-Id: $APP_ID" -H "X-Parse-REST-API-Key: $REST_KEY" -H "Content-Type: application/json" -d '{}'
{"code":209,"error":"{\"code\":\"UNAUTHENTICATED\",\"message\":\"Sign in …\"}"}   ← live
{"code":141,"error":"Invalid function: \"ensurePlayer\""}                        ← not deployed yet
```

`cloud/main.js` does `require('./config.js')`: both files must be uploaded, in the same folder.

## Guarantees and limits (do not overstate them)

- Rules are enforced in Cloud Code, not by database constraints. Concurrent calls by the same player can slip
  past the rate limit / counter / save version once (milliseconds window). `ensurePlayer` self-heals duplicates.
- `submitScore` bounds abuse (ceiling, monotonic counter, rate limit, nonce dedup); it does not prove gameplay.
- `leaderboard` ≤ 100 rows; `myRank` is a count — measure it at 1M rows before promising a latency.
- Local server is Postgres; Back4app is MongoDB. Index directions and count behaviour must be re-verified live
  (README "Local Postgres vs Back4app MongoDB").
- While `SETUP_ENABLED` is true anyone with the App ID can create `Best` rows, read every row of every class and
  delete rows through the setup helpers. `setupSchema`'s `SETUP_LOCKED` tripwire is bypassable by design
  (`allowRerun: true`); only step 10 closes the door.

## Permission boundaries

- Never paste credentials into chat, logs, commits or screenshots.
- Never run `scripts/seed.mjs` against a backend with real players; it creates users and public `Best` rows.
- Never run `npm test` against production: it creates users and 500 `Best` rows on level 77.
- Never leave `SETUP_ENABLED = true` deployed on an app with real players (step 10). Never flip it back on to
  "just run the suite once" against a live app.
