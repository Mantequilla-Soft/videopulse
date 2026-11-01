// One hourly pass. In dry run it fetches the list, reads Mongo, and reports
// what it would do. It writes nothing and calls nothing but Pancreas.

import { fetchHotSet } from './pancreas.js';
import { findVideos } from './videos.js';
import { decide, extractCid } from './eligibility.js';
import { log } from './log.js';

export async function runOnce({ config, db, fetchImpl, now = new Date() }) {
  const startedAt = new Date();
  const list = await fetchHotSet(config, fetchImpl);

  if (!list.ok) {
    const summary = { startedAt, dryRun: config.dryRun, status: 'skipped', reason: list.reason, httpStatus: list.status ?? null, detail: list.detail ?? null };
    // A rejected key needs a person; a cold cache or a blip just waits an hour.
    (list.reason === 'auth' ? log.error : log.warn)('run skipped: hot-set fetch failed', summary);
    return summary;
  }

  // Pancreas sorts by sessions already; sort again so the limits below still
  // pick the most-watched videos if that ever changes.
  const entries = [...list.videos].sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0));
  const docs = await findVideos(db, entries);

  const skipped = {};
  const eligible = [];
  for (const e of entries) {
    const key = `${e.collection}/${e.owner}/${e.permlink}`;
    const doc = docs.get(key);
    const d = decide(doc, { now, claimTimeoutMin: config.claimTimeoutMin });
    if (d.eligible) {
      eligible.push({ entry: e, doc, decision: d });
    } else {
      skipped[d.reason] = (skipped[d.reason] || 0) + 1;
      if (config.logDecisions) {
        log.info('skip', { key, reason: d.reason, sessions: e.sessions, docId: doc?._id?.toString() ?? null });
      }
    }
  }

  // Dry run never claims anything, so nothing of Pulse's is in flight and only
  // the per-run limit can bind. Both are applied so the numbers match live mode.
  const capacity = Math.min(config.maxNewPerRun, config.maxInFlight);
  const wouldPromote = eligible.slice(0, capacity);
  const overLimit = eligible.length - wouldPromote.length;
  if (overLimit > 0) skipped.over_limit = overLimit;

  if (config.logDecisions) {
    for (const [i, { entry, doc, decision }] of eligible.entries()) {
      log.info(i < capacity ? 'would promote' : 'eligible, over limit', {
        key: `${entry.collection}/${entry.owner}/${entry.permlink}`,
        cid: extractCid(doc),
        sessions: entry.sessions,
        s3Url: doc.s3_url,
        archivedAt: doc.archived_at ?? null,
        staleClaim: decision.stale === true,
        retry: decision.retry === true,
      });
    }
  }

  const summary = {
    startedAt,
    finishedAt: new Date(),
    dryRun: config.dryRun,
    status: 'ok',
    listGeneratedAt: list.generatedAt,
    listSize: entries.length,
    malformed: list.malformed,
    eligible: eligible.length,
    wouldPromote: wouldPromote.map(({ entry, doc }) => ({
      collection: entry.collection, owner: entry.owner, permlink: entry.permlink,
      cid: extractCid(doc), sessions: entry.sessions,
    })),
    skipped,
  };
  log.info('run finished', {
    listSize: summary.listSize, eligible: summary.eligible,
    wouldPromote: summary.wouldPromote.length, skipped, malformed: list.malformed,
  });
  return summary;
}
