// Reads the environment once at startup. Anything wrong here stops the process
// before it touches Mongo or Pancreas.

function int(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  return n;
}

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function loadConfig(env = process.env) {
  // Only dry run exists so far. Refusing here, rather than running a half-built
  // live mode, means flipping the flag early can't start restores.
  const dryRun = env.DRY_RUN === undefined || env.DRY_RUN === '' || env.DRY_RUN === 'true';
  if (!dryRun) {
    throw new Error('DRY_RUN=false: live mode is not built yet. Leave DRY_RUN unset or "true".');
  }

  return {
    dryRun,
    mongoUri: required(env, 'MONGODB_URI'),
    databaseName: env.DATABASE_NAME || 'threespeak',
    pancreasUrl: required(env, 'PANCREAS_URL').replace(/\/+$/, ''),
    pancreasApiKey: required(env, 'PANCREAS_API_KEY'),
    statusToken: env.STATUS_TOKEN || null,
    port: int(env, 'PORT', 3020),
    // Loopback by default: nothing outside this box needs /health or /status.
    host: env.HOST || '127.0.0.1',
    runCron: env.RUN_CRON || '5 * * * *',
    runOnStart: env.RUN_ON_START !== 'false',
    fetchTimeoutMs: int(env, 'PANCREAS_TIMEOUT_MS', 30_000),
    maxNewPerRun: int(env, 'MAX_NEW_PER_RUN', 1),
    maxInFlight: int(env, 'MAX_IN_FLIGHT', 5),
    claimTimeoutMin: int(env, 'CLAIM_TIMEOUT_MIN', 120),
    logDecisions: env.LOG_DECISIONS !== 'false',
  };
}
