// Fetches the "should be hot" list from Pancreas (Mantequilla-Soft/3speakchecks#93).
//
// A failed fetch is never an empty list: an empty list would mean "nothing is
// being watched", and a broken fetch means "we don't know". Every failure comes
// back as { ok: false } and the run is skipped.

const COLLECTIONS = new Set(['videos', 'embed-video']);

export async function fetchHotSet({ pancreasUrl, pancreasApiKey, fetchTimeoutMs }, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${pancreasUrl}/pulse/hot-set`, {
      headers: { Authorization: `Bearer ${pancreasApiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err.message };
  }

  // 401/403 is a configuration problem (wrong or rotated key), not a quiet hour.
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth', status: res.status };
  // Pancreas answers 503 until its worker has built the first list.
  if (res.status === 503) return { ok: false, reason: 'not_ready', status: 503 };
  if (res.status !== 200) return { ok: false, reason: 'http_error', status: res.status };

  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'bad_body', detail: 'response is not JSON' };
  }
  if (!body || !Array.isArray(body.videos)) {
    return { ok: false, reason: 'bad_body', detail: 'response has no videos array' };
  }

  // Keep only well-formed entries, once each. The list carries no CIDs and
  // nothing else Pulse acts on directly, so a dropped entry only means one video
  // isn't checked this hour.
  const seen = new Set();
  const videos = [];
  let malformed = 0;
  for (const v of body.videos) {
    if (!v || !COLLECTIONS.has(v.collection) || typeof v.owner !== 'string' || !v.owner
        || typeof v.permlink !== 'string' || !v.permlink) {
      malformed++;
      continue;
    }
    const key = `${v.collection}/${v.owner}/${v.permlink}`;
    if (seen.has(key)) continue;
    seen.add(key);
    videos.push({
      collection: v.collection,
      owner: v.owner,
      permlink: v.permlink,
      sessions: Number.isFinite(v.sessions) ? v.sessions : null,
      lastWatchedAt: v.lastWatchedAt ?? null,
    });
  }

  return {
    ok: true,
    generatedAt: body.generatedAt ?? null,
    windowHours: body.windowHours ?? null,
    minSessions: body.minSessions ?? null,
    videos,
    malformed,
  };
}
