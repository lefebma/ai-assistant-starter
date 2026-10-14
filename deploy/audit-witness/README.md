# havn-audit: the off-box audit witness

Each hosted box keeps an append-only, hash-chained log of every tool call
(`/var/lib/havn-audit/audit.jsonl`, see docs/HOSTED-VPS.md > Audit log). This
Worker keeps a second copy somewhere the box cannot reach. If a box's log is
edited, cut short or wiped, its chain stops matching this copy, and the box's
next send is refused with a 409.

The witness never sees what an event says. Each event arrives with its
`detail` (the command or path) replaced by a SHA-256, so client commands that
carry message text stay on the box.

- One Durable Object per box. It holds the box's token hash and chain head,
  and accepts a batch only if the batch continues that head.
- R2 bucket `havn-audit`, one object per batch under `boxes/<box>/`. A bucket
  lock on that prefix stops deletes and overwrites for 400 days.
- There is no delete or rewrite route. Box tokens are stored hashed and can be
  replaced one box at a time.

Cost: the free tier covers it. A box sends at most 288 batches a day.

## Deploy (once, from your machine)

R2 must be enabled on the account (dashboard > R2 > enable; it asks for a
payment method even on the free tier).

```bash
cd deploy/audit-witness
npx wrangler@4 r2 bucket create havn-audit
npx wrangler@4 r2 bucket lock add havn-audit boxes-400d boxes/ --retention-days 400
npx wrangler@4 deploy
```

Make an admin token, keep it in your own secrets store, and give the Worker
only its hash:

```bash
ADMIN=$(openssl rand -hex 32)          # store this somewhere safe
printf %s "$ADMIN" | shasum -a 256 | cut -d' ' -f1 | npx wrangler@4 secret put ADMIN_TOKEN_SHA256
```

To check the lock holds, try deleting a stored batch:
`npx wrangler@4 r2 object delete havn-audit/boxes/<box>/<key> --remote`.
Wrangler prints "Delete complete" whatever happens, so fetch the object
afterwards: it is still there. Checked this way on 2026-10-13.

## Connect a box

```bash
HAVN_WITNESS_URL=https://havn-audit.<subdomain>.workers.dev \
HAVN_WITNESS_ADMIN_TOKEN=$ADMIN \
npm run witness-token -- havn-marina 5.161.197.79
ssh havn@5.161.197.79 sudo systemctl restart havn
```

The box sends its backlog within a few minutes of starting, then every 5
minutes. Its progress is in `/var/lib/havn-audit/witness-state.json`.

## Check every box

```bash
curl -s -H "Authorization: Bearer $ADMIN" $HAVN_WITNESS_URL/v1/admin/status
```

Each box shows its head, when it last sent, how many sends were refused, its
last check, and a `problems` list in plain words. A refused send means the
box's log and this copy disagree. Shipping on that box stops until someone
looks: `witness-state.json` has the reason.

## Checks and alerts

Each box checks itself every hour (`src/assurance/witness-check.ts`): a
refused send, or events waiting more than an hour to leave. Once a day it also
verifies its own chain and compares the witness's head with its log, which
catches an event edited after it was sent. Problems go to the box's owner on
Telegram, once and then daily while they last. Every check is reported here
as kinds only, so it doubles as an hourly heartbeat.

Once a day (11:00 UTC) the Worker's cron lists every box that has been silent
for 24 hours, has unacknowledged refused sends, reports a failed check, or has
not run a full check in 48 hours. To get that list on Telegram, give the
Worker a bot token and chat id; without them it only logs:

```bash
npx wrangler@4 secret put ALERT_TELEGRAM_TOKEN
npx wrangler@4 secret put ALERT_TELEGRAM_CHAT
```

After looking into a refused send, acknowledge it so the daily report stops
repeating it. A box you no longer run can be retired: it drops out of status
and the report, and everything stored for it stays locked. Issuing it a new
token brings it back.

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN" $HAVN_WITNESS_URL/v1/admin/boxes/<box>/ack
curl -s -X POST -H "Authorization: Bearer $ADMIN" $HAVN_WITNESS_URL/v1/admin/boxes/<box>/retire
```

## Changing the Worker

Run `npx tsc -p deploy/audit-witness/tsconfig.json` to typecheck it. The
tests (`tests/audit-witness.test.ts`) run the real Worker code against an
in-memory stand-in for Durable Objects and a locked bucket.
