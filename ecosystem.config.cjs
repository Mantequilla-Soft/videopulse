// pm2: `pm2 start ecosystem.config.cjs`, then `pm2 save`.
// Settings come from .env (Node's --env-file); nothing secret lives here.
module.exports = {
  apps: [{
    name: 'videopulse',
    script: 'src/index.js',
    cwd: __dirname,
    node_args: '--env-file=.env',
    // One instance only: two would double every call (see README).
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 10_000,
    max_memory_restart: '300M',
    time: false, // the JSON log lines carry their own timestamps
  }],
};
