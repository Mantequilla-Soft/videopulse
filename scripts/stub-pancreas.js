// Serves GET /pulse/hot-set from a JSON file, standing in for Pancreas until
// Mantequilla-Soft/3speakchecks#93 is deployed.
//
//   node scripts/stub-pancreas.js <hot-set.json> [port]
//
// The file is re-read on every request, so it can be edited while Pulse runs.
// STUB_API_KEY (default "stub-key") is the bearer token it accepts.
// STUB_STATUS=503 makes it answer like a Pancreas whose cache is still cold.

import http from 'http';
import { readFile } from 'fs/promises';

const [file, port = '3021'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node scripts/stub-pancreas.js <hot-set.json> [port]');
  process.exit(2);
}
const key = process.env.STUB_API_KEY || 'stub-key';
const forcedStatus = Number(process.env.STUB_STATUS) || null;

http.createServer(async (req, res) => {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/pulse/hot-set') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
    return;
  }
  if (forcedStatus) {
    res.writeHead(forcedStatus, { 'Content-Type': 'application/json' }).end('{"error":"stubbed"}');
    return;
  }
  try {
    const videos = JSON.parse(await readFile(file, 'utf8'));
    const list = Array.isArray(videos) ? videos : videos.videos;
    const body = {
      generatedAt: new Date().toISOString(),
      windowHours: 48,
      minSessions: 5,
      count: list.length,
      videos: list,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
  }
}).listen(Number(port), () => console.log(`stub Pancreas on http://localhost:${port}/pulse/hot-set, key "${key}"`));
