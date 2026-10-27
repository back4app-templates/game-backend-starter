# docs/evidence

Measured things only. Nothing in the README or the article should quote a number that is not backed by a file here.

What goes here (CSV/JSON files are gitignored by default; `git add -f` the ones you publish):

- `bench-<label>-<timestamp>.csv` — summary from `npm run bench`: one row per operation
  (`leaderboard_alltime_top100`, `leaderboard_weekly_top100`, `myRank_alltime`, `myRank_weekly`) with p50/p95/min/max/mean
  in ms, run count, error count and a sample result (`entries=100`, `rank=…`). `label` is `local` or `back4app`.
- `bench-<label>-<timestamp>-samples.csv` — every timed run behind the summary.
- `seed-<label>-<date>.txt` — the last lines of `npm run seed` output for the dataset the benchmark ran against
  (player count, levels, seed, wall-clock time, number of requests, throttle retries).
- Screenshots or `curl` transcripts that prove a manual step: the `Best` index list in the Back4app dashboard,
  the Cloud Code probe (`{"code":209,…}`), `/healthz` of the Containers app.

Record the target too: Back4app plan, region, Parse Server version shown in the dashboard, and the date. A
latency number without the dataset size and the target is noise.
- `bench-back4app-2026-10-23T14-44-40*.csv` — live run 1: schema indexes only (top-100 p50 4.56 s).
- `bench-back4app-fixed-index-2026-10-23T15-23-13*.csv` — live run 2: after the `_created_at` tie-break indexes (top-100 p50 428 ms).
- `bench-back4app-hinted-2026-10-23T15-36-30*.csv` — live run 3: plus the `myRank` hint (myRank unchanged at rank 545,293).
- `myrank-by-position-2026-10-23.txt` — myRank p50 at ranks 36 / 34,671 / 206,194 / 783,956: linear in rows above the player.
- `health-baseline-during-bench3-2026-10-23.txt` — `GET /health` timings during run 3 (not a usable baseline: slower than the functions themselves).
- `explain-find-*-2026-10-27.json` — MongoDB explain for the rank predicate (`level=1, score>X`): without a hint the planner picks `best_weekly_ca` and examines every level-1 document; with `hint=best_alltime` it reads an index range. Counts cannot be explained through the REST API.
