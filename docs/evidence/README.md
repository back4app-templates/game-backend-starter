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
