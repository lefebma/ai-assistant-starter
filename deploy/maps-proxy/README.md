# havn-maps: the Google Maps proxy for hosted boxes

Hosted boxes get travel times (cards #260, #261) through this Worker instead
of holding a Google key themselves (card #266, decided in spike #264). The
Google Maps Platform key is a Worker secret and never reaches a box, so it
cannot leak from one.

- Three calls, nothing else: geocode, route (Routes API `computeRoutes`,
  `TRAFFIC_AWARE` with a departure time for driving; transit and walking too)
  and place search (Places Text Search). Any other path is a 404.
- One Durable Object per box. It holds the box's token hash, its monthly
  request quota, its requests and cost per UTC month, and its geocode cache.
  Because the cache lives inside the box's own object, one box can never be
  answered from another box's lookups.
- Geocodes are cached for at most 30 days (Google's limit for stored
  coordinates). A cached answer is free and does not count toward the quota.
  A daily cron (08:00 UTC) drops anything older.
- Every call that goes to Google counts toward the quota, answered or not, so
  a loop on one box stops at its quota even while Google is failing. Over
  quota, the Worker answers 429 `over_quota` and the box says "travel time not
  available".
- Cost uses the list prices in `src/maps/pricing.ts` (Routes Pro $10, Geocoding
  $5, Places Text Search Pro $32 per 1,000), counted only when Google answered.
  Transit and walking routes are counted at the Pro rate, so the record never
  comes in under the bill. Free monthly allowances are ignored for the same
  reason.
- Logs: one JSON line per request with box, call, status and cost. Never an
  address, place name, route endpoint or Google's reply.
- Box tokens are stored hashed. Revoking one box removes its token and
  touches nothing else.

Cost to run: the Workers free tier covers it. Google bills PM Tech's Google
Cloud billing account.

## Google Cloud console (once)

1. In the Havn project on PM Tech's billing account, enable **Routes API**,
   **Geocoding API** and **Places API (New)**.
2. Credentials > Create credentials > API key. Under **API restrictions**
   choose "Restrict key" and tick only those three APIs. Leave application
   restrictions at "None" (Workers have no fixed IP).
3. As a backstop against a runaway bill, set a daily cap on each API:
   APIs & Services > the API > Quotas > requests per day. Something like
   2,000 routes, 2,000 geocodes and 500 place searches a day suits the first
   few dozen boxes; raise them as boxes are added.
4. Optionally add a budget alert on the billing account.

The key goes straight into the Worker secret below. Do not save it in a file
or a box.

## Deploy (once, from your machine)

```bash
cd deploy/maps-proxy
npx wrangler@4 deploy
npx wrangler@4 secret put GOOGLE_MAPS_API_KEY     # paste the key when asked
```

Make an admin token, keep it in your own secrets store, and give the Worker
only its hash:

```bash
ADMIN=$(openssl rand -hex 32)          # store this somewhere safe
printf %s "$ADMIN" | shasum -a 256 | cut -d' ' -f1 | npx wrangler@4 secret put ADMIN_TOKEN_SHA256
```

`DEFAULT_MONTHLY_REQUESTS` in `wrangler.toml` (1000) is what a box gets until
you set its own. A typical user makes about 190 calls a month, a heavy one
about 660.

To rotate the Google key, create a new restricted key, `secret put` it, then
delete the old key in the console. Boxes notice nothing.

## Connect, revoke, set a quota

```bash
export HAVN_MAPS_URL=https://havn-maps.<subdomain>.workers.dev
export HAVN_MAPS_ADMIN_TOKEN=$ADMIN
npm run maps-token -- issue havn-leif 66.55.159.70
npm run maps-token -- revoke havn-leif
npm run maps-token -- quota havn-leif 2000
npm run maps-token -- usage            # this month; or usage 2026-11
```

`issue` makes a new token (any earlier one for that box stops working, and a
revoke is lifted), then over SSH as havn stores it in the box's vault as
`MAPS_PROXY_TOKEN` and writes `MAPS_PROXY_URL` to its `.env`. The token
travels on stdin, never on a command line. `npm run provision` does the same
for a new box when both variables are set. No restart is needed.

`revoke` stops that box at once; its usage record stays. Box names follow the
audit witness rule: lowercase letters, digits and dashes (`havn-leif`).

## What the box does with it

`src/maps/client.ts` is the box side: `geocode(text)`, `route({origin,
destination, departAt, mode})` and `placeSearch(text)`, each returning a
result or a reason (`not_configured`, `unauthorized`, `over_quota`,
`timeout`, `upstream`, `not_found`, `bad_request`), never a throw, within 5
seconds. The Worker gives up on Google after 4 seconds so its answer arrives
first. Each call's cost is added to the box's `ai-usage.json`, so maps count
toward the monthly allowance and the operator's spend line. Messages built
from these results credit Google Maps (`client.attribution`).

A self-installed assistant does not use this Worker: the owner adds their own
key with `/secret set GOOGLE_MAPS_API_KEY` and the same client calls Google
directly.

## Changing the Worker

Run `npx tsc -p deploy/maps-proxy/tsconfig.json` to typecheck it. The tests
(`tests/maps-proxy.test.ts`) run the real Worker code against an in-memory
stand-in for Durable Objects and a fake Google.
