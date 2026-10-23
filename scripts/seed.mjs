// File: scripts/seed.mjs · Node 22 ESM
// Seeds N players (anonymous _Users) and one Best row per player for each of --levels levels, deterministically
// from --seed. Writes go through /batch with the master key at --rps requests/second (token bucket) and retry on
// Back4app's throttle (HTTP 400, Parse code 155). Resume an interrupted run with --from <players done>.
//
//   npm run seed                              # 1000 players × 3 levels, seed 42
//   npm run seed -- --n 1000000 --levels 1    # the live benchmark set (≈ 40k requests ≈ 42 min at 16 rps)
//
// Each seeded sign-up also creates one _Session row (Parse does that for every sign-up, master key or not).
// Seeded users have usernames seed-<seed>-<i>; their anonymous ids come from the PRNG, so scripts/bench.mjs can
// sign in as one of them. Synthetic test data: do not run this against a backend with real players.
import { loadEnv, parseArgs } from './lib/env.mjs';
import { makeClient, tokenBucket, rng } from './lib/rest.mjs';
import config from '../cloud/config.js';

const args = parseArgs();
const n = Number(args.n ?? 1000);
const levels = Number(args.levels ?? 3);
const seed = Number(args.seed ?? 42);
const rps = Number(args.rps ?? 16);
const batchSize = Math.min(50, Number(args.batch ?? 50));
const from = Number(args.from ?? 0);
const concurrency = Number(args.concurrency ?? 4);
if (!Number.isInteger(n) || n < 1 || !Number.isInteger(levels) || levels < 1 || levels > config.MAX_LEVEL) {
  console.error('usage: seed --n <players> --levels <1..100> [--seed 42] [--rps 16] [--batch 50] [--from 0] [--concurrency 4]');
  process.exit(2);
}

const env = loadEnv({ master: true });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  let usersCreated = 0, usersExisting = 0, bestsCreated = 0, requests = 0;
  let next = from;
  const total = n;

  async function worker() {
    for (;;) {
      const start = next;
      if (start >= total) return;
      next = Math.min(total, start + batchSize);
      const players = [];
      for (let i = start; i < next; i++) players.push(seededPlayer(i));

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
      if ((next - from) % (batchSize * 20) === 0 || next === total) {
        const elapsed = (Date.now() - t0) / 1000;
        const done = next - from;
        const rate = done / elapsed;
        const eta = rate > 0 ? Math.round((total - next) / rate) : 0;
        console.log(`players ${next}/${total} · users +${usersCreated} (reused ${usersExisting}) · bests +${bestsCreated} · ${requests} req · ${elapsed.toFixed(0)} s · eta ${eta} s`);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } catch (err) {
    console.error(err.message);
    console.error(`resume with: npm run seed -- --n ${n} --levels ${levels} --seed ${seed} --from ${Math.max(from, next - batchSize * concurrency)}`);
    process.exit(1);
  }
  console.log(`seeded ${n - from} players × ${levels} level(s) (seed ${seed}, week ${week}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
