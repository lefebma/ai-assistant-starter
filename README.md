# AI Assistant Starter

A personal AI assistant powered by Claude Code. Connects to Telegram (or Slack, Discord, Teams), reads your email and calendar, runs scheduled tasks, and learns your preferences over time.

Built and maintained by [ELS Partners](https://www.els-partners.com).

## What You Get

- A persistent AI assistant on your phone (via Telegram or other platform)
- Email and calendar awareness (Gmail, Outlook, or both)
- Scheduled tasks (morning briefing, reminders, monitoring)
- Drop-in skills system (weather, CRM, project management, custom)
- Voice message support (send voice notes, get voice replies)
- Memory that persists across conversations
- Browser automation for web tasks

## Quick Start

### Prerequisites

- macOS with [Homebrew](https://brew.sh)
- Node.js 20+ (`brew install node`)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated

### 1. Clone and set up

```bash
git clone https://github.com/lefebma/ai-assistant-starter.git my-assistant
cd my-assistant
./setup.sh
```

The setup wizard asks your name, preferred platform, personality style, email provider, and timezone. It generates your `CLAUDE.md` config and `.env` template.

### 2. Create your bot

**Telegram** (recommended for solo use):
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, pick a name
3. Copy the token into `.env` as `TELEGRAM_BOT_TOKEN`
4. Message your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat ID
5. Add it to `.env` as `ALLOWED_CHAT_ID`

See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for Slack, Discord, and Teams instructions.

### 3. Connect email (optional)

**Gmail:**
```bash
brew install gogcli
gog auth add you@gmail.com --services gmail,calendar
```

**Outlook:** See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md#outlook--microsoft-365-via-cli-or-mcp).

### 4. Build and run

```bash
npm install
npm run build
node dist/src/index.js
```

Message your bot. If it replies, you're live.

### 5. Make it persistent

```bash
# macOS: create a launchd service so it runs on boot
# See docs/SETUP-GUIDE.md Step 6 for the plist template
```

## First Things to Try

1. **"Hello"** - verify personality
2. **"What's the weather?"** - test weather skill
3. **"Check my email"** - test email (if connected)
4. **Set up a morning briefing:**
   ```
   /schedule create "Morning briefing: weather, calendar, urgent emails" "0 7 * * *" --name "Morning Briefing"
   ```

## Project Structure

```
CLAUDE.md              # Your assistant's personality, rules, and context
.env                   # Credentials (never committed)
skills/                # Drop-in skill folders (manifest.json + SKILL.md)
projects/              # Project state tracking (STATE.md files)
src/                   # Engine (TypeScript)
store/                 # SQLite database (auto-created)
seed-jobs.example.json # Example scheduled tasks
```

## Adding Skills

Drop a folder into `skills/` with two files:

```
skills/my-skill/
  manifest.json    # triggers, priority, enabled flag
  SKILL.md         # instructions the AI follows
```

Tell your bot `/skill reload` to pick it up.

## Support

Setup assistance and custom skill development available from ELS Partners.
Contact: marc.l@els-partners.com

## License

Private. Provided under client agreement with ELS Partners.
