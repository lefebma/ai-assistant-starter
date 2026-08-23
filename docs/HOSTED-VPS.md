# Hosted Havn: one VPS per client

This is the consultant-side runbook for running a client's Havn on a small
dedicated Ubuntu 24.04 server instead of their laptop. One client, one VPS,
managed by you. The box is provisioned unattended by cloud-init; the only
hands-on part is the interactive first-run setup over SSH.

What the client gets: an assistant that is always on, never sleeps with the
laptop lid, and never competes with their other software. What you get: a
machine you can snapshot, rebuild, and reach without touching their hardware.

## Security posture

- **All traffic is outbound.** Telegram long-polling, the Anthropic API, and
  Google APIs are all outbound HTTPS. Nothing on the internet needs to reach
  this box, so ufw denies **all** inbound traffic.
- **The app's local HTTP port stays closed.** The assistant opens one HTTP
  port (default 3030, voice/cockpit). The firewall never exposes it; with
  Tailscale you can still reach it privately over the tailnet if a client
  wants the voice interface.
- **Teams is the one exception to "nothing inbound."** Microsoft delivers
  Teams messages by HTTPS POST, so a Teams install runs Caddy on 443 (and 80
  for the certificate challenge) proxying exactly one path,
  `/api/teams/*`, to the app. Every request on it must carry a Bot Framework
  token signed for this bot's app id; everything else on 443 is a 404. See
  "Teams instead of Telegram" below.
- **SSH is key-only** (`ssh_pwauth: false`), and exists in one of two modes:
  - **Without Tailscale:** ufw allows inbound SSH (key-only) so you can log in.
  - **With Tailscale:** inbound SSH is closed too — zero open ports. You SSH
    over the tailnet (`tailscale up --ssh` is baked in).
- **One login on the box:** the `havn` user, which owns the install and runs
  the service. The image's default `ubuntu` user is not created.
- **unattended-upgrades** keeps the OS patched without anyone logging in.
- **No GitHub credential on the box.** The repo is public, so the clone is
  anonymous. If you deploy a private fork and give the generator a deploy
  token, it rides only in the clone URL and the remote is reset right after,
  so it never persists in `.git/config`; it does remain in the cloud-init
  user-data on the box (root-readable: `/var/lib/cloud/`), so make it
  fine-grained, read-only, and expiring.

## Pick a provider

Any provider that takes cloud-init user-data works. Recommendations:

| Provider | Plan | Region | Why |
|---|---|---|---|
| **Hetzner** | CAX11 (2 vCPU ARM, 4 GB) | Falkenstein/Nuremberg/Helsinki | Cheapest solid option by a wide margin. EU only — fine when residency doesn't matter. |
| **OVH** | b2-7 or d2-4 (Public Cloud) | **Beauharnois (BHS)** | Canadian data residency, for clients who care where their data sleeps. |
| **DigitalOcean** | s-1vcpu-2gb | Toronto (tor1) | Canadian region, best tooling/docs, slightly dearer. |
| **Vultr** | vc2-1c-2gb | Toronto (yto) | Canadian region, cheap, fine. |

Sizing: **2 GB RAM minimum.** `npm ci` plus the TypeScript build is the
heaviest thing the box ever does; 1 GB machines OOM there. Disk: 25 GB is
plenty. ARM (Hetzner CAX) is fine — Node 22, better-sqlite3, and gog all ship
arm64 builds; the provisioner picks the right gog asset from `dpkg
--print-architecture`.

## Before you start, collect

1. **Your SSH public key** (`~/.ssh/id_ed25519.pub`).
2. **Optional: a GitHub deploy token**, only if you deploy a private fork.
   Fine-grained PAT on that repo, **Contents: read-only**, expiry set; it is
   only used at provision time. The public repo needs nothing.
3. **Optional: a Tailscale auth key** (admin console → Settings → Keys).
   Pre-authorized, not ephemeral (the server should survive key GC), ideally
   tagged (e.g. `tag:havn`) so ACLs can scope it.

## Generate the user-data

Secrets, when you have any, go in environment variables, never in argv:

```bash
export GITHUB_DEPLOY_TOKEN=<paste, only for a private fork>
export TAILSCALE_AUTH_KEY=<paste, only if using --tailscale>

npm run make-cloud-init -- \
  --name havn-marina \
  --timezone America/Toronto \
  --ssh-key ~/.ssh/id_ed25519.pub \
  --tailscale
```

Or keep per-client values in a small JSON file (no secrets in it):

```json
{
  "hostName": "havn-marina",
  "timezone": "America/Toronto",
  "sshPublicKeyFile": "~/.ssh/id_ed25519.pub",
  "tailscale": true,
  "gitRef": "main"
}
```

```bash
npm run make-cloud-init -- --config clients/marina.json
```

The generator validates everything (hostname shape, IANA timezone, SSH key
format, token shape if given), refuses to emit if any `{{VAR}}` would remain
unfilled, and writes `deploy/rendered/<host>.user-data.yaml` with mode 0600.
That file holds your SSH public key and **any deploy token or Tailscale key
you gave**: the directory is gitignored, and you should delete the file once
the server exists.

It then prints the create command for each provider. It never runs them.

## Create the VPS

Run the printed command for your provider, e.g. Hetzner:

```bash
hcloud server create --name havn-marina --type cax11 --image ubuntu-24.04 \
  --location nbg1 --ssh-key <your-hcloud-key-name> \
  --user-data-from-file deploy/rendered/havn-marina.user-data.yaml
```

For OVH there is no one-liner: create a Public Cloud instance in BHS in the
manager, pick Ubuntu 24.04, and paste the rendered file's contents into the
cloud-init box on the create form.

First boot takes 5–15 minutes (apt upgrade, Node 22 from NodeSource, gog from
its GitHub release, ufw, optional Tailscale, clone, `npm ci`, build). Watch it:

```bash
ssh havn@<ip>            # or: ssh havn@havn-marina over the tailnet
cloud-init status --wait
tail -f /var/log/havn-provision.log
```

When it finishes you'll see the MOTD on login:

```
Havn: provisioned, awaiting first-run setup.
  As the havn user:  cd /home/havn/havn && npm run setup
```

Provisioning leaves the systemd unit **registered but disabled** — the
service has nothing to run on yet. That is the point of the finishing steps.

## If provisioning fails

`cloud-init status --long` says `error` and `/var/log/havn-provision.log` is
the place to look. The MOTD only appears when the script ran to its end, so
no MOTD on login means it stopped early. Two failures the template now guards
against, in case they show up in a different costume:

- **`node --version` prints v18.** The NodeSource installer was piped into
  bash and a child process ate the rest of the script from stdin (debconf's
  "pending kernel upgrade" dialog does this when `package_upgrade` installs a
  newer kernel than the image boots). The template runs the installer from a
  file and fails loudly if Node is not 22.
- **`sudo: Account or password is expired` at the clone step.** Hetzner's
  vendor-data sets and expires a root password; sudo checks the invoking
  user's (root's) account and refuses. The template switches to `havn` with
  `runuser`, whose PAM stack has no account phase.

Fix the template, then rebuild rather than repair: regenerate the user-data,
`hcloud server delete <name>`, and run the create command again. Ten minutes,
and it proves the fix instead of leaving a hand-patched box behind.

## Finishing steps (interactive, over SSH)

The wizard and the credential flows are interactive by design; budget 20–30
minutes the first time. All as the `havn` user:

### 1. Run the setup wizard

```bash
cd /home/havn/havn
npm run setup
```

Answer the questions (owner, personality, platform token, skills) as on any
install. Two VPS-specific notes:

- The Telegram bot token and chat id go in during the wizard or into `.env`
  after — either way, the bot polls outbound; nothing needs to be exposed.
- If the wizard offers to install a background service, **decline it**: the
  box already has the system-wide `havn.service`, and the wizard's user-level
  unit would fight it. (Exact prompt wording: confirm during pilot.)

### 2. Sign in to Claude — *verify during pilot*

There is no browser on the box, so the standard `auth login` flow needs a
detour. Two candidate paths, **neither yet proven on a headless Havn VPS**:

- **Token flow (preferred):** run the bundled engine's token generator on any
  machine with a browser (your Mac is fine, from any Havn checkout):

  ```bash
  node_modules/@anthropic-ai/claude-agent-sdk-*/claude setup-token
  ```

  Sign in as the account carrying the client's Pro/Max plan, then put the
  resulting token in the VPS's `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`. The
  systemd unit exports `.env` into the service environment, which is how the
  engine should pick it up. *Pilot check: confirm the engine honours the token
  from `.env` on this box (`--selftest --live` below proves it either way).*

- **URL-paste flow:** some CLI versions print a sign-in URL you can open on
  another device and paste the code back into the SSH session. *Pilot check:
  see whether the bundled binary offers this.*

Fallback that definitely works today: an Anthropic **API key** in `.env`
(`AGENT_RUNTIME=ai-sdk`, `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...`),
billed per use. See `docs/SETUP-GUIDE.md > Signing in`.

### 3. Connect Gmail with gog

`gog` is already installed at `/usr/local/bin/gog`. Confirmed end-to-end on
havn-test (178.156.205.93) on 2026-08-23. Two headless wrinkles, both solved:

- **Keyring.** Headless Linux has no Secret Service, so gog's default token
  store won't open. Switch to the file backend:

  ```bash
  gog config set keyring_backend file
  ```

  (That's a config key, not a CLI flag.) File-backend tokens are encrypted
  with `GOG_KEYRING_PASSWORD`. Put it in `.env` — systemd's `EnvironmentFile`
  picks it up for the service automatically — but it must **also** be
  exported by hand in any interactive SSH session, since `.env` isn't
  auto-sourced by a plain shell:

  ```bash
  export GOG_KEYRING_PASSWORD=<same value as in .env>
  ```

  Skip that and `gog auth doctor` fails with `GOG_KEYRING_PASSWORD is not set
  in a non-interactive process`.

- **OAuth without a browser.** Use gog's built-in remote flow — no listener,
  no open port needed, which fits these boxes better than SSH port-forwarding
  the callback (ufw denies all inbound, remember):

  ```bash
  gog auth add you@gmail.com --services gmail,calendar --remote --step 1
  ```

  This prints an `auth_url`. Open it in a local browser, complete consent,
  then copy the (broken) `127.0.0.1:...` redirect URL from the browser's
  address bar and finish the flow:

  ```bash
  gog auth add you@gmail.com --services gmail,calendar --remote --step 2 \
    --auth-url '<full redirect URL>'
  ```

  **The `--auth-url` value must be single-quoted.** It contains unescaped
  `&`, which bash reads as background-job separators — paste it unquoted and
  the command silently receives only the fragment before the first `&` (no
  `code=` param), while the discarded remainder shows up as bogus background
  "commands". Don't try to fix a parse error by stripping `http://` or the
  host either — that makes it worse: Go's URL parser then rejects it with
  `first path segment cannot contain colon`. OAuth codes are single-use and
  short-lived, so after a couple of mangled attempts don't try to salvage
  one — rerun `--step 1` for a fresh code and do `--step 2` once, correctly
  quoted.

**Common follow-on failure:** Gmail works but Calendar 403s with
`accessNotConfigured`. Cause: the OAuth client's GCP project has the Gmail
API enabled but not the Calendar API. Fix in Cloud Console → **APIs &
Services → Library → Google Calendar API → Enable**, wait ~1-2 minutes, no
re-auth needed.

The Google OAuth client setup itself (Cloud Console, consent screen,
publish-to-production) is unchanged from `docs/SETUP-GUIDE.md > Gmail` and
happens in your browser, not on the box.

### 4. Verify, then start the service

```bash
node dist/src/index.js --selftest --live   # one real model call; proves credentials
sudo systemctl enable --now havn
systemctl status havn
journalctl -u havn -f                      # or: tail -f /home/havn/havn/logs/service.log
```

Message the bot. Say hello.

## Tailscale mode, day two

With Tailscale baked in, the box appears in your admin console under the
client's hostname. `ssh havn@havn-marina` works from any of your devices on
the tailnet (Tailscale SSH — no keys to manage per-box), and the public
internet sees a machine with zero open ports. If you skipped Tailscale at
provision time you can add it later: install per tailscale.com/download, then
`sudo tailscale up --ssh`, then close the SSH hole with
`sudo ufw delete allow OpenSSH`.

## Teams instead of Telegram

One Azure Bot per install, like one BotFather bot per install. Do this after
the box is provisioned and `npm run setup` has run (choose Teams there, leave
the credentials blank).

1. **Expose the webhook.** On the box, as root:

   ```bash
   sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <ip-with-dashes>.sslip.io
   ```

   Use the box's public IP with dots replaced by dashes (`5.161.197.79` →
   `5-161-197-79.sslip.io`), or a subdomain you control that points at the IP.
   It prints the messaging endpoint.

2. **Register the bot.** On your machine, signed in to `az` with an account
   that can create app registrations and Azure Bot resources:

   ```bash
   npm run teams-register -- <name> <hostname>                # in the tenant az is signed in to
   npm run teams-register -- <name> <hostname> --tenant <id>  # a specific tenant
   ```

   Bots are single-tenant (Azure no longer creates multi-tenant ones), so
   the app installs only in the tenant it is registered in. For a firm that
   wants the bot in its own Microsoft 365 tenant, register it there: sign in
   with an account that can create app registrations in that tenant, or pass
   `--tenant`. It prints the lines for the box's `.env`: `TEAMS_APP_ID`,
   `TEAMS_APP_SECRET`, and `TEAMS_TENANT_ID`. Paste them in (or use `/secret set`
   for the secret once the bot is up), then `sudo systemctl restart havn`.
   The secret expires in 24 months; note the date next to the box in your
   records, as with the Claude token.

3. **Build the Teams app package.** On your machine:

   ```bash
   npm run teams-manifest -- --app-id <TEAMS_APP_ID> --name "<assistant name>"
   ```

   Writes `deploy/rendered/<slug>-teams.zip` (the assistant name, lowercased, with dashes).

4. **Install it in Teams.** The user opens Teams → Apps → Manage your apps →
   Upload an app → Upload a custom app, picks the zip, and opens the chat.
   If the tenant blocks custom uploads, their Teams admin publishes the same
   zip to the org catalog (Teams admin center → Teams apps → Manage apps →
   Upload new app) and the user installs it from there.

5. **Claim the chat.** Adding the app makes the bot announce the chat id (the adapter treats the install event as `/chatid`; sending `/chatid` shows it again). Put that id in
   `ALLOWED_CHAT_ID` in `.env` and restart the service.

What works: text with Markdown, typing indicator, streaming replies,
approval buttons, and files and images sent to the assistant. Voice: Teams
offers no voice-memo mic in bot chats (a product limitation, not policy), so
tell users to dictate with the keyboard mic and send text. An audio file
shared into the chat does get transcribed (needs OPENAI_API_KEY), but
getting a recording into Teams is clunky enough that dictation is the story
to sell. What does not, yet: the assistant replying with voice (Teams has no
bot voice bubble), sending files back (it says where it saved them), group
chats and channels.

## Updates, snapshots, backups

- **OS:** unattended-upgrades applies security patches automatically. Kernel
  updates still want an occasional reboot: `sudo reboot` in a quiet moment;
  the service starts on boot once enabled.
- **App:** the `/update` command works as on any install; the repo is public,
  so no token is involved (a private fork would need a fine-grained PAT with
  Contents: read in `.env` as `GITHUB_TOKEN`). After "Updated ... Restart the
  service to activate", restart over SSH: `sudo systemctl restart havn`.
  Manual equivalent: `git pull && npm ci && npm run build && sudo systemctl
  restart havn`. **Boxes provisioned before 2026-08-23** run an updater that
  prunes its own build tools (`npm install --production`, then `tsc: not
  found`); do the manual update once to get past it, after which `/update`
  works.
- **Snapshot before app updates.** Every provider above does whole-disk
  snapshots (Hetzner/DO/Vultr one click or one CLI call; OVH via the manager).
  A snapshot taken while the service runs is fine for this workload — SQLite
  is crash-safe — but `sudo systemctl stop havn` first makes it perfect.
- **What actually needs backing up** if you'd rather not pay for snapshots:
  `.env`, `PERSONALITY.md`, `CLAUDE.md`, `store/` (SQLite), `skills/`,
  `decisions/`, and gog's config/token store in the havn user's home. A tar of
  those restores onto a freshly provisioned box.
- **Remember snapshots contain secrets** (`.env`, tokens). Provider-account
  security is part of the client's security.

## Rebuild from scratch

The whole point of cloud-init: destroy the server, re-run the create command
with a freshly generated user-data, restore the backup over the fresh install, `sudo systemctl enable --now havn`.
Twenty minutes, no archaeology.
