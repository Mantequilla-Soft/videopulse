#!/usr/bin/env bash
# Pull-based deploy, run every minute by cron from the DEPLOY checkout
# (not a development clone):
#
#   * * * * * /usr/bin/flock -n /tmp/videopulse-deploy.lock <deploy dir>/scripts/deploy.sh >> <deploy dir>/.deploy/deploy.log 2>&1
#
# When origin/main has moved and GitHub Actions' `test` job passed on the new
# commit, it fast-forwards, runs `npm ci` if the lockfile changed, reloads pm2,
# and waits for /health to report the new commit. Anything failing after the
# fast-forward rolls back to the previous commit.
#
# Nothing on GitHub can reach this box: no runner, no inbound SSH, no deploy
# keys. A commit whose CI fails, or that doesn't come up, is refused once and
# logged once; the next push gets a fresh try.
#
# The fast-forward rewrites this file mid-run, so all the work is in functions
# and the last line is `main "$@"; exit $?`: bash reads that whole line before
# running it, and never reads past it.

main() {
  set -euo pipefail

  local app_dir repo state_dir log_tag
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  repo="Mantequilla-Soft/videopulse"
  state_dir="$app_dir/.deploy"
  mkdir -p "$state_dir"
  cd "$app_dir"

  # cron's PATH has no nvm node, npm or pm2.
  local nvm_bin
  nvm_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  export PATH="${nvm_bin:+$nvm_bin:}/usr/local/bin:/usr/bin:/bin"

  log() { echo "$(date -u +%FT%TZ) $*"; }
  once() {  # log a message once per (kind, key), e.g. per commit and CI state
    local kind="$1" key="$2"; shift 2
    [ "$(cat "$state_dir/$kind" 2>/dev/null || true)" = "$key" ] && return 0
    echo "$key" > "$state_dir/$kind"
    log "$*"
  }

  local remote current
  remote="$(git ls-remote origin refs/heads/main | cut -f1)"
  [ -n "$remote" ] || { log "git ls-remote failed"; return 1; }
  current="$(git rev-parse HEAD)"
  [ "$remote" = "$current" ] && return 0
  [ "$(cat "$state_dir/refused" 2>/dev/null || true)" = "$remote" ] && return 0
  local short="${remote:0:7}"

  # ── CI gate: the `test` check run on this exact commit ──
  local runs state
  if ! runs="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/$repo/commits/$remote/check-runs?check_name=test")"; then
    once api_error "$remote" "GitHub API unreachable, will retry ($short)"
    return 0
  fi
  state="$(jq -r 'if .total_count == 0 then "none"
                  else (.check_runs | sort_by(.started_at) | last | "\(.status):\(.conclusion // "")") end' <<<"$runs")"
  case "$state" in
    completed:success) ;;
    none|queued:*|in_progress:*|waiting:*|pending:*|requested:*)
      once waiting "$remote $state" "waiting for CI on $short ($state)"
      return 0 ;;
    *)
      echo "$remote" > "$state_dir/refused"
      log "refusing $short: CI $state"
      return 0 ;;
  esac

  # ── fast-forward ──
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "$remote" > "$state_dir/refused"
    log "refusing $short: the deploy checkout has local changes"
    return 1
  fi
  git fetch -q origin main
  if [ "$(git rev-parse origin/main)" != "$remote" ]; then
    return 0  # main moved again while we checked; next tick
  fi
  if ! git merge-base --is-ancestor HEAD "$remote"; then
    echo "$remote" > "$state_dir/refused"
    log "refusing $short: not a fast-forward from ${current:0:7}"
    return 1
  fi

  local lock_changed=0
  git diff --quiet "$current" "$remote" -- package-lock.json || lock_changed=1

  log "deploying ${current:0:7} -> $short"
  git merge -q --ff-only "$remote"

  if apply && healthy "$short"; then
    pm2 save >/dev/null
    log "deployed $short"
    return 0
  fi

  # ── roll back ──
  echo "$remote" > "$state_dir/refused"
  log "deploy of $short failed, rolling back to ${current:0:7}"
  git reset -q --hard "$current"
  if apply && healthy "${current:0:7}"; then
    log "rolled back to ${current:0:7}"
  else
    log "ROLLBACK FAILED: videopulse may be down, check pm2 logs videopulse"
  fi
  return 1
}

# npm ci (only when the lockfile changed) and reload under pm2. Uses
# startOrReload so a changed ecosystem.config.cjs is applied too.
apply() {
  if [ "$lock_changed" = 1 ]; then
    npm ci --omit=dev --no-audit --no-fund --loglevel=error || return 1
  fi
  pm2 startOrReload ecosystem.config.cjs --update-env >/dev/null || return 1
}

# Wait up to 60s for /health to report the expected commit. Mongo being down
# is not the deploy's fault, so the HTTP status doesn't matter, only the commit.
healthy() {
  local want="$1" port i got
  port="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
  for i in $(seq 1 30); do
    got="$(curl -s --max-time 3 "http://127.0.0.1:${port:-3020}/health" | jq -r '.commit // empty' 2>/dev/null || true)"
    [ "$got" = "$want" ] && return 0
    sleep 2
  done
  log "health check: wanted commit $want, got '${got:-nothing}'"
  return 1
}

main "$@"; exit $?
