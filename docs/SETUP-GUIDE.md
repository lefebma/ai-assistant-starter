# AI Assistant Setup Guide

This guide walks you through setting up your personal AI assistant powered by Claude Code. By the end, you'll have a persistent assistant connected to your preferred messaging platform, with email, calendar, and custom skills wired in.

## Prerequisites

- macOS (Apple Silicon or Intel)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Node.js 20+ (`brew install node`)
- A messaging platform account (Telegram, Slack, Discord, or Teams)

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

### Teams Setup (via Power Automate or Azure Bot Service)
1. Register a bot in [Azure Bot Service](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Create a Teams app manifest with the bot ID
3. Deploy the bot endpoint (this project's HTTP server handles the webhook)
4. Sideload or publish the app in Teams Admin Center
5. Add to `.env`:
   ```
   TEAMS_APP_ID=your_app_id
   TEAMS_APP_SECRET=your_app_secret
   TEAMS_TENANT_ID=your_tenant_id
   ```

## Step 2: Connect Email

Setup supports up to **two accounts per provider**. Pick "Both" if you have Gmail + Outlook; pick the same provider twice via the "Add a second … account?" prompt if you have two of the same kind.

### Gmail (via gog CLI)
1. Install: `brew install gogcli`
2. Authenticate each account:
   ```
   gog auth add primary@gmail.com --services gmail,calendar
   gog auth add secondary@gmail.com --services gmail,calendar
   ```
3. Grant permissions in the browser when prompted
4. Test: `gog gmail search "newer_than:1d" --account primary@gmail.com`
5. The skill at `skills/gmail/` is pre-configured for the primary address. If you opted into a second account, `skills/gmail-secondary/` is wired to it independently.

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
For non-API email providers, the assistant can use browser automation (Playwright) to read and draft emails through webmail. Slower but works with anything.

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

1. Copy the CLAUDE.md template:
   ```bash
   cp templates/client-assistant/CLAUDE.md.template CLAUDE.md
   ```

2. Fill in the placeholders:
   - `{{ASSISTANT_NAME}}` - Give your assistant a name
   - `{{OWNER_NAME}}` - Your name
   - `{{PLATFORM}}` - Telegram / Slack / Discord / Teams
   - `{{HOST_OS}}` - Mac / Linux / Windows (WSL)
   - `{{PERSONALITY_VIBE}}` - How you want the assistant to communicate
   - `{{TIMEZONE}}` - Your timezone (e.g., America/New_York)
   - `{{OWNER_BIO}}` - A short paragraph about you, your work, your preferences
   - `{{PROJECT_PATH}}` - Where this project lives on disk
   - `{{INSTALLED_SKILLS}}` - Comma-separated list of skill IDs you enabled
   - `{{EMAIL_SIGNATURE}}` - Your professional email signature
   - `{{CUSTOM_RULES}}` - Any personal formatting or behavior rules

3. Review and edit. The template is a starting point. Add sections, remove what doesn't apply.

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
/schedule create "Generate a morning briefing. Check: 1) Weather for [YOUR_CITY]. 2) Today's calendar events. 3) Unread emails needing attention (skip newsletters). 4) Any project updates. Format as a concise daily brief." "0 7 * * *" --name "Morning Briefing"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check `launchctl list \| grep ai-assistant`, look at `/tmp/ai-assistant.log` |
| Email auth expired | Re-run `gog auth add` (Gmail) or `node scripts/ms-auth.js` (Outlook) |
| Scheduled task not firing | Check `sqlite3 store/assistant.db "SELECT * FROM scheduled_tasks"` |
| Bot token conflict | Only one process can poll a Telegram bot token. Kill duplicates. |
| Slow responses | Normal for tool-heavy queries. Simple chat is fast, email+calendar lookups take 10-30s. |

## What's Next

- Add more skills as your workflow evolves
- Set up project tracking with `projects/` folders and `STATE.md` files
- Create custom agents for specialized work (`.claude/agents/`)
- Connect additional tools via MCP servers
- Set up a dashboard for monitoring (optional)
