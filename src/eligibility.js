// Decides, from a video's Mongo document alone, whether Pulse should restore it
// to a hotnode. Field meanings are in Mantequilla-Soft/hotnode#12; the rules are
// "The run", step 3, of the Pulse v1 spec (Mantequilla-Soft/buttercloud#18).
//
// Pure: no I/O, so the live-mode claim filter can be checked against it.

/** The bare CID, from either collection's shape. Same rules as Pancreas's utils/unavailable.js. */
export function extractCid(doc) {
  if (!doc) return null;
  if (doc.manifest_cid) return String(doc.manifest_cid);   // embed-video
  const v2 = String(doc.video_v2 || '');                   // legacy: ipfs://<cid>/manifest.m3u8
  const m = v2.match(/^ipfs:\/\/([^/]+)/i) || v2.match(/\/ipfs\/([^/]+)/i);
  return m ? m[1] : null;
}

/**
 * @returns {{ eligible: true, stale?: true, retry?: true } | { eligible: false, reason: string }}
 *
 * Reasons:
 *   not_found         no document for this owner/permlink
 *   no_cid            the document has no CID Pulse could restore
 *   no_state          never archived (no storage_state): still on the supernode
 *   hot               storage_state "hot", or some hotnode still lists a pin
 *   unknown_state     storage_state is a value Pulse doesn't know
 *   no_s3_url         "archived" but no verified S3 copy recorded (shouldn't happen)
 *   in_flight         a restore is already claimed and not yet stale
 *   failed_permanent  an earlier restore failed in a way retrying won't fix
 *   backoff           an earlier restore failed and its retry time hasn't come
 *   bad_promotion     the promotion field is there but isn't a shape Pulse writes
 */
export function decide(doc, { now = new Date(), claimTimeoutMin }) {
  if (!doc) return { eligible: false, reason: 'not_found' };
  if (!extractCid(doc)) return { eligible: false, reason: 'no_cid' };

  const state = doc.storage_state;
  if (state === undefined || state === null) return { eligible: false, reason: 'no_state' };
  if (state === 'hot') return { eligible: false, reason: 'hot' };
  if (state !== 'archived') return { eligible: false, reason: 'unknown_state' };
  // archived with a pin still listed contradicts hotnode#12; trust the pin.
  if (Array.isArray(doc.hot_nodes) && doc.hot_nodes.length > 0) return { eligible: false, reason: 'hot' };
  if (!doc.s3_url) return { eligible: false, reason: 'no_s3_url' };

  const p = doc.promotion;
  if (p === undefined || p === null) return { eligible: true };
  if (typeof p !== 'object') return { eligible: false, reason: 'bad_promotion' };

  if (p.state === 'queued' || p.state === 'restoring') {
    const claimedAt = p.claimed_at ? new Date(p.claimed_at) : null;
    if (!claimedAt || Number.isNaN(claimedAt.getTime())) return { eligible: false, reason: 'bad_promotion' };
    const ageMin = (now - claimedAt) / 60_000;
    return ageMin >= claimTimeoutMin ? { eligible: true, stale: true } : { eligible: false, reason: 'in_flight' };
  }

  if (p.state === 'failed') {
    if (p.retryable !== true) return { eligible: false, reason: 'failed_permanent' };
    const next = p.next_attempt_at ? new Date(p.next_attempt_at) : null;
    if (next && Number.isNaN(next.getTime())) return { eligible: false, reason: 'bad_promotion' };
    return !next || next <= now ? { eligible: true, retry: true } : { eligible: false, reason: 'backoff' };
  }

  return { eligible: false, reason: 'bad_promotion' };
}
