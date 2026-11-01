// The commit this process is running, read once at startup. /health reports it
// so scripts/deploy.sh can tell the reload actually picked up the new code.

import { execFileSync } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git checkout (a tarball, a container)
  }
}

export const commit = readCommit();
