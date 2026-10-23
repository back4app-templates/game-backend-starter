// File: scripts/seed.mjs · Node 22 ESM
// Seeds N players × --levels Best rows, deterministically from --seed, at --rps requests/second (token bucket)
// with retry on Back4app's throttle (HTTP 400, Parse code 155). Resume an interrupted run with --from <players done>.
//
//   npm run seed                              # 1000 players × 3 levels, seed 42
//   npm run seed -- --n 1000000 --levels 1    # the live benchmark set
//
// Two paths, same deterministic data (scripts/bench.mjs works with either):
//   - MASTER_KEY in .env (local dev server): one anonymous _User per player (username seed-<seed>-<i>, plus the
//     _Session row Parse creates for every sign-up) and one Best row per level, written through /batch with
//     the master key. ≈ 40k requests for 1M players × 1 level (users + bests).
//   - no MASTER_KEY (Back4app: the key stays in the dashboard): rows go through the Cloud function seedBest,
//     50 rows per call, player = null, seeded = true, seedKey = seed-<seed>-<i>:<level> (re-runs skip rows that
//     exist). Budget: 1,000,000 rows / 50 per call = 20,000 requests ≈ 21 min at 16 req/s. No _User/_Session.
//     Requires Cloud Code deployed with config.SETUP_ENABLED = true.
// Synthetic test data: do not run this against a backend with real players.
import { loadEnv, parseArgs } from './lib/env.mjs';
import { makeClient, tokenBucket, rng } from './lib/rest.mjs';
import config from '../cloud/config.js';

const args = parseArgs();
const n = Number(args.n ?? 1000);
const levels = Number(args.levels ?? 3);
const seed = Number(args.seed ?? 42);
const rps = Number(args.rps ?? 16);
const batchSize = Math.min(config.SEED_BATCH_MAX, Number(args.batch ?? config.SEED_BATCH_MAX));
const from = Number(args.from ?? 0);
const concurrency = Number(args.concurrency ?? 4);
if (!Number.isInteger(n) || n < 1 || !Number.isInteger(levels) || levels < 1 || levels > config.MAX_LEVEL) {
  console.error('usage: seed --n <players> --levels <1..100> [--seed 42] [--rps 16] [--batch 50] [--from 0] [--concurrency 4]');
  process.exit(2);
}

const env = loadEnv();
const api = makeClient(env, { retry: true, maxAttempts: 10 });
const bucket = tokenBucket(rps);
const week = config.weekKey(new Date());

/** Deterministic description of player i (0-based). Same inputs → same anonymous id and scores. */
export function seededPlayer(i, seedValue = seed, levelCount = levels) {
  const r = rng(seedValue * 1000003 + i);
  const anonymousId = r.uuid();
  const username = `seed-${seedValue}-${i}`;
  const scores = [];
  for (let level = 1; level <= levelCount; level++) {
    const ceiling = config.ceilingForLevel(level);
    // Skewed distribution so the top of the board is sparse and the middle is dense (lots of ties there).
    const u = r.next();
    const score = Math.min(ceiling, Math.floor(ceiling * Math.pow(u, 3)));
    scores.push({ level, score });
  }
  return { i, anonymousId, username, scores };
}

/** The row seedBest gets for player i on `level` (no master key path). */
export function seededBestRow(player, score) {
  return { playerName: player.username, level: score.level, score: score.score, week, weekScore: score.score, seedKey: `${player.username}:${score.level}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const mode = env.MASTER_KEY ? 'master key (users + bests via /batch)' : 'Cloud function seedBest (no master key; player = null)';
  console.log(`seeding ${n - from} players × ${levels} level(s) at ${env.SERVER_URL} — ${mode}`);
  let usersCreated = 0, usersExisting = 0, bestsCreated = 0, bestsSkipped = 0, requests = 0;
  let next = from;
  const total = n;

  let completed = 0, lastPrinted = 0;
  function progress(players) {
    completed += players;
    if (completed - lastPrinted < 1000 && completed < total - from) return;
    lastPrinted = completed;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = completed / elapsed;
    const eta = rate > 0 ? Math.round((total - from - completed) / rate) : 0;
    const users = env.MASTER_KEY ? ` · users +${usersCreated} (reused ${usersExisting})` : '';
    console.log(`players ${from + completed}/${total}${users} · bests +${bestsCreated} (skipped ${bestsSkipped}) · ${requests} req · ${elapsed.toFixed(0)} s · eta ${eta} s`);
  }

  async function workerMaster() {
    for (;;) {
      const start = next;
      if (start >= total) return;
      const end = next = Math.min(total, start + batchSize);
      const players = [];
      for (let i = start; i < end; i++) players.push(seededPlayer(i));

      await bucket.take();
      requests++;
      const ur = await api.batch(players.map((p) => ({ method: 'POST', path: '/users', body: { username: p.username, authData: { anonymous: { id: p.anonymousId } } } })), { master: true });
      if (ur.status !== 200) throw new Error(`user batch ${start} failed: ${ur.status} ${JSON.stringify(ur.json).slice(0, 300)}`);
      const ids = [];
      for (let k = 0; k < players.length; k++) {
        const item = ur.json[k];
        if (item.success) { ids.push(item.success.objectId); usersCreated++; continue; }
        if (item.error && (item.error.code === 202 || item.error.code === 208)) {
          // username taken (re-run): look the user up by username and reuse it
          await bucket.take(); requests++;
          const q = await api.request('GET', `/users?where=${encodeURIComponent(JSON.stringify({ username: players[k].username }))}&keys=objectId`, { master: true });
          const found = q.json && q.json.results && q.json.results[0];
          if (!found) throw new Error(`user ${players[k].username} exists but cannot be found`);
          ids.push(found.objectId); usersExisting++;
          continue;
        }
        throw new Error(`user ${players[k].username}: ${JSON.stringify(item.error)}`);
      }

      const bestBodies = [];
      players.forEach((p, k) => {
        for (const s of p.scores) {
          bestBodies.push({
            method: 'POST', path: '/classes/Best',
            body: { player: { __type: 'Pointer', className: '_User', objectId: ids[k] }, playerName: p.username, level: s.level, score: s.score, week, weekScore: s.score, ACL: { '*': { read: true } } },
          });
        }
      });
      for (let k = 0; k < bestBodies.length; k += batchSize) {
        await bucket.take();
        requests++;
        const br = await api.batch(bestBodies.slice(k, k + batchSize), { master: true });
        if (br.status !== 200) throw new Error(`best batch ${start} failed: ${br.status} ${JSON.stringify(br.json).slice(0, 300)}`);
        for (const item of br.json) {
          if (item.success) bestsCreated++;
          else throw new Error(`best: ${JSON.stringify(item.error)}`);
        }
      }
      progress(end - start);
    }
  }

  async function workerCloud() {
    for (;;) {
      const start = next;
      if (start >= total) return;
      const end = next = Math.min(total, start + Math.max(1, Math.floor(batchSize / levels)));
      const rows = [];
      for (let i = start; i < end; i++) {
        const p = seededPlayer(i);
        for (const s of p.scores) rows.push(seededBestRow(p, s));
      }
      for (let k = 0; k < rows.length; k += batchSize) {
        await bucket.take();
        requests++;
        const r = await api.call('seedBest', { rows: rows.slice(k, k + batchSize) });
        if (!r.ok) {
          const e = r.error;
          if (/Invalid function/.test(e.message || '')) throw new Error('seedBest: Cloud Code not deployed (Invalid function) — upload cloud/main.js and cloud/config.js');
          if (e.code === 'SETUP_DISABLED') throw new Error('seedBest: disabled (cloud/config.js SETUP_ENABLED = false); seed with MASTER_KEY instead');
          throw new Error(`seedBest batch at player ${start} failed: ${JSON.stringify(e).slice(0, 300)}`);
        }
        bestsCreated += r.result.created;
        bestsSkipped += r.result.skipped;
      }
      progress(end - start);
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, env.MASTER_KEY ? workerMaster : workerCloud));
  } catch (err) {
    console.error(err.message);
    console.error(`resume with: npm run seed -- --n ${n} --levels ${levels} --seed ${seed} --from ${Math.max(from, next - batchSize * concurrency)}`);
    process.exit(1);
  }
  console.log(`seeded ${n - from} players × ${levels} level(s) (seed ${seed}, week ${week}) in ${((Date.now() - t0) / 1000).toFixed(1)} s · ${requests} requests`);
}
