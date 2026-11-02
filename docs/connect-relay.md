# Sign-in relay and /connect (card #206)

Status: relay and box built and tested with fakes; the Worker bundles. Not live: the relay is not deployed, its `/callback` is not yet registered on the Google and Microsoft apps, and Gmail tokens are not yet used by the Gmail tools (see below).

Relay (`src/connect/relay.ts`, packaged as a Worker in `deploy/connect-relay/`, at connect.gethavn.ai): `GET /start` mints a signed single-use 10-minute state naming the box and redirects with a PKCE challenge; `GET /callback` verifies and spends the state, exchanges the code with the matching verifier, and POSTs the result to the registered https origin of that box, signed with that box's hand-off key. The verifier is derived from the signing secret, box and nonce, so nothing is kept between the two steps. A Durable Object holds the used-state keys (so a link works once across every copy of the Worker) and the box registry. No token is stored; the log records the fact of a hand-off only. Deploy and box registration: `deploy/connect-relay/README.md`.

Client secrets: Google's lives only in the relay's Worker secrets. Microsoft needs none: the Havn app is a public client, the relay's callback is registered under "Mobile and desktop applications", and PKCE binds the code to the sign-in.

Box (`src/connect/box.ts`): `/connect gmail|outlook` issues a nonce and a link. The hand-off is accepted only with a valid signature, for a nonce this box issued, once, within 10 minutes, for the same provider. Nonces live in memory, so a restart voids links in flight. `/connect remove gmail` and `/connect remove outlook [account]` revoke at the provider, then delete locally (`--local-only` if revocation cannot be reached). Yahoo and iCloud point to `/secret`.

Box config (vault or env): `CONNECT_RELAY_URL` (https), `CONNECT_BOX_ID`, `CONNECT_HANDOFF_KEY` (the key the relay minted at registration). Read once at start, so set them and restart.

Where tokens land:

- **Outlook:** the Microsoft token store (`MS_TOKENS_<account>`, `src/ms/store.ts`), the same entry a device-code sign-in writes. The Outlook tools, `ms-auth status` and the web Connections page use it as is, and the box refreshes it with the public client id.
- **Gmail:** `CONNECT_GMAIL`, which nothing reads yet. A refresh token issued to the relay's Web client can only be refreshed with that client's secret, which the box must not hold. Open decision: the box asks the relay to refresh (the relay becomes a dependency for every Gmail call, about hourly), or the box holds the Web client secret. Until then `/connect gmail` should not be offered to clients.
