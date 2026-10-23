// File: scripts/bench.mjs · Node 22 ESM
// Latency of the two leaderboard reads as a client sees them: leaderboard (top-100) and myRank, all-time and
// weekly. REST key only (no master key needed). 20 warm-ups then 100 timed runs per operation; p50/p95/min/max/mean to docs/evidence/bench-<ts>.csv
// (summary) and bench-<ts>-samples.csv (every run). myRank runs as seeded player --player (default 0), signed
// in through its deterministic anonymous id (same --seed as the seed script).
//
//   npm run bench -- --level 1 [--limit 100] [--runs 100] [--warmup 20] [--seed 42] [--player 0] [--label local]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadEnv, parseArgs, ROOT } from './lib/env.mjs';
import { makeClient } from './lib/rest.mjs';
import { seededPlayer } from './seed.mjs';

const args = parseArgs();
const level = Number(args.level ?? 1);
const limit = Number(args.limit ?? 100);
const runs = Number(args.runs ?? 100);
const warmup = Number(args.warmup ?? 20);
const seed = Number(args.seed ?? 42);
const playerIndex = Number(args.player ?? 0);
const env = loadEnv();
const api = makeClient(env, { retry: true });
const label = args.label || new URL(env.SERVER_URL).hostname;

// Needs the REST key only: anonymous sign-in (public), leaderboard (public) and myRank (session) are the
// whole surface; nothing here queries a class directly.
//
// Sign in as seeded player --player (POST /users with an existing anonymous id logs that user in; with an
// unknown id it creates a fresh guest). When the player has no Best row on this level — the seed ran through
// seedBest (rows carry no _User) or the id is new — submit the score the seed assigned to that player, so
// myRank measures the same position either way.
const me = seededPlayer(playerIndex, seed, level);
const login = await api.request('POST', '/users', { body: { authData: { anonymous: { id: me.anonymousId } } } });
if (login.status !== 200 && login.status !== 201) {
  console.error(`cannot sign in as seeded player ${playerIndex} (seed ${seed}); run npm run seed first. ${login.status} ${JSON.stringify(login.json)}`);
  process.exit(1);
}
const session = login.json.sessionToken;
const have = await api.call('myRank', { level, scope: 'alltime' }, { session });
if (!have.ok) {
  console.error(`myRank failed: ${JSON.stringify(have.error)}${/Invalid function/.test(have.error.message || '') ? ' — Cloud Code not deployed' : ''}`);
  process.exit(1);
}
let position = `rank ${have.result.rank}`;
if (have.result.rank === null) {
  const profile = await api.call('ensurePlayer', { displayName: me.username.slice(0, 24) }, { session });
  if (!profile.ok) { console.error(`ensurePlayer failed: ${JSON.stringify(profile.error)}`); process.exit(1); }
  const myScore = me.scores.find((s) => s.level === level).score;
  const sub = await api.call('submitScore', { level, score: myScore, sessionCounter: profile.result.lastSessionCounter + 1, clientNonce: `bench-${Date.now()}` }, { session });
  if (!sub.ok) { console.error(`submitScore failed: ${JSON.stringify(sub.error)}`); process.exit(1); }
  position = `submitted the seeded score ${myScore} (no Best row yet)`;
}
console.log(`target ${env.SERVER_URL} · level ${level} · as ${login.json.username || login.json.objectId} (${position}) · ${warmup} warm-ups + ${runs} runs`);

const ops = [
  ['leaderboard_alltime_top' + limit, () => api.call('leaderboard', { level, scope: 'alltime', limit })],
  ['leaderboard_weekly_top' + limit, () => api.call('leaderboard', { level, scope: 'weekly', limit })],
  ['myRank_alltime', () => api.call('myRank', { level, scope: 'alltime' }, { session })],
  ['myRank_weekly', () => api.call('myRank', { level, scope: 'weekly' }, { session })],
];

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(ROOT, 'docs', 'evidence');
mkdirSync(outDir, { recursive: true });
const summary = ['timestamp,label,server,operation,level,limit,runs,p50_ms,p95_ms,min_ms,max_ms,mean_ms,errors,sample_result'];
const samples = ['label,operation,run,ms,ok'];

for (const [name, fn] of ops) {
  for (let i = 0; i < warmup; i++) await fn();
  const times = [];
  let errors = 0;
  let sampleResult = '';
  for (let i = 0; i < runs; i++) {
    const r = await fn();
    times.push(r.ms);
    if (!r.ok) errors++;
    else if (!sampleResult) sampleResult = name.startsWith('myRank') ? `rank=${r.result.rank}` : `entries=${r.result.entries.length}`;
    samples.push(`${label},${name},${i + 1},${r.ms.toFixed(1)},${r.ok}`);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const row = [new Date().toISOString(), label, new URL(env.SERVER_URL).host, name, level, limit, runs, pct(50).toFixed(1), pct(95).toFixed(1), sorted[0].toFixed(1), sorted.at(-1).toFixed(1), mean.toFixed(1), errors, sampleResult];
  summary.push(row.join(','));
  console.log(`${name.padEnd(28)} p50 ${pct(50).toFixed(1).padStart(7)} ms · p95 ${pct(95).toFixed(1).padStart(7)} ms · min ${sorted[0].toFixed(1)} · max ${sorted.at(-1).toFixed(1)} · errors ${errors} · ${sampleResult}`);
}

const summaryFile = path.join(outDir, `bench-${label}-${ts}.csv`);
const samplesFile = path.join(outDir, `bench-${label}-${ts}-samples.csv`);
writeFileSync(summaryFile, summary.join('\n') + '\n');
writeFileSync(samplesFile, samples.join('\n') + '\n');
console.log(`wrote ${path.relative(ROOT, summaryFile)} and ${path.relative(ROOT, samplesFile)}`);
