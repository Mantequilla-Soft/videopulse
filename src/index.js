// Entry point. `node src/index.js` runs the hourly schedule and the status
// server; `node src/index.js --once` runs one pass, prints its summary and exits.

import cron from 'node-cron';
import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { runOnce } from './run.js';
import { createStatusServer } from './server.js';
import { log } from './log.js';
import { commit } from './version.js';

const config = loadConfig();
if (!cron.validate(config.runCron)) throw new Error(`RUN_CRON is not a valid cron expression: "${config.runCron}"`);
const client = new MongoClient(config.mongoUri, { appName: 'videopulse' });
await client.connect();
const db = client.db(config.databaseName);

if (process.argv.includes('--once')) {
  try {
    const summary = await runOnce({ config, db });
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exitCode = summary.status === 'ok' ? 0 : 1;
  } finally {
    await client.close();
  }
} else {
  const state = {
    startedAt: new Date(),
    running: false,
    lastRun: null,
    counters: { runs: 0, skippedRuns: 0, failedRuns: 0, wouldPromote: 0 },
  };

  // A pass that runs past the next tick (slow Mongo) is let finish; the tick is
  // dropped instead of starting a second pass beside it.
  async function tick() {
    if (state.running) {
      log.warn('previous run still going, skipping this tick');
      return;
    }
    state.running = true;
    try {
      const summary = await runOnce({ config, db });
      state.lastRun = summary;
      state.counters.runs++;
      if (summary.status === 'skipped') state.counters.skippedRuns++;
      else state.counters.wouldPromote += summary.wouldPromote.length;
    } catch (err) {
      state.counters.failedRuns++;
      state.lastRun = { startedAt: new Date(), status: 'error', error: err.message };
      log.error('run failed', { error: err.message, stack: err.stack });
    } finally {
      state.running = false;
    }
  }

  const server = createStatusServer(config, state, () => db.command({ ping: 1 }));
  server.listen(config.port, config.host, () => log.info('videopulse started', { commit, host: config.host, port: config.port, cron: config.runCron, dryRun: config.dryRun }));

  const task = cron.schedule(config.runCron, tick);
  if (config.runOnStart) tick();

  const stop = async (signal) => {
    log.info('stopping', { signal });
    task.stop();
    server.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
