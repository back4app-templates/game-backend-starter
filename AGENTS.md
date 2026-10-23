# AGENTS.md — running this project end to end without a human unsticking you

For an AI agent (or a developer in a hurry) that has to set up, verify or redeploy the game backend starter.
Every step, which ones are unavoidably manual, and what to hand back to a human.

## What you are deploying

- **Backend**: a Back4app app (Parse Server 7, MongoDB). Classes `Player`, `Score`, `Best`, `Save`,
  `RejectedScore`; every write goes through 6 Cloud functions in `cloud/main.js` (+ `cloud/config.js`).
  `beforeSave`/`beforeDelete` hooks reject non-master writes. Clients read `Best` directly (public), their own
  `Player`/`Score`/`Save` via ACL; `RejectedScore` is master-only.
- **Web**: `server.js` (Express) serves `public/` and `/config.js`; Back4app Containers from GitHub, Node.js
  Buildpack, port 8080, health check `/healthz`.

## Secrets and where they live

- `.env` (gitignored): `APP_ID`, `JS_KEY`, `REST_KEY`, `MASTER_KEY`, `SERVER_URL` (+ `DATABASE_URL`, `PARSE_PORT`
  for the local server). Scripts read it. Never commit it, never print `MASTER_KEY`.
- The Containers app gets only `APP_ID`, `JS_KEY`, `SERVER_URL`. Never give it the master key.
- Seeded test users (`seed-<seed>-<i>`) sign in through a deterministic anonymous id; they are synthetic.

## Steps (in order)

| # | Step | Manual? | Command / where |
|---|---|---|---|
| 1 | Create a Back4app account | **yes** | https://www.back4app.com/signup |
| 2 | Create a backend app | **yes** (dashboard) | Dashboard → New App → *Build your Backend* → name it → Create |
| 3 | Server settings | **yes** (dashboard) | App Settings → Server Settings: *Allow Client Class Creation* **off**; anonymous users **on** (default) |
| 4 | Copy keys into `.env` | **yes** | App Settings → Security & Keys → *Show key* for the master key; `SERVER_URL=https://parseapi.back4app.com` |
| 5 | Create classes, CLPs, indexes | no | `npm run setup` (idempotent; last line reports whether Cloud Code is live) |
| 6 | Deploy Cloud Code | **yes** (dashboard) | Cloud Code → *Upload* → `cloud/main.js` and `cloud/config.js` → badge "Files pending deploy (2)" → Deploy. See quirk below. |
| 7 | Verify indexes | **yes** (dashboard) | Database → `Best` → Indexes: `best_alltime`, `best_weekly`, `best_player_level` present with the keys in `scripts/lib/schema.mjs` |
| 8 | Verify functions | no | `npm test` against a **staging** app (`SERVER_URL` in `.env`), or the curl probe below |
| 9 | Push the repo to GitHub | no | `git push` |
| 10 | Create the Containers app | **yes** (dashboard) | Containers → Deploy a web app → GitHub repository → *Build & run* → **Node.js Buildpack** → Port 8080, Health check `/healthz` → env vars `APP_ID`, `JS_KEY`, `SERVER_URL` → Create app |
| 11 | Confirm the deploy | no | `curl -s https://<app>.b4a.run/healthz` → `{"ok":true,"version":"0.1.0",…}` |
| 12 | Live benchmark (optional) | no | `npm run seed -- --n 1000000 --levels 1` then `npm run bench -- --level 1 --label back4app`; CSVs in `docs/evidence/` |

Steps marked **yes** need a browser session that belongs to the account owner; hand them back with the exact path above.

## Commands and expected output

```text
$ npm run setup
schema Player: created (6 field(s), 1 index(es))
schema Score: created (7 field(s), 2 index(es))
schema Best: created (6 field(s), 3 index(es))
schema Save: created (5 field(s), 1 index(es))
schema RejectedScore: created (5 field(s), 1 index(es))
indexes Best: _id_{"_id":1} best_alltime{"level":1,"score":-1,"createdAt":1} best_weekly{…} best_player_level{…}
…
cloud code: live (ensurePlayer rejects anonymous calls)          ← or: NOT deployed (Invalid function …) → redo step 6

$ npm test
…
ℹ tests 16
ℹ pass 16
ℹ fail 0

$ npm run seed -- --n 1000 --levels 3
seeded 1000 players × 3 level(s) (seed 42, week 2026-W43) in N.N s

$ npm run bench -- --level 1 --label local
leaderboard_alltime_top100   p50 … ms · p95 … ms …
wrote docs/evidence/bench-local-<ts>.csv and docs/evidence/bench-local-<ts>-samples.csv
```

Local run: `npm test` starts `scripts/dev-server.mjs` (parse-server 7 + Postgres at `DATABASE_URL`, default
`postgres://localhost:5433/game_dev`, created with `createdb` if missing) when nothing answers at `SERVER_URL`,
and stops it afterwards. If a *different* Parse Server answers there (another project on the same port), the
runner stops with a message: change `PARSE_PORT` and `SERVER_URL` in `.env`.

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

## Permission boundaries

- Never paste credentials into chat, logs, commits or screenshots.
- Never run `scripts/seed.mjs` against a backend with real players; it creates users and public `Best` rows.
- Never run `npm test` against production: it creates users and 500 `Best` rows on level 77.
