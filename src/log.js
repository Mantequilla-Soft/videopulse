// One JSON object per line on stdout, so journald keeps each event whole and
// `journalctl -u videopulse -o cat | jq` works.

let silent = process.env.LOG_LEVEL === 'silent';

export function setSilent(value) {
  silent = value;
}

function write(level, msg, fields) {
  if (silent) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
