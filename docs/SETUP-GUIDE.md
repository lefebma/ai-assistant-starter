# AI Assistant Setup Guide

This guide walks you through setting up your personal AI assistant powered by Claude Code. By the end, you'll have a persistent assistant connected to your preferred messaging platform, with email, calendar, and custom skills wired in.

## Prerequisites

- macOS (Apple Silicon or Intel), Windows, or Linux
- Node.js 20+ (`brew install node`), unless you are using an installer bundle,
  which brings its own
- **An account with an AI company.** Either a Claude subscription (Pro or Max)
  that you sign in with, or an API key from Anthropic, OpenAI, or Google that
  bills per use. Setup asks which you have. See [Signing in](#signing-in) below.
- A messaging platform account (Telegram, Slack, Discord, or Teams)

You do **not** need to install Claude Code separately. The Claude engine ships
inside this app, and a globally installed `claude` command is a different copy
that the assistant never calls.

## Step 1: Choose Your Platform

| Platform | Setup Complexity | Best For |
|----------|-----------------|----------|
| **Telegram** | Easiest | Solo users, mobile-first, free, no org restrictions |
| **Slack** | Moderate | Teams already on Slack, threaded conversations, enterprise |
| **Discord** | Moderate | Communities, voice channels, casual/creative teams |
| **Teams** | Hardest | Microsoft-centric orgs, Outlook/SharePoint integration |

### Telegram Setup
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts to name your bot
3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. Send a message to your new bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your `chat_id`
5. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_token_here
   ALLOWED_CHAT_ID=your_chat_id_here
   ```

### Slack Setup
1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode (Settings > Socket Mode > Enable)
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `channels:read`, `im:history`, `im:read`, `im:write`
4. Install to workspace, copy Bot User OAuth Token
5. Generate an App-Level Token (Settings > Basic Information > App-Level Tokens) with `connections:write` scope
6. Add to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_APP_TOKEN=xapp-your-token
   SLACK_ALLOWED_USERS=U01234ABCDE
   ```

### Discord Setup
1. Create an application at [discord.com/developers](https://discord.com/developers/applications)
2. Bot tab > Add Bot, copy the token
3. Enable Message Content Intent (Bot tab > Privileged Gateway Intents)
4. Generate invite URL: OAuth2 > URL Generator > scopes: `bot`, permissions: `Send Messages`, `Read Message History`
5. Add to `.env`:
   ```
   DISCORD_BOT_TOKEN=your_token_here
   DISCORD_ALLOWED_USERS=your_user_id
   ```

### Teams Setup
Teams delivers messages by HTTPS, so the assistant needs a public address.
On a hosted box this is `sudo node dist/scripts/hosted/enable-teams.js <hostname>` (Caddy on 443);
the full walk-through is in `docs/HOSTED-VPS.md > Teams instead of Telegram`.
A laptop install would need a tunnel and is not supported for Teams yet.

1. Register the bot: `npm run teams-register -- <name> <hostname>` (needs the
   Azure CLI, signed in); add `--tenant <id>` for a single-tenant registration in the firm's own tenant.
   It prints `TEAMS_APP_ID`, `TEAMS_APP_SECRET` and `TEAMS_TENANT_ID`.
2. Add them to `.env` (or paste the secret with `/secret set TEAMS_APP_SECRET`).
3. Build the app package: `npm run teams-manifest -- --app-id <id> --name "<assistant>"`.
4. Upload `deploy/rendered/<slug>-teams.zip` (the assistant name, lowercased, with dashes) in Teams: Apps → Manage your apps → Upload a custom app.
5. Adding the app makes the bot announce your chat id (send `/chatid` to see it again). Put it in
   `ALLOWED_CHAT_ID` and restart.

## Signing in

Your assistant needs an account with an AI company before it can answer
anything. Setup asks which you have and handles it for you. This section is for
doing it by hand, or fixing it later.

**Credentials are per user, per machine.** Signing in on your laptop does
nothing for the computer the assistant actually runs on.

### Option 1: a Claude subscription (Pro or Max)

Run the sign-in from your install folder. A browser opens; sign in with the
account that carries the plan.

```bash
# macOS / Linux
node_modules/@anthropic-ai/claude-agent-sdk-*/claude auth login

# Windows (PowerShell)
Get-ChildItem node_modules\@anthropic-ai\claude-agent-sdk-*\claude.exe | Select-Object -First 1 | ForEach-Object { & $_ auth login }
```

Check it took with `... auth status`. A free Claude account is not enough; the
plan has to be Pro or Max.

### Option 2: an API key, billed per use

No sign-in at all. Put the key in `.env`:

```
AGENT_RUNTIME=ai-sdk
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

For OpenAI or Google, set `AI_PROVIDER` accordingly, use `OPENAI_API_KEY` or
`GOOGLE_API_KEY`, and set `AI_MODEL` explicitly (only Anthropic has a default).

### Confirming it works

```bash
node dist/src/index.js --selftest --live
```

`--live` makes one real model call, which is the only check that proves the
credentials work rather than merely exist. Drop it for a fast offline check.

## Step 1b: Choose Your Model Provider (optional)

Claude on a Claude subscription is the default. To run on OpenAI, Gemini, or a
self-hosted model instead — or to route scheduled work and chat to different
engines — see [PROVIDERS.md](PROVIDERS.md). To keep API keys encrypted at rest,
see [VAULT.md](VAULT.md).

## Step 2: Connect Email

Setup supports up to **two accounts per provider**. Pick "Both" if you have Gmail + Outlook; pick the same provider twice via the "Add a second … account?" prompt if you have two of the same kind.

### Gmail (via gog CLI)

Gmail and Google Calendar are backed by the [gog CLI](https://github.com/openclaw/gogcli). It needs two things a fresh machine does not have: the `gog` binary, and a Google OAuth client of your own.

**1. Install gog**

- With Homebrew: `brew install gogcli`
- Without Homebrew: releases ship as **compressed archives, not a bare binary**,
  so there is an extract step. From the
  [gogcli releases page](https://github.com/openclaw/gogcli/releases), download
  the archive matching your machine:

  | Machine | Asset |
  |---|---|
  | Apple Silicon Mac (`uname -m` says `arm64`) | `gogcli_<version>_darwin_arm64.tar.gz` |
  | Intel Mac (`uname -m` says `x86_64`) | `gogcli_<version>_darwin_amd64.tar.gz` |
  | Linux | `gogcli_<version>_linux_arm64.tar.gz` or `_linux_amd64.tar.gz` |
  | Windows | `gogcli_<version>_windows_amd64.zip` |

  Then, on macOS or Linux:
  ```
  mkdir -p ~/.local/bin
  cd ~/Downloads
  tar -xzf gogcli_*_darwin_arm64.tar.gz        # unpacks a single file: gog
  mv gog ~/.local/bin/gog
  chmod +x ~/.local/bin/gog
  xattr -d com.apple.quarantine ~/.local/bin/gog   # macOS only, clears the "unidentified developer" block
  ~/.local/bin/gog --version                   # confirm before moving on
  ```
  `~/.local/bin/gog` is one of the paths the assistant probes automatically. For any other location, set `GOG_BIN=/path/to/gog` in `.env`.

  Each release also publishes `checksums.txt` if you want to verify the download.

**2. Create a Google OAuth client** (one-time, ~10 minutes, all in the browser)

`gog auth add` fails without this — gog does not ship a shared client. Every
install gets its own client: your own quota, your own revocation switch, and
no dependency on anyone else's project staying alive.

*a. Create a project*

1. Open [Google Cloud Console](https://console.cloud.google.com/) signed in as
   the Google account that should own the app registration (for a managed
   install, the administrator's account is fine — the end user's Gmail does not
   need to own it)
2. Top bar → project picker → **New Project**. Name it after the install
   (e.g. `havn-marina`). No billing account is needed for these APIs
3. When the "project created" notification appears, **select the new project in
   the top bar** — easy to miss, and every step below happens inside it

*b. Enable the two APIs*

4. Left menu → **APIs & Services → Library**
5. Search **Gmail API** → open it → **Enable**
6. Back to the Library, search **Google Calendar API** → **Enable**. Skipping
   this one is the classic miss — Gmail works, then calendar auth fails later
   with a scope error

*c. Configure the consent screen*

7. **APIs & Services → OAuth consent screen** (Google brands this area
   **Google Auth Platform** — click **Get started** on a fresh project)
8. App name: something the user will recognize on the Google sign-in screen
   (e.g. `Havn`); support email and developer contact: your email
9. Audience / user type: **External** — personal `@gmail.com` accounts cannot
   use Internal, which is Workspace-only
10. Scopes: skip — gog requests the scopes it needs at auth time
11. Test users: add each Gmail address you plan to connect. This matters only
    until the app is published in the next step, but the form may insist on at
    least one

*d. Publish the app — do not skip this*

12. On the **Overview** (or **Audience**) page of the consent screen, click
    **Publish app** and confirm. Publishing status must read **In production**
    before you continue

> While the app sits in **Testing**, Google silently expires every refresh
> token after **7 days**: the assistant's Gmail access dies weekly and every
> account has to re-run `gog auth add`. Publishing fixes that permanently. No
> Google verification review is needed for a personal install — the one-time
> "Google hasn't verified this app" screen during sign-in is expected. Click
> **Advanced → Go to \<app name\> (unsafe)** and continue; it never appears
> again for that account.

*e. Create the Desktop client and download its key*

13. **APIs & Services → Credentials** (listed as **Clients** in the Google Auth
    Platform nav) → **Create credentials → OAuth client ID**
14. Application type: **Desktop app**. Any name
15. On the confirmation dialog, click **Download JSON** *now* — Google only
    offers the secret at creation time. Reusing an existing client instead?
    Open it and use **Add secret** to mint a fresh downloadable one; the old
    secret keeps working while both exist

*f. Hand it to gog*

16. `gog auth credentials set ~/Downloads/client_secret_*.json`
    (older gog builds use `gog auth credentials <file>` — check
    `gog auth credentials --help` if the first form errors)
17. Sanity check: `gog auth doctor` — it should report the credentials/config
    present and the keyring opening cleanly

**3. Authenticate each account**
```
gog auth add primary@gmail.com --services gmail,calendar
gog auth add secondary@gmail.com --services gmail,calendar
```

**4. Grant permissions** in the browser when prompted

**5. Test:** `gog gmail search "newer_than:1d" --account primary@gmail.com`

**6.** The skill at `skills/gmail/` is pre-configured for the primary address. If you opted into a second account, `skills/gmail-secondary/` is wired to it independently.

### Outlook / Microsoft 365 (via CLI or MCP)
1. Register an app in [Azure AD App Registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps)
2. Add permissions: `Mail.Read`, `Mail.Send`, `Calendars.Read`, `Calendars.ReadWrite`
3. Generate a client secret
4. Add to `.env`:
   ```
   MS_CLIENT_ID=your_client_id
   MS_CLIENT_SECRET=your_secret
   MS_TENANT_ID=your_tenant_id
   ```
5. Run the auth flow: `node scripts/ms-auth.js`
6. If you opted into a second Outlook account, `skills/outlook-secondary/` is wired to it. Same Azure app + tenant; the auth flow handles both addresses.

### Apple Mail / Other
For non-API email providers, the assistant can use browser automation (Playwright) to read and draft emails through webmail. Slower but works with anything. See [Browser automation](#browser-automation) below.

## Step 3: Connect Calendar

### Google Calendar
Already included with Gmail setup above (gog CLI handles both).
- View today: `gog calendar events --account your.email@gmail.com`
- View range: `gog calendar events --from "2026-01-01T00:00:00" --to "2026-01-01T23:59:59" --account your.email@gmail.com`

### Outlook Calendar
Already included with Microsoft 365 setup above. The Outlook skill handles both email and calendar via the same credentials.

### MCP Calendar Servers
Claude Code also supports Google Calendar and Outlook Calendar via MCP servers. These give richer read/write access (create events, respond to invites). See `claude_desktop_config.json` for MCP server configuration.

## Step 4: Pick Your Starter Skills

Skills are drop-in folders under `skills/`. Each has a `manifest.json` (triggers, priority) and `SKILL.md` (instructions for the AI).

### Ships in the box

All optional except `weather`. Setup prompts you per skill.

| Skill | What it does | What you need |
|-------|-------------|---------------|
| `weather` | Current weather + short forecast | Coordinates (Open-Meteo, no key) |
| `decision-log` | Append-only record of decisions with Why / Alternatives / What-would-change-my-mind | Nothing (always on) |
| `daily-briefing` | Start-of-day summary: weather, triaged email, calendar, loose ends | Nothing (always on) |
| `exec-interview` | 15-20 minute discovery interview that writes your PROFILE.md | Nothing (always on) |
| `gmail` | Gmail + Google Calendar via `gog` CLI | Gmail address(es) |
| `outlook` | M365 email + calendar via Graph | Azure app registration |
| `web-research` | Three-tier Perplexity research | [Perplexity API key](https://www.perplexity.ai/settings/api) |
| `apollo` | Apollo.io company/person/sequence intel | [Apollo API key](https://app.apollo.io/#/settings/integrations/api) |
| `wordsmith` | Delegate prose drafting to Gemini 2.5 | [Google AI Studio key](https://aistudio.google.com/app/apikey) |
| `antilibrary` | LLM-maintained Obsidian knowledge base | Obsidian vault path |
| `notion` | Pages, databases, search via Notion API | [Notion integration token](https://www.notion.so/profile/integrations) |
| `kanbanzone` | Generic Kanban Zone board CLI | Kanban Zone API key (Settings → API) |
| `wordpress` | Drafts-only REST helper (no publish) | Site URL + WP Application Password |

### Per-skill setup notes

**decision-log** — Always installed, no key. Setup creates `decisions/log.md` at the project root. To use it in chat: say "log a decision" or "we decided X" and the assistant drafts an entry, asks one quick question to capture the *why*, and appends to the top of the file. Ask "what did I decide about Y" later to search the history.

**exec-interview** — Always installed, no key. Run it once after setup: say "interview me" or "let's do the discovery interview" and the assistant walks you through your business, your role, the people who matter, your priorities for the next quarter, and how you want to be worked with. It writes what it learns to `PROFILE.md` at the project root, which `CLAUDE.md` imports, so the profile is in front of the assistant on every future turn. `PROFILE.md` is yours: edit it by hand whenever you like, and no update overwrites it. Answers can be voice notes, and you can stop partway and pick it up later.

**apollo** — Setup writes your key to `~/.apollo-api-key` (chmod 600). Test with `bash skills/apollo/apollo-lookup.sh company "Acme Inc"`.

**wordsmith** — Setup adds `GOOGLE_API_KEY=` to your project `.env`. For best results, drop 2-5 real writing samples (recent emails, Slack messages, LinkedIn posts) into `skills/wordsmith/voice-samples/` as plain `.md` files. `wordsmith.sh` reads them automatically and appends them to the voice block as concrete examples — Gemini mirrors real samples far better than abstract style rules. See `skills/wordsmith/voice-samples/README.md` for what makes a good sample.

**antilibrary** — Setup records your vault path in the skill. Open the vault in Obsidian and ask the assistant to "set up the vault" — it will scaffold `wiki/`, `sources/`, and `CLAUDE.md` inside it.

**notion** — Setup writes the integration token to `~/.config/notion/api_key` (chmod 600). After install, share the Notion pages and databases you want the assistant to see with the integration (in Notion: `...` → `Connect to` → pick your integration).

**kanbanzone** — Setup writes API key (and optional default board ID) to `~/.config/kanbanzone/config.json` (chmod 600). Run `python3 skills/kanbanzone/scripts/kz.py list-boards` to discover board IDs.

**wordpress** — Setup writes your Application Password to `~/.config/wordpress/app_password` (chmod 600). Generate one at `<your-site>/wp-admin/profile.php` under "Application Passwords". Skill is drafts-only and refuses to publish.

### Creating Custom Skills
```
skills/my-new-skill/
  manifest.json    # id, name, triggers, priority, enabled
  SKILL.md         # Instructions the AI follows when this skill activates
```

Example `manifest.json`:
```json
{
  "id": "my-new-skill",
  "name": "My Custom Skill",
  "description": "What this skill does",
  "enabled": true,
  "triggers": ["keyword1", "keyword2"],
  "priority": 50
}
```

## Step 5: Configure Your Assistant

1. Copy the templates:
   ```bash
   cp templates/CLAUDE.md.template CLAUDE.md
   cp templates/PERSONALITY.md.template PERSONALITY.md
   ```

2. Fill in the CLAUDE.md placeholders:
   - `{{ASSISTANT_NAME}}` - Give your assistant a name
   - `{{OWNER_NAME}}` - Your name
   - `{{PLATFORM}}` - Telegram / Slack / Discord / Teams
   - `{{HOST_OS}}` - Mac / Linux / Windows (WSL)
   - `{{TIMEZONE}}` - Your timezone (e.g., America/New_York)
   - `{{OWNER_BIO}}` - A short paragraph about you, your work, your preferences
   - `{{PROJECT_PATH}}` - Where this project lives on disk
   - `{{INSTALLED_SKILLS}}` - Comma-separated list of skill IDs you enabled
   - `{{EMAIL_SIGNATURE}}` - Your professional email signature

3. Fill in the PERSONALITY.md placeholders:
   - `{{ASSISTANT_NAME}}` and `{{OWNER_NAME}}` - Same as above
   - `{{PERSONALITY_VIBE}}` - How you want the assistant to communicate
   - `{{CUSTOM_RULES}}` - Any personal formatting or behavior rules

4. Review and edit. The templates are a starting point. Add sections, remove what doesn't apply.

## Customize your assistant's personality

Your assistant's voice lives in `PERSONALITY.md` at the project root — the vibe, the tone, the rules it never breaks. `CLAUDE.md` pulls it in through the `@PERSONALITY.md` line, so the two files work as one document.

Edit `PERSONALITY.md` any time: make the assistant drier, warmer, terser, add rules ("no emojis", "always answer in French"), or rewrite the whole thing. Changes take effect on the next message — no restart needed.

The split exists so your edits survive the product. Re-running `npm run setup` regenerates `CLAUDE.md` (new skills list, platform notes) but only creates `PERSONALITY.md` when it doesn't exist yet. `/update` never touches it either. Once the file is yours, it stays yours.

## Step 6: Set Up the Service

### macOS (launchd)
```bash
# Build
npm install && npm run build

# Create the launchd plist
cat > ~/Library/LaunchAgents/com.ai-assistant.app.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ai-assistant.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>{{PROJECT_PATH}}/dist/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>{{PROJECT_PATH}}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/ai-assistant.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/ai-assistant.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/{{USERNAME}}</string>
  </dict>
</dict>
</plist>
EOF

# Load and start
launchctl load ~/Library/LaunchAgents/com.ai-assistant.app.plist

# Verify
launchctl list | grep ai-assistant
```

### Linux (systemd)
```bash
cat > ~/.config/systemd/user/ai-assistant.service << 'EOF'
[Unit]
Description=AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory={{PROJECT_PATH}}
ExecStart=/usr/bin/node dist/src/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user enable ai-assistant
systemctl --user start ai-assistant
```

### Running on a server instead

The assistant doesn't have to live on your laptop. A small Ubuntu VPS
(provisioned unattended via cloud-init, zero inbound ports, managed over SSH)
is covered end to end in [HOSTED-VPS.md](HOSTED-VPS.md) — provider choices,
`npm run make-cloud-init`, and the interactive finishing steps.

## Step 7: First Conversation

Once the service is running, message your bot:

1. **"Hello"** - Verify the bot responds with its personality
2. **"What's the weather?"** - Test the weather skill
3. **"Check my email"** - Test email integration
4. **"What's on my calendar today?"** - Test calendar integration
5. **"/schedule create 'Good morning! Here is your daily briefing.' '0 7 * * *' --name 'Morning Briefing'"** - Set up your first scheduled task

## Step 8: Morning Briefing (Recommended)

The most valuable scheduled task. Create it with a prompt like:

```
/schedule create "Generate a morning briefing. Check: 1) Weather for [YOUR_CITY]. 2) Calendar: FIRST run date '+%A %Y-%m-%d' to get today. Then run: for i in 0 1 2 3 4 5 6; do date -v+${i}d '+%Y-%m-%d %a'; done -- this lookup table is the ONLY source of truth for day names (never compute day-of-week in your head). Pull events for the next 7 days and look up each date in the table for the correct day name. 3) Unread emails needing attention (skip newsletters). 4) Any project updates. Format as a concise daily brief." "0 7 * * *" --name "Morning Briefing"
```

> **Why the lookup table?** LLMs reliably get day-of-week wrong for dates more than 2-3 days out. The `date` command generates the correct mapping and the LLM just reads it.

## Browser automation

For anything with no API behind it: webmail, a supplier portal, a booking form, a site you have to be logged in to.

Setup wires this up for you. It registers the Playwright browser tools in `.mcp.json` and offers to download the browser they drive (about 150 MB, one time). If you skipped that download, it happens on first use instead, which makes that one request slow.

Two ways it can run:

**Its own browser** (the default). Nothing to do. The assistant opens a clean browser it controls, with no access to your logins. Right for public pages and for anything you would rather it did in a sandbox.

**Your Chrome, with your sessions.** Start it first:

```
/browser start
```

That launches Chrome with remote control enabled, under a separate profile, and the assistant attaches to it automatically. Add `--default` to use your real profile instead, so it inherits the accounts you are already signed in to. That is the point of the option and also the reason to be deliberate about it: anything you are logged in to, it can reach.

Other commands: `/browser status` shows whether it is running and what tabs are open, `/browser stop` shuts it down.

Chrome has to be installed for `/browser start` to do anything. `/browser status` tells you when it is missing. The assistant's own browser works either way.

**Already installed before this shipped?** Just run `/update`. It registers the browser tools for you, merging them into any configuration you already have rather than replacing it. Nothing else to do, and no terminal needed.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Installed fine, but never replies | Run `node dist/src/index.js --selftest --live`. If `credentials` fails, see [Signing in](#signing-in) |
| Bot not responding | Check `launchctl list \| grep ai-assistant`, look at `/tmp/ai-assistant.log` |
| Email auth expired | Re-run `gog auth add` (Gmail) or `node scripts/ms-auth.js` (Outlook) |
| Gmail works, Calendar 403s with `accessNotConfigured` | The OAuth client's GCP project has the Gmail API enabled but not the Calendar API. Cloud Console → APIs & Services → Library → Google Calendar API → Enable, wait ~1-2 min. No re-auth needed. |
| Scheduled task not firing | Check `sqlite3 store/assistant.db "SELECT * FROM scheduled_tasks"` |
| Bot token conflict | Only one process can poll a Telegram bot token. Kill duplicates. |
| Slow responses | Normal for tool-heavy queries. Simple chat is fast, email+calendar lookups take 10-30s. |
| App crashes on startup (missing module) | The `/update` command only works if the app can start. See [Manual update](#manual-update) below. |
| `/update` returns "GitHub returned 404" | The install points at a private fork. Add `GITHUB_TOKEN` to your `.env` with a fine-grained PAT that has Contents read access on it. The public repo needs no token. |

### Manual update

When the app cannot start (e.g. a missing dependency crashes Node on launch), the in-app `/update` command is unreachable. Update manually instead:

1. Download the tarball for your platform from the GitHub release (or from wherever your installer sent it).
2. Stop the service:

   **macOS:** `launchctl bootout gui/$(id -u)/com.ai-assistant.service`
   **Linux:** `systemctl --user stop ai-assistant`
   **Windows:** `.\runtime\node.exe .\dist\scripts\service.js stop`

3. Extract the **app/** subtree from the tarball into your install directory. The tarball contains two top-level directories (`app/` and `runtime/`); you usually only need `app/`:

   **macOS / Linux:**
   ```
   tar -xzf ai-assistant-v*.tar.gz --strip-components=1 -C /path/to/install "./app/"
   ```

   **Windows (PowerShell):** Windows `tar` handles `--strip-components` and path filters inconsistently. Extract to a temp folder first, then copy:
   ```powershell
   mkdir $env:TEMP\havn-update
   tar -xzf "$env:USERPROFILE\Downloads\ai-assistant-v1.15.0-win32-x64.tar.gz" -C $env:TEMP\havn-update
   Copy-Item "$env:TEMP\havn-update\app\*" -Destination C:\Users\you\havn -Recurse -Force
   ```

4. Verify: `type VERSION` (or `cat VERSION`) should show the new version.
5. Test: run the app directly to confirm it starts without errors:

   ```
   ./runtime/node dist/src/index.js        # macOS/Linux
   .\runtime\node.exe .\dist\src\index.js   # Windows
   ```

6. Start the service again (reverse of step 2, or `.\runtime\node.exe .\dist\scripts\service.js start` on Windows).

Your `.env`, `skills/`, and `store/` are preserved because the tarball does not contain those files.

### Still stuck? Send a support request

Tell the bot `/support <what went wrong>` (or a bare `/support`, then describe the
problem when prompted). It drafts a support email from your description plus
auto-collected diagnostics — app version, OS and Node versions, enabled skill ids,
and a redacted excerpt of recent error-level log lines. It never includes your
`.env`, API keys, email addresses from logs, or message content, and nothing is
sent until you confirm with the Send button.

The destination is `SUPPORT_EMAIL` in `.env` (default `support@els-partners.com`),
sent through your connected Gmail account via `gog`. If no email account is
connected, the request is saved under `support-requests/` in the install folder so
you can send it manually.

## What's Next

- Add more skills as your workflow evolves
- Set up project tracking with `projects/` folders and `STATE.md` files
- Create custom agents for specialized work (`.claude/agents/`)
- Connect additional tools via MCP servers
- Set up a dashboard for monitoring (optional)
