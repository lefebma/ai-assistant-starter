# havn-connect: the sign-in relay

`/connect gmail` and `/connect outlook` send the owner to
`https://connect.gethavn.ai/start`. That page names the assistant the sign-in
is for (the label you give the box when you register it) and warns not to go
on with a link someone else sent. Its button sets a ten-minute cookie in that
browser, and the sign-in only completes in a browser carrying it, so a provider
link minted by a script and sent to someone else fails at the end. The relay then sends them on to Google or Microsoft, takes the result at `/callback`, and posts the tokens to that box
over https, signed with the box's own hand-off key. Code: `src/connect/`
(shared with the box), `deploy/connect-relay/worker.ts` (the Worker).

It also renews Gmail: a box posts its refresh token to `POST /refresh`, signed
with its hand-off key, and gets a fresh access token back, because only the
relay holds the Google Web client's secret. The Gmail refresh token a box
holds is sealed by the relay to that box, so it cannot be renewed by another
box or used anywhere else. `POST /revoke` ends the grant the same way. That makes the relay a live
dependency for Gmail (a box keeps working for at least 30 minutes after the
relay goes away). Outlook needs the relay only to sign in.

Drive is a second Google provider (`drive`, registered whenever `gmail` is) with the read-only `drive.readonly` scope and its own confirmation wording; add that scope to the consent screen before deploying.

What the relay keeps: the box registry (origin and hand-off key per box) and,
for ten minutes, the key of each used sign-in state so a link works once. It
never keeps a token. Google's client secret is a Worker secret; Microsoft needs
none, because the Havn app is a public client and every sign-in uses PKCE.

## Before the first deploy

1. **Google:** in the `havn-assistant` project, create an OAuth client of type
   **Web application** (the existing Desktop client cannot take an https
   redirect). Authorised redirect URI: `https://connect.gethavn.ai/callback`.
2. **Microsoft:** on the Havn app registration, Authentication → Add a
   platform → **Mobile and desktop applications** → custom redirect URI
   `https://connect.gethavn.ai/callback`. Not "Web": a Web redirect makes
   Microsoft demand a client secret, and the box could then not refresh on its
   own. "Allow public client flows" stays on.
3. The `gethavn.ai` zone is on this Cloudflare account, so the custom domain in
   `wrangler.toml` creates the DNS record on deploy.

## Deploy (once, from your machine)

```bash
node deploy/connect-relay/setup.mjs                              # deploy + signing, sealing, admin secrets
node deploy/connect-relay/setup.mjs <secrets>/havn-google-web-client.json   # again, once the Google Web client exists
```

It prints no secret and is safe to re-run: it only generates what is missing.
The admin token lands in `havn-connect-admin-token` in the operator secrets
folder; the Worker keeps only its SHA-256. Google's values come from the Web
client JSON you download at creation.

A provider whose settings are missing is simply not offered: its `/start`
answers "not valid". Changing `SIGNING_SECRET` voids any link in flight, nothing
else. To change `SEALING_SECRET` (only if it may have leaked), put the current
value in `SEALING_SECRET_OLD` first, then set the new one. Old tokens keep
opening, and each box's token is resealed with the new secret at its next
renewal (within the hour). After a day, delete `SEALING_SECRET_OLD`. Dropping
the old secret without that step strands every relay-connected Gmail account:
it can no longer be renewed or revoked through the relay, so each owner would
have to remove Havn at https://myaccount.google.com/permissions and connect
again.

Sign-in routes allow 30 requests a minute per client address and route
(`RATE_LIMITER`); `/refresh` and `/revoke` allow 600 (`BOX_RATE_LIMITER`), since
many boxes can share one address. Cloudflare's limiter is per location and
approximate, so it slows a flood rather than capping it; the used-state store
also clears expired entries in bounded batches.

## Connect a box

`npm run provision` registers every new box when `HAVN_CONNECT_ADMIN_TOKEN`
(the admin token from `<secrets>/havn-connect-admin-token`) is in your
environment (card #216). For a box that already exists:

```bash
HAVN_CONNECT_ADMIN_TOKEN=$(cat "<secrets>/havn-connect-admin-token") \
  npm run relay-box -- register havn-sam <ssh-host> <box hostname> --label "Havn assistant for Sam"
```

It registers `https://<box hostname>` under that label (what the sign-in page
shows the owner), then writes `CONNECT_RELAY_URL`, `CONNECT_BOX_ID` and
`CONNECT_HANDOFF_KEY` into the box's vault over SSH as havn, every value on
stdin. The hand-off key is never printed. A running box reads them at start:
restart it afterwards (`sudo systemctl restart havn` as havn-admin). Until all
three exist, `/connect` answers "not set up". `HAVN_CONNECT_URL` points it at
another relay.

A hosted box's Caddy must pass `POST /connect/handoff` to the app. Web setup
(`enable-setup`) writes that from card #216 on, and `enable-teams` from 1.64.1
on; an older box needs its edge written again with the same flags it was
enabled with, e.g.
`sudo node dist/scripts/hosted/enable-teams.js <hostname> --voice --web`.
Check from outside: `curl -X POST https://<hostname>/connect/handoff -d '{}'`
answers 401 (the app refusing an unsigned call). A 404 means Caddy dropped it.

`npm run relay-box -- list` lists boxes (never the keys) and
`npm run relay-box -- remove <box>` removes one. The admin API underneath:
`GET /admin/boxes` and
`DELETE /admin/boxes/<box>`. Registering a box again replaces its key, so the
box needs the new one.

## Logs

`npx wrangler@4 tail havn-connect`. Each line the Worker writes is
`{event, box, provider}` plus a reason on refusals, and never holds a code or a
token. Cloudflare's own request records (tail, Workers Logs) do show each
request URL, so a `/callback` URL with its one-time code appears there. That
code has already been redeemed, with its PKCE verifier, by the time it can be
read, so it is useless, but keep those logs to the operator account.
