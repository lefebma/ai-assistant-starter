# Sign-in relay and /connect (card #206)

Status: built against a fake provider. Not live until the Google and Microsoft apps exist (cards 205, 207).

Relay (`src/connect/relay.ts`, deploy at connect.gethavn.ai): `GET /start` mints a signed single-use 10-minute state naming the box, `GET /callback` verifies it, exchanges the code (client secret lives only here), and POSTs the result to the registered https origin of that box, signed with that box's hand-off key. Stores nothing, logs the fact of a hand-off only.

Box (`src/connect/box.ts`): `/connect gmail|outlook` issues a nonce and a link. The hand-off is accepted only with a valid signature, for a nonce this box issued, once, within 10 minutes, for the same provider. `/connect remove <p>` revokes at the provider, then deletes locally (`--local-only` if revocation cannot be reached). Yahoo and iCloud point to `/secret`.

Box config (vault or env): `CONNECT_RELAY_URL` (https), `CONNECT_BOX_ID`, `CONNECT_HANDOFF_KEY` (32+ chars, also in the relay's box registry). Tokens land in vault entries `CONNECT_GMAIL` / `CONNECT_OUTLOOK`; wiring the mail and calendar tools to read them is a follow-up.
