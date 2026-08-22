# One-Time Secret Link (design, not yet built)

Status: **spec only.** Build this when a client's security policy forbids API
keys transiting the chat platform. The `/secret` chat flow (docs/VAULT.md)
already keeps keys out of the AI model, out of logs, and out of chat history,
but the chat platform's servers still see the message in transit — Telegram
bot chats are not end-to-end encrypted. Some IT departments will reject that.
This is the answer to hand them.

## What it is

A `/secret link OPENAI_API_KEY` command that replies with a short-lived HTTPS
URL. The client opens it in a browser, pastes the key into a form served by
their own assistant box, and submits. The key travels TLS-encrypted from their
browser to their box — never through Telegram, Slack, or any third party
except the tunnel provider (encrypted in transit). The bot confirms in chat
with the masked value, same as the chat flow.

## Flow

1. Client sends `/secret link <NAME>` (primary chat only, same name rules as
   `/secret set`).
2. Bot generates a single-use token: 128 bits from `crypto.randomBytes`,
   stored in memory only as a SHA-256 hash alongside `{name, expiresAt}`.
   TTL 10 minutes.
3. Bot starts an ephemeral tunnel to the existing HTTP server (port 3030):
   `cloudflared tunnel --url http://localhost:3030` — the free, no-account
   mode that prints a random `https://<words>.trycloudflare.com` URL. Parse
   the URL from stderr; fail the command cleanly if `cloudflared` is missing
   (install it in the VPS image via `deploy/` templates).
4. Bot replies with `https://<tunnel-host>/secret/<token>` and the expiry
   time.
5. `GET /secret/<token>`: constant-time hash compare; unknown or expired →
   generic 404 (no oracle for token guessing). Valid → minimal HTML form:
   the secret name shown, one password-type input, a submit button, no
   external assets, `Cache-Control: no-store`, CSP `default-src 'none';
   form-action 'self'`, `autocomplete="off"`.
6. `POST /secret/<token>`: re-check token, consume it (single use — consume
   before validation so a failed submit needs a fresh link), run the same
   provider validation as the chat flow (`src/secrets/validate.ts`), write to
   the vault via `SecretVault.set()`. Respond with a static success/failure
   page containing the masked value only.
7. Tear the tunnel down immediately after the POST (or on expiry, whichever
   comes first). The tunnel process must never outlive the token.
8. Bot sends the same confirmation message to the chat that `/secret set`
   sends, so the audit trail of *that a key changed* (never the value) lives
   in one place.

## Constraints and decisions

- **Reuses everything from the chat flow**: name rules, `KNOWN_SECRET_NAMES`,
  provider validation, masking, vault write. This is a transport, not a new
  secret path — implement it as a second front end on `src/secrets/`.
- **No permanently open port.** Hosted boxes are ufw-locked to SSH only, and
  stay that way. The tunnel is outbound-only and exists for minutes. Do not
  "simplify" this into opening 3030/443 on the box.
- **Why cloudflared and not TLS on the box**: no domain per client, no cert
  management, no inbound firewall change. Trade-off named honestly:
  Cloudflare terminates TLS at their edge, so Cloudflare transiently sees the
  plaintext of the POST, the same class of exposure as Telegram in the chat
  flow but to a different party. For an IT department that rejects chat
  transport but accepts Cloudflare (most that use it as a CDN/WAF already
  do), this is the right trade. If a client rejects Cloudflare too, the
  remaining option is operator-run: the client reads the key over a call
  while the operator uses `vault-cli set` over SSH.
- **Rate limiting**: one active link per chat; a new `/secret link` invalidates
  the previous one. Failed token lookups get a flat 404 and are not logged
  with the attempted token.
- **The token URL is itself a secret in chat** — but a short-lived, single-use
  one that grants only the ability to *write* one named key, never to read
  anything. That is the whole point of the indirection.
- **Logging**: the HTTP handler must never log bodies. Log only
  `{name, outcome}` at info.

## Effort

Roughly a day: the HTTP routes and form (half), tunnel lifecycle management
including the missing-binary and parse-failure paths (half), plus adding
`cloudflared` to the cloud-init template and a test pass. All the secret
handling already exists and is tested.
