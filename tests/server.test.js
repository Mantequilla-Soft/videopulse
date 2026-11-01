import { describe, it, expect, afterEach } from 'vitest';
import { createStatusServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

let server;

async function start(cfg, pingDb = async () => {}) {
  const state = { startedAt: new Date(), running: false, lastRun: { status: 'ok' }, counters: { runs: 1 } };
  server = createStatusServer({ dryRun: true, ...cfg }, state, pingDb);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

afterEach(() => new Promise(r => server.close(r)));

describe('status server', () => {
  it('reports health when Mongo answers, with the running commit', async () => {
    const base = await start({ statusToken: 't' });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    // scripts/deploy.sh waits for this to match the commit it deployed.
    expect((await res.json()).commit).toMatch(/^[0-9a-f]{7}$/);
  });

  it('reports 503 when Mongo does not', async () => {
    const base = await start({ statusToken: 't' }, async () => { throw new Error('down'); });
    expect((await fetch(`${base}/health`)).status).toBe(503);
  });

  it('serves /status with the right token only', async () => {
    const base = await start({ statusToken: 'secret' });
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);

    const res = await fetch(`${base}/status`, { headers: { Authorization: 'Bearer secret' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, lastRun: { status: 'ok' }, counters: { runs: 1 } });
  });

  it('keeps /status closed when no token is configured', async () => {
    const base = await start({ statusToken: null });
    expect((await fetch(`${base}/status`, { headers: { Authorization: 'Bearer ' } })).status).toBe(401);
  });

  it('accepts nothing but GET', async () => {
    const base = await start({ statusToken: 't' });
    expect((await fetch(`${base}/status`, { method: 'POST' })).status).toBe(405);
  });
});

describe('config', () => {
  const base = { MONGODB_URI: 'mongodb://x', PANCREAS_URL: 'http://p', PANCREAS_API_KEY: 'k' };

  it('defaults to dry run with the spec defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      dryRun: true, databaseName: 'threespeak', runCron: '5 * * * *', host: '127.0.0.1',
      maxNewPerRun: 1, maxInFlight: 5, claimTimeoutMin: 120,
    });
  });

  it('refuses to start with DRY_RUN=false', () => {
    expect(() => loadConfig({ ...base, DRY_RUN: 'false' })).toThrow(/live mode is not built/);
  });

  it('refuses anything else that is not "true"', () => {
    expect(() => loadConfig({ ...base, DRY_RUN: 'no' })).toThrow(/live mode is not built/);
  });

  it('requires the connection settings', () => {
    expect(() => loadConfig({ ...base, PANCREAS_API_KEY: '' })).toThrow(/PANCREAS_API_KEY/);
  });

  it('rejects a bad number', () => {
    expect(() => loadConfig({ ...base, MAX_NEW_PER_RUN: 'lots' })).toThrow(/MAX_NEW_PER_RUN/);
  });
});
