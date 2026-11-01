# Video Pulse

[![CI](https://github.com/Mantequilla-Soft/videopulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Mantequilla-Soft/videopulse/actions/workflows/ci.yml)

Video Pulse puts archived 3Speak videos back on a hotnode when people start watching them again. It decides what to restore and asks for it; the hotnode moves the bytes.

- Design and v1 spec: [Mantequilla-Soft/buttercloud#18](https://github.com/Mantequilla-Soft/buttercloud/issues/18#issuecomment-6508555097)
- Storage plan and Mongo fields: [Mantequilla-Soft/hotnode#12](https://github.com/Mantequilla-Soft/hotnode/issues/12)
- The list it reads: [Mantequilla-Soft/3speakchecks#93](https://github.com/Mantequilla-Soft/3speakchecks/issues/93)

## Status: dry run only

This is rollout stage 1 of the spec. Once an hour Pulse:

1. fetches the hot set from Pancreas (`GET /pulse/hot-set`);
2. reads each listed video from `videos` or `embed-video`;
3. logs what it would do with it, and a summary for the run.

It writes nothing to Mongo, and calls nothing but Pancreas. There is no write code in the repo yet. `DRY_RUN=false` refuses to start.

Live mode is still to come: claiming, the traffic director, hotnode restores, and the polling pass. It waits on Mantequilla-Soft/trafficdirector#1, Mantequilla-Soft/hotnode#15 and Mantequilla-Soft/hotnode#13.

## What a run reports

Each list entry is either eligible (archived, has a verified `s3_url`, on no hotnode, no live claim) or skipped for one reason:

| Reason | Meaning |
|---|---|
| `hot` | `storage_state: "hot"`, or a hotnode still lists a pin |
| `no_state` | never archived, so still on the supernode. Before hotnode#12 stage 3, most entries land here. |
| `not_found` | no document for that owner/permlink in the named collection |
| `no_cid` | the document has no `manifest_cid` or parseable `video_v2` |
| `no_s3_url` | `archived` with no `s3_url`, which hotnode#12 says can't happen. Worth a look. |
| `unknown_state` | `storage_state` is neither `hot` nor `archived` |
| `in_flight` | a restore claim younger than `CLAIM_TIMEOUT_MIN` |
| `backoff` | a retryable failure whose `next_attempt_at` hasn't come |
| `failed_permanent` | a failure that needs a person |
| `bad_promotion` | a `promotion` field Pulse doesn't recognise |
| `over_limit` | eligible, but past `MAX_NEW_PER_RUN` / `MAX_IN_FLIGHT` for this run |

A failed fetch (`503` while Pancreas warms up, `401`/`403`, other errors, a bad body, a timeout) skips the run. It is never treated as an empty list. `401`/`403` logs at `error`, since it means a key is wrong.

Logs are one JSON object per line:

```bash
journalctl -u videopulse -o cat | jq 'select(.msg == "run finished")'
```

## Running it

```bash
npm install
cp .env.example .env && chmod 600 .env    # then fill it in
npm start               # schedule + status server
npm run once            # one pass, prints the summary, exits non-zero if skipped
```

Both scripts load `.env` with Node's `--env-file`. To keep it running under pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save
pm2 logs videopulse
```

### Deploying

A push to `main` deploys itself:

1. GitHub Actions (`.github/workflows/ci.yml`) runs the tests on every push and PR.
2. On the server, cron runs `scripts/deploy.sh` every minute from a **separate deploy checkout**, not a development clone. When `main` has moved and the `test` job passed on that exact commit, it fast-forwards, runs `npm ci --omit=dev` if the lockfile changed, and reloads pm2.
3. It waits up to a minute for `/health` to report the new commit. If that doesn't happen, or any step fails, it rolls back to the previous commit, and won't retry that commit.

Nothing on GitHub can reach the server: there's no runner, no inbound SSH and no deploy key. A commit whose CI fails is skipped. A commit with `[skip ci]` never deploys. The deploy log is `.deploy/deploy.log` in the deploy checkout. It only gets lines when something happens.

Setting up a server:

```bash
git clone https://github.com/Mantequilla-Soft/videopulse.git ~/apps/videopulse
cd ~/apps/videopulse && npm ci --omit=dev
cp /path/to/.env .env && chmod 600 .env
pm2 start ecosystem.config.cjs && pm2 save
mkdir -p .deploy
(crontab -l; echo "* * * * * /usr/bin/flock -n /tmp/videopulse-deploy.lock $HOME/apps/videopulse/scripts/deploy.sh >> $HOME/apps/videopulse/.deploy/deploy.log 2>&1") | crontab -
```

`GET /health` is open, and answers `200` when Mongo answers. It includes the running `commit`. `GET /status` needs `Authorization: Bearer $STATUS_TOKEN` and returns the last run, counters since start, and (empty in dry run) in-flight restores and permanent failures.

`scripts/videopulse.service` is a systemd unit for a single instance. Run only one: claims would make a second copy harmless in live mode, but it would double the calls.

### Mongo access

Dry run needs only `find` on `videos` and `embed-video`. A read-only user is enough until live mode, which adds `update` on both collections (Pulse writes only `promotion.*`) and the partial `promotion.state` indexes from the spec.

### Before #93 is deployed

`scripts/stub-pancreas.js` serves a hot set from a JSON file:

```bash
node scripts/stub-pancreas.js hot-set.json 3021
PANCREAS_URL=http://localhost:3021 PANCREAS_API_KEY=stub-key MONGODB_URI=... npm run once
```

The file is a list of `{ collection, owner, permlink, sessions }`, re-read on every request. `STUB_STATUS=503` makes the stub answer like a cold Pancreas.

## Config

| Variable | Default | |
|---|---|---|
| `MONGODB_URI` | — | required |
| `DATABASE_NAME` | `threespeak` | |
| `PANCREAS_URL`, `PANCREAS_API_KEY` | — | required |
| `PANCREAS_TIMEOUT_MS` | `30000` | |
| `STATUS_TOKEN` | — | unset: `/status` is off |
| `PORT` | `3020` | |
| `HOST` | `127.0.0.1` | interface for `/health` and `/status` |
| `DRY_RUN` | `true` | only `true` is accepted |
| `RUN_CRON` | `5 * * * *` | |
| `RUN_ON_START` | `true` | |
| `LOG_DECISIONS` | `true` | one line per list entry |
| `MAX_NEW_PER_RUN` | `1` | |
| `MAX_IN_FLIGHT` | `5` | |
| `CLAIM_TIMEOUT_MIN` | `120` | |

## Tests

```bash
npm test
```

They use vitest and mongodb-memory-server, and cover the eligibility rules, a dry run over a seeded database (including that it changes nothing), every fetch failure, and the status server.
