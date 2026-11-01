// Read-only access to the two video collections. Dry run needs nothing else:
// there is no write code in this repo yet.

// Only what decide() and the logs need.
const PROJECTION = {
  owner: 1, permlink: 1, manifest_cid: 1, video_v2: 1,
  storage_state: 1, s3_url: 1, hot_nodes: 1, archived_at: 1, promotion: 1,
};

// Mongo is a long way from where Pulse may run (Pancreas sees 110–389 ms), so
// look videos up in batches instead of one round trip per list entry.
const BATCH = 100;

/**
 * @param db  a connected mongodb Db
 * @param entries  [{ collection, owner, permlink }]
 * @returns Map of "collection/owner/permlink" → doc (missing keys: not found)
 */
export async function findVideos(db, entries) {
  const found = new Map();
  const byCollection = new Map();
  for (const e of entries) {
    if (!byCollection.has(e.collection)) byCollection.set(e.collection, []);
    byCollection.get(e.collection).push(e);
  }

  for (const [collection, list] of byCollection) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const docs = await db.collection(collection)
        .find({ $or: chunk.map(e => ({ owner: e.owner, permlink: e.permlink })) }, { projection: PROJECTION })
        .toArray();
      for (const doc of docs) {
        const key = `${collection}/${doc.owner}/${doc.permlink}`;
        // Two docs for one owner/permlink would be a data problem; keep the first
        // and let the logs show which one was used.
        if (!found.has(key)) found.set(key, doc);
      }
    }
  }
  return found;
}
