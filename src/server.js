// GET /health (open) and GET /status (bearer STATUS_TOKEN). Nothing here can
// start a restore or a run.

import http from 'http';
import { timingSafeEqual } from 'crypto';
import { commit } from './version.js';

function tokenMatches(header, token) {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * @param state  { lastRun, counters, startedAt } — read live on every request
 * @param pingDb  async () => void, throws when Mongo is unreachable
 */
export function createStatusServer({ statusToken, dryRun }, state, pingDb) {
  return http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });

    if (path === '/health') {
      try {
        await pingDb();
        return send(res, 200, { status: 'ok', commit });
      } catch {
        return send(res, 503, { status: 'mongo unreachable', commit });
      }
    }

    if (path === '/status') {
      // With no STATUS_TOKEN set, /status is off rather than open.
      if (!tokenMatches(req.headers.authorization, statusToken)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, {
        dryRun,
        commit,
        startedAt: state.startedAt,
        running: state.running,
        lastRun: state.lastRun,
        counters: state.counters,
        // Live-mode fields. Empty in dry run, because dry run never claims anything.
        inFlight: {},
        permanentFailures: [],
      });
    }

    return send(res, 404, { error: 'not found' });
  });
}
