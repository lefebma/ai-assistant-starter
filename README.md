# AI Assistant Starter

A personal AI assistant powered by Claude Code. Connects to Telegram (or Slack, Discord, Teams), reads your email and calendar, runs scheduled tasks, and learns your preferences over time.

Built and maintained by [ELS Partners](https://www.els-partners.com).

## What You Get

- A persistent AI assistant on your phone (via Telegram or other platform)
- Email and calendar awareness (Gmail, Outlook, or both — up to 2 of each)
- Scheduled tasks (morning briefing, reminders, monitoring)
- Drop-in skills system — see the matrix below
- Voice message support (send voice notes, get voice replies)
- Memory that persists across conversations
- Browser automation for web tasks

### Skill matrix

Ships with these skills. The always-on ones need no key and no decision at setup; the rest are opt-in:

| Skill | What it does | What you need |
|---|---|---|
| **weather** | Current conditions + short forecast | Coordinates (setup asks) |
| **decision-log** | Append-only record of decisions — captures Why, Alternatives, What would change my mind | Nothing (always on) |
| **gmail** | Read inbox, search, calendar via `gog` CLI | Gmail address (up to 2 accounts) |
| **outlook** | M365 email + calendar via Microsoft Graph | Azure app registration (up to 2 accounts) |
| **web-research** | Three-tier Perplexity research with citations | Perplexity API key |
| **apollo** | Apollo.io lookups + sequence reports | Apollo API key |
| **wordsmith** | Drafts prose in a focused writing call on your configured provider | Nothing (always on) |
| **antilibrary** | LLM-maintained Obsidian knowledge base | Obsidian vault path |
| **notion** | Read/search/create pages and databases | Notion integration token |
| **kanbanzone** | Generic Kanban Zone board CLI | Kanban Zone API key |
| **wordpress** | Drafts-only WP REST helper (no publish) | Site URL + Application Password |

Adding more is one folder away — see [Adding Skills](#adding-skills).

## Quick Start

Open **Terminal** (search for it in Spotlight) and run each step below.

### Step 1: Install Homebrew (if you don't have it)

Homebrew is a package manager for macOS. Most Macs don't have it pre-installed.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the on-screen instructions. When it finishes, it may tell you to run two commands to add brew to your PATH. **Run those commands.** Then close and reopen Terminal.

Verify it worked:
```bash
brew --version
```

### Step 2: Install Node.js and Claude Code

```bash
brew install node
npm install -g @anthropic-ai/claude-code
```

Verify:
```bash
node --version    # should show v20 or higher
claude --version  # should show the Claude CLI version
```

### Step 3: Download and set up

Download the project from GitHub (no account needed):

```bash
curl -L https://github.com/lefebma/ai-assistant-starter/archive/refs/heads/main.zip -o assistant.zip
unzip assistant.zip
mv ai-assistant-starter-main my-assistant
cd my-assistant
npm install
npm run setup
```

The setup wizard asks your name, assistant personality, walks you through Telegram bot creation, and optionally installs a background service.

### Step 4: Create your Telegram bot

1. Open Telegram on your phone, search for **@BotFather**
2. Send `/newbot` and follow the prompts to name your bot
3. Copy the token it gives you (the setup wizard will ask for it)
4. After setup, message your bot and send `/chatid`
5. Open `.env` in any text editor and paste your chat ID into `ALLOWED_CHAT_ID=""`

To edit `.env` from Terminal:
```bash
open -a TextEdit .env
```

### Step 5: Run

If you skipped the background service during setup:

```bash
npm start
```

Message your bot on Telegram. If it replies, you're live.

### Optional: Connect email

See [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md) for Gmail and Outlook setup.

### Optional: Run it on OpenAI, Gemini, or your own models

Claude on a Claude subscription is the default, but the engine is
provider-agnostic. See [docs/PROVIDERS.md](docs/PROVIDERS.md) for BYOK setup
(OpenAI, Google, self-hosted via any OpenAI-compatible endpoint), per-lane
engine routing, model certification, and usage reporting. Keep your API keys
in the encrypted vault: [docs/VAULT.md](docs/VAULT.md).

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
scripts/gmail-cleanup.ts # Zero-cost Gmail cleanup (replaces the LLM seed job)
```

## Adding Skills

Drop a folder into `skills/` with two files:

```
skills/my-skill/
  manifest.json    # triggers, priority, enabled flag
  SKILL.md         # instructions the AI follows
```

Tell your bot `/skill reload` to pick it up.

## Updating

Your assistant checks for updates automatically and includes the status in morning briefings.

To check manually:
```
/update
```

To apply an available update:
```
/update apply
```

Updates replace the engine code (`src/`, `package.json`, etc.) while preserving your files (`.env`, `CLAUDE.md`, `skills/`, `projects/`, `store/`). The service needs a restart after updating.

You can also check your current version with `/version`.

## Support

Setup assistance and custom skill development available from ELS Partners.
Contact: marc.l@els-partners.com

## License

Private. Provided under client agreement with ELS Partners.
