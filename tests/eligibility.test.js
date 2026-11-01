import { describe, it, expect } from 'vitest';
import { decide, extractCid } from '../src/eligibility.js';

const now = new Date('2026-11-01T12:00:00Z');
const opts = { now, claimTimeoutMin: 120 };
const minutesAgo = (m) => new Date(now.getTime() - m * 60_000);

const archived = (extra = {}) => ({
  owner: 'meno', permlink: 'abc', manifest_cid: 'QmArchived',
  storage_state: 'archived', s3_url: 'https://s3.3speak.tv/videos/QmArchived/manifest.m3u8',
  hot_nodes: [], ...extra,
});

describe('extractCid', () => {
  it('reads manifest_cid from embed-video docs', () => {
    expect(extractCid({ manifest_cid: 'QmEmbed' })).toBe('QmEmbed');
  });

  it('parses ipfs://<cid>/manifest.m3u8 from legacy docs', () => {
    expect(extractCid({ video_v2: 'ipfs://QmLegacy/manifest.m3u8' })).toBe('QmLegacy');
  });

  it('parses a gateway URL from legacy docs', () => {
    expect(extractCid({ video_v2: 'https://ipfs.3speak.tv/ipfs/QmGw/manifest.m3u8' })).toBe('QmGw');
  });

  it('returns null when neither is there', () => {
    expect(extractCid({ video_v2: '' })).toBeNull();
    expect(extractCid(null)).toBeNull();
  });
});

describe('decide', () => {
  it('restores an archived video with no claim', () => {
    expect(decide(archived(), opts)).toEqual({ eligible: true });
  });

  it('treats a missing hot_nodes like an empty one', () => {
    const doc = archived();
    delete doc.hot_nodes;
    expect(decide(doc, opts).eligible).toBe(true);
  });

  it.each([
    ['not_found', null],
    ['no_cid', archived({ manifest_cid: undefined })],
    ['no_state', { owner: 'a', permlink: 'b', manifest_cid: 'Qm' }],
    ['hot', archived({ storage_state: 'hot' })],
    ['hot', archived({ hot_nodes: ['hotnode-one'] })],
    ['unknown_state', archived({ storage_state: 'restoring' })],
    ['no_s3_url', archived({ s3_url: undefined })],
    ['bad_promotion', archived({ promotion: 'yes' })],
    ['bad_promotion', archived({ promotion: { state: 'done' } })],
    ['bad_promotion', archived({ promotion: { state: 'queued' } })],
  ])('skips as %s', (reason, doc) => {
    expect(decide(doc, opts)).toEqual({ eligible: false, reason });
  });

  it('leaves a fresh claim alone', () => {
    const doc = archived({ promotion: { state: 'restoring', claimed_at: minutesAgo(30) } });
    expect(decide(doc, opts)).toEqual({ eligible: false, reason: 'in_flight' });
  });

  it('takes over a claim older than CLAIM_TIMEOUT_MIN', () => {
    const doc = archived({ promotion: { state: 'queued', claimed_at: minutesAgo(121) } });
    expect(decide(doc, opts)).toEqual({ eligible: true, stale: true });
  });

  it('never retries a permanent failure', () => {
    const doc = archived({ promotion: { state: 'failed', retryable: false, error: 'cid mismatch' } });
    expect(decide(doc, opts)).toEqual({ eligible: false, reason: 'failed_permanent' });
  });

  it('treats a failure without retryable as permanent', () => {
    const doc = archived({ promotion: { state: 'failed' } });
    expect(decide(doc, opts).reason).toBe('failed_permanent');
  });

  it('waits out the backoff on a retryable failure', () => {
    const doc = archived({ promotion: { state: 'failed', retryable: true, next_attempt_at: new Date(now.getTime() + 60_000) } });
    expect(decide(doc, opts)).toEqual({ eligible: false, reason: 'backoff' });
  });

  it('retries once next_attempt_at has passed', () => {
    const doc = archived({ promotion: { state: 'failed', retryable: true, next_attempt_at: minutesAgo(1) } });
    expect(decide(doc, opts)).toEqual({ eligible: true, retry: true });
  });
});
