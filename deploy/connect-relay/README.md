# havn-connect: the sign-in relay

`/connect gmail` and `/connect outlook` send the owner to
`https://connect.gethavn.ai/start`. That page names the assistant the sign-in
is for (the label you give the box when you register it) and warns not to go
on with a link someone else sent; only its button continues, so a forwarded
link cannot skip it. The relay then sends them on to Google or Microsoft, takes the result at `/callback`, and posts the tokens to that box
over https, signed with the box's own hand-off key. Code: `src/connect/`
(shared with the box), `deploy/connect-relay/worker.ts` (the Worker).

It also renews Gmail: a box posts its refresh token to `POST /refresh`, signed
with its hand-off key, and gets a fresh access token back, because only the
relay holds the Google Web client's secret. The Gmail refresh token a box
holds is sealed by the relay to that box, so it cannot be renewed by another
box or used anywhere else. `POST /revoke` ends the grant the same way. That makes the relay a live
dependency for Gmail (a box keeps working for at least 30 minutes after the
relay goes away). Outlook needs the relay only to sign in.

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
cd deploy/connect-relay
npx wrangler@4 deploy
openssl rand -hex 32 | npx wrangler@4 secret put SIGNING_SECRET
openssl rand -hex 32 | npx wrangler@4 secret put SEALING_SECRET
ADMIN=$(openssl rand -hex 32)          # store this in your own secrets store
printf %s "$ADMIN" | shasum -a 256 | cut -d' ' -f1 | npx wrangler@4 secret put ADMIN_TOKEN_SHA256
npx wrangler@4 secret put GOOGLE_CLIENT_ID       # paste from the Web client
npx wrangler@4 secret put GOOGLE_CLIENT_SECRET   # paste from the Web client
```

A provider whose settings are missing is simply not offered: its `/start`
answers "not valid". Changing `SIGNING_SECRET` voids any link in flight, nothing
else. Changing `SEALING_SECRET` disconnects every relay-connected Gmail account
(each owner runs `/connect gmail` again), so only do it if it may have leaked.

Every public route allows 30 requests a minute per client address and route
(the `RATE_LIMITER` binding in `wrangler.toml`).

## Connect a box

The box must be reachable over https at a stable origin (its tunnel hostname).
Register it with a label the owner will recognise, since it is what the
sign-in page shows. The answer carries the box's hand-off key, shown this once:

```bash
curl -s -X POST https://connect.gethavn.ai/admin/boxes/havn-test \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"origin":"https://<box hostname>","label":"Havn assistant for Sam"}'
```

Then on the box, in the owner's chat, set three secrets. `/secret set <NAME>`
asks for the value as the next message and deletes that message, so the key
never stays in chat history:

| Name | Value |
|---|---|
| `CONNECT_RELAY_URL` | `https://connect.gethavn.ai` |
| `CONNECT_BOX_ID` | the box id you registered, e.g. `havn-test` |
| `CONNECT_HANDOFF_KEY` | the `handoffKey` from the answer above |

and restart the service. `/connect` answers "not set up" until all three exist.

List boxes (never shows keys): `GET /admin/boxes`. Remove one:
`DELETE /admin/boxes/<box>`. Registering a box again replaces its key, so the
box needs the new one.

## Logs

`npx wrangler@4 tail havn-connect`. Each line the Worker writes is
`{event, box, provider}` plus a reason on refusals, and never holds a code or a
token. Cloudflare's own request records (tail, Workers Logs) do show each
request URL, so a `/callback` URL with its one-time code appears there. That
code has already been redeemed, with its PKCE verifier, by the time it can be
read, so it is useless, but keep those logs to the operator account.
