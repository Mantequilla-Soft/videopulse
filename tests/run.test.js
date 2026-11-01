import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { runOnce } from '../src/run.js';
import { loadConfig } from '../src/config.js';

// A stand-in Pancreas whose answer each test sets.
let pancreas;
let answer;
let requests;

let mongod;
let client;
let db;
let config;

beforeAll(async () => {
  pancreas = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    const { status = 200, body } = answer;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
  });
  await new Promise(r => pancreas.listen(0, '127.0.0.1', r));

  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('threespeak');

  config = loadConfig({
    MONGODB_URI: mongod.getUri(),
    PANCREAS_URL: `http://127.0.0.1:${pancreas.address().port}/`,
    PANCREAS_API_KEY: 'pulse-key',
    LOG_DECISIONS: 'false',
  });
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await new Promise(r => pancreas.close(r));
});

beforeEach(async () => {
  requests = [];
  answer = { status: 200, body: { videos: [] } };
  await db.collection('videos').deleteMany({});
  await db.collection('embed-video').deleteMany({});
});

const s3 = (cid) => `https://s3.3speak.tv/videos/${cid}/manifest.m3u8`;
const entry = (collection, owner, permlink, sessions) => ({ collection, owner, permlink, sessions, lastWatchedAt: '2026-11-01T11:00:00Z' });

async function seed() {
  await db.collection('embed-video').insertMany([
    { owner: 'meno', permlink: 'archived1', manifest_cid: 'QmA1', storage_state: 'archived', s3_url: s3('QmA1'), hot_nodes: [] },
    { owner: 'meno', permlink: 'archived2', manifest_cid: 'QmA2', storage_state: 'archived', s3_url: s3('QmA2') },
    { owner: 'meno', permlink: 'hot', manifest_cid: 'QmH', storage_state: 'hot', hot_nodes: ['hotnode-one'] },
    { owner: 'meno', permlink: 'untouched', manifest_cid: 'QmU' },
  ]);
  await db.collection('videos').insertMany([
    { owner: 'tovia01', permlink: 'legacy', video_v2: 'ipfs://QmL/manifest.m3u8', storage_state: 'archived', s3_url: s3('QmL') },
    { owner: 'tovia01', permlink: 'claimed', video_v2: 'ipfs://QmC/manifest.m3u8', storage_state: 'archived', s3_url: s3('QmC'),
      promotion: { state: 'restoring', claimed_at: new Date(), attempts: 1 } },
  ]);
}

async function snapshot() {
  return {
    videos: await db.collection('videos').find().sort({ _id: 1 }).toArray(),
    embed: await db.collection('embed-video').find().sort({ _id: 1 }).toArray(),
    indexes: [await db.collection('videos').indexes(), await db.collection('embed-video').indexes()],
  };
}

describe('a dry run over a real list', () => {
  it('sorts out every entry and picks the most-watched eligible video', async () => {
    await seed();
    answer.body = {
      generatedAt: '2026-11-01T11:00:00Z',
      videos: [
        entry('embed-video', 'meno', 'archived1', 12),
        entry('embed-video', 'meno', 'archived2', 40),
        entry('embed-video', 'meno', 'hot', 99),
        entry('embed-video', 'meno', 'untouched', 7),
        entry('videos', 'tovia01', 'legacy', 30),
        entry('videos', 'tovia01', 'claimed', 25),
        entry('videos', 'nobody', 'gone', 5),
      ],
    };

    const summary = await runOnce({ config: { ...config, maxNewPerRun: 2 }, db });

    expect(summary.status).toBe('ok');
    expect(summary.listSize).toBe(7);
    expect(summary.eligible).toBe(3);
    expect(summary.wouldPromote).toEqual([
      { collection: 'embed-video', owner: 'meno', permlink: 'archived2', cid: 'QmA2', sessions: 40 },
      { collection: 'videos', owner: 'tovia01', permlink: 'legacy', cid: 'QmL', sessions: 30 },
    ]);
    expect(summary.skipped).toEqual({ hot: 1, no_state: 1, in_flight: 1, not_found: 1, over_limit: 1 });
  });

  it('sends the Pancreas key and calls nothing else', async () => {
    await seed();
    answer.body = { videos: [entry('embed-video', 'meno', 'archived1', 12)] };
    const calls = [];
    const countingFetch = (url, init) => { calls.push(url); return fetch(url, init); };

    await runOnce({ config, db, fetchImpl: countingFetch });

    expect(calls).toHaveLength(1);
    expect(requests).toEqual([{ url: '/pulse/hot-set', auth: 'Bearer pulse-key' }]);
  });

  it('writes nothing to Mongo', async () => {
    await seed();
    answer.body = { videos: [entry('embed-video', 'meno', 'archived1', 12), entry('videos', 'tovia01', 'legacy', 30)] };
    const before = await snapshot();

    const summary = await runOnce({ config: { ...config, maxNewPerRun: 5 }, db });

    expect(summary.wouldPromote).toHaveLength(2);
    expect(await snapshot()).toEqual(before);
  });

  it('applies MAX_IN_FLIGHT when it is lower than MAX_NEW_PER_RUN', async () => {
    await seed();
    answer.body = { videos: [entry('embed-video', 'meno', 'archived1', 12), entry('videos', 'tovia01', 'legacy', 30)] };

    const summary = await runOnce({ config: { ...config, maxNewPerRun: 5, maxInFlight: 1 }, db });

    expect(summary.wouldPromote.map(v => v.permlink)).toEqual(['legacy']);
    expect(summary.skipped.over_limit).toBe(1);
  });

  it('looks up long lists in batches', async () => {
    const docs = Array.from({ length: 250 }, (_, i) => ({
      owner: 'bulk', permlink: `v${i}`, manifest_cid: `Qm${i}`, storage_state: 'archived', s3_url: s3(`Qm${i}`),
    }));
    await db.collection('embed-video').insertMany(docs);
    answer.body = { videos: docs.map((d, i) => entry('embed-video', d.owner, d.permlink, i)) };

    const summary = await runOnce({ config: { ...config, maxNewPerRun: 500, maxInFlight: 500 }, db });

    expect(summary.eligible).toBe(250);
    expect(summary.skipped).toEqual({});
  });

  it('drops malformed and repeated entries', async () => {
    await seed();
    answer.body = {
      videos: [
        entry('embed-video', 'meno', 'archived1', 12),
        entry('embed-video', 'meno', 'archived1', 12),
        { collection: 'users', owner: 'meno', permlink: 'x' },
        { collection: 'videos', owner: '', permlink: 'x' },
        null,
      ],
    };

    const summary = await runOnce({ config, db });

    expect(summary.listSize).toBe(1);
    expect(summary.malformed).toBe(3);
  });

  it('accepts a genuinely empty list', async () => {
    const summary = await runOnce({ config, db });
    expect(summary).toMatchObject({ status: 'ok', listSize: 0, eligible: 0, wouldPromote: [] });
  });
});

describe('a failed list fetch is never an empty list', () => {
  it.each([
    [503, 'not_ready'],
    [401, 'auth'],
    [403, 'auth'],
    [500, 'http_error'],
    [404, 'http_error'],
  ])('skips the run on %i (%s)', async (status, reason) => {
    await seed();
    answer = { status, body: { videos: [entry('embed-video', 'meno', 'archived1', 12)] } };

    const summary = await runOnce({ config, db });

    expect(summary).toMatchObject({ status: 'skipped', reason, httpStatus: status });
    expect(summary.wouldPromote).toBeUndefined();
  });

  it('skips the run when the body is not JSON', async () => {
    answer.body = 'not json';
    expect(await runOnce({ config, db })).toMatchObject({ status: 'skipped', reason: 'bad_body' });
  });

  it('skips the run when there is no videos array', async () => {
    answer.body = { count: 0 };
    expect(await runOnce({ config, db })).toMatchObject({ status: 'skipped', reason: 'bad_body' });
  });

  it('skips the run when Pancreas is unreachable', async () => {
    const summary = await runOnce({ config: { ...config, pancreasUrl: 'http://127.0.0.1:1' }, db });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'unreachable' });
  });

  it('skips the run when Pancreas is too slow', async () => {
    const slow = () => new Promise((_, reject) => setTimeout(() => reject(new Error('The operation was aborted due to timeout')), 10));
    const summary = await runOnce({ config, db, fetchImpl: slow });
    expect(summary).toMatchObject({ status: 'skipped', reason: 'unreachable' });
  });
});
