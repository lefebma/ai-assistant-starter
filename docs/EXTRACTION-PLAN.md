# Starter Repo Extraction Plan

**Goal:** Extract ClaudeClaw into a clean, client-deployable `ai-assistant-starter` repo. ClaudeClaw remains Marc's personal fork. New client engagements clone the starter and run the interactive setup.

**Estimated effort:** 4-6 hours

## Architecture

```
ai-assistant-starter/          <-- new public/private repo
  src/                         <-- core engine (from ClaudeClaw, scrubbed)
  skills/                      <-- empty; populated by setup.sh
  templates/                   <-- skill templates, CLAUDE.md template
  projects/                    <-- empty; user creates their own
  store/                       <-- gitignored, created at runtime
  scripts/                     <-- generic utilities only
  .claude/agents/              <-- empty; user creates their own
  tests/                       <-- core engine tests
  docs/                        <-- setup guide, skill authoring, FAQ
  CLAUDE.md                    <-- placeholder, replaced by setup.sh
  package.json
  tsconfig.json
  .env.example
  .gitignore
  setup.sh                     <-- interactive first-run wizard
```

```
ClaudeClaw/                    <-- Marc's personal instance (unchanged)
  (everything stays as-is)
  upstream: ai-assistant-starter (optional, for pulling engine updates)
```

## File-by-File Disposition

### src/ -- Core Engine (KEEP, scrub)

| File | Action | Notes |
|------|--------|-------|
| `index.ts` | Keep as-is | Generic entry point, PID lock, startup |
| `agent.ts` | Keep as-is | Claude Code SDK wrapper, retry logic, loop guard |
| `bot.ts` | Keep, parameterize | Replace grammY (Telegram-only) with platform adapter pattern. Phase 1: keep Telegram-only, add Slack/Discord/Teams later |
| `scheduler.ts` | Keep as-is | Generic cron scheduler, already platform-agnostic |
| `db.ts` | Keep as-is | SQLite schema, task CRUD, memory tables |
| `config.ts` | Keep, extend | Add PLATFORM env var, Slack/Discord/Teams token configs |
| `env.ts` | Keep as-is | Generic .env reader |
| `logger.ts` | Keep as-is | pino logger |
| `http-server.ts` | Keep as-is | Voice endpoint, health check |
| `voice.ts` | Keep as-is | ElevenLabs integration (optional feature) |
| `browser.ts` | Keep as-is | Playwright CDP wrapper |
| `media.ts` | Keep as-is | File upload handling |
| `schedule-cli.ts` | Keep as-is | CLI for managing scheduled tasks |
| `seed-jobs.ts` | **Rewrite entirely** | Replace Marc's hardcoded jobs with a generic `seed-jobs.json` loader. Ship with 2 example jobs (morning briefing, promo cleanup) |
| `skills/` | Keep as-is | Skill loader, types, index are generic |
| `memory/` | Keep as-is | Engine + all providers are generic |
| `cockpit/` | Keep as-is | Dashboard integration (optional) |
| `dreaming/` | Keep as-is | Nightly reflection (optional) |
| `infra/` | Keep as-is | Cleanup, telegram conflict detection |

### skills/ -- Skill Definitions (STRIP, replace with templates)

| Current Skill | Starter? | Notes |
|---------------|----------|-------|
| gmail-personal | Template | Generic gmail skill with placeholders |
| gmail-kai | Remove | Marc-specific second account |
| outlook-work | Template | Generic outlook skill with placeholders |
| outlook-pmtech | Remove | Marc-specific second account |
| outlook-sitewide | Remove | Marc-specific |
| apollo | Optional template | Sales intelligence, common for SMB clients |
| apollo-meetings | Remove | Marc-specific |
| weather | Template | Universal, no API key needed |
| kanban-zone | Optional template | Board management |
| kanbanzone | Remove | Duplicate |
| dashboard | Keep as optional | Generic dashboard integration |
| notion | Optional template | Common integration |
| seminar-rsvp | Remove | Marc-specific |
| dev-projects | Remove | Marc-specific |
| azure-devops | Remove | Marc-specific |
| phew-cosmos | Remove | Marc-specific |
| wordpress | Optional template | Blog management |
| research | Keep | Generic web research |
| wordsmith | Remove | Marc-specific |

### .claude/agents/ -- Agent Definitions (STRIP all)

All 8 agents are Marc-specific (phew-cto, phew-developer, phew-tester, phew-cmo, phew-admin, els-cmo, haiku-researcher, umi-tester). Ship empty `.claude/agents/` with a README on how to create agents.

### projects/ -- Project State (STRIP all)

All project state is Marc-specific. Ship empty `projects/` with a README explaining the STATE.md convention.

### scripts/ -- Utilities (SELECTIVE)

| Script | Action | Notes |
|--------|--------|-------|
| `daily-sync.sh` | Keep, generalize | Useful for any user, remove Marc's hostname |
| `notify.sh` | Keep | Generic Telegram notifier |
| `setup.ts` | Keep | Interactive setup |
| `status.ts` | Keep | Service status checker |
| `md-to-pdf.ts` | Keep | Generic utility |
| `dream.sh` | Keep | Dreaming launcher |
| `chatbot-heartbeat.sh` | Remove | Marc-specific |
| `cloudflared-tunnel.sh` | Keep | Generic tunnel setup |
| `mud0002-sweep.sh` | Remove | Marc-specific |
| `playwright-cdp-wrapper.sh` | Keep | Generic browser helper |

### Root Files

| File | Action |
|------|--------|
| `CLAUDE.md` | Replace with setup-generated output |
| `package.json` | Keep, rename to `ai-assistant` |
| `tsconfig.json` | Keep as-is |
| `.gitignore` | Keep, add store/, logs/, .env |
| `.env` | Ship `.env.example` only |
| `README.md` | New: project overview, quick start, link to setup guide |

### Memory Files (STRIP all)

Everything in `.claude/projects/*/memory/` is Marc-specific. Ship empty memory folder.

## Phase 1: Telegram-Only MVP (4-6 hours)

The bot currently only supports Telegram (grammY). Multi-platform is a feature, not a prerequisite.

### Tasks

1. **Create the repo** (10 min)
   - `gh repo create lefebma/ai-assistant-starter --private`
   - Copy directory structure

2. **Scrub src/ of Marc-specific content** (1 hour)
   - `seed-jobs.ts`: rewrite to load from `seed-jobs.json` instead of hardcoded array
   - `config.ts`: add comments for future platform configs
   - `bot.ts`: no changes needed (already generic Telegram)
   - Search all `.ts` files for hardcoded paths, email addresses, account names

3. **Create skill templates** (30 min)
   - Already done: gmail, outlook, weather in `templates/client-assistant/skills/`
   - Add: notion template, web-research template
   - Each with `{{PLACEHOLDER}}` variables

4. **Create seed-jobs.json loader** (30 min)
   - Replace hardcoded JOBS array with JSON file
   - Ship 2 example jobs: morning briefing (generic), evening debrief (generic)
   - Users add their own jobs to the JSON or via `/schedule create`

5. **Write setup.sh** (already done, refine) (30 min)
   - Already created at `templates/client-assistant/setup.sh`
   - Move to repo root
   - Add: `npm install`, `npm run build`, test launch

6. **Write docs** (1 hour)
   - README.md: 30-second pitch, prerequisites, quick start
   - SETUP-GUIDE.md: already done, refine
   - docs/creating-skills.md: how to write custom skills
   - docs/creating-agents.md: how to write custom agents
   - docs/creating-scheduled-tasks.md: job patterns and examples
   - docs/architecture.md: how the pieces fit together

7. **Create .env.example** (10 min)
   - All possible env vars with comments, all blank

8. **Test: clone and setup from scratch** (1 hour)
   - Fresh directory, run setup.sh, verify bot starts and responds
   - Verify skills load, scheduler works, memory persists

9. **Strip and push** (30 min)
   - Final review: no Marc-specific data, no secrets, no personal email addresses
   - Push to GitHub

## Phase 2: Multi-Platform (Future, ~2 days)

Not needed for Phase 1. Telegram is the right default for solo SMB clients.

### Platform Adapter Pattern

```typescript
// src/platforms/types.ts
interface PlatformAdapter {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: MessageHandler): void
  send(chatId: string, text: string): Promise<void>
}

// src/platforms/telegram.ts  -- extract from bot.ts
// src/platforms/slack.ts     -- new, using @slack/bolt
// src/platforms/discord.ts   -- new, using discord.js
// src/platforms/teams.ts     -- new, using botbuilder
```

### Additional Dependencies
- `@slack/bolt` for Slack
- `discord.js` for Discord
- `botbuilder` for Teams

### Effort
- Refactor bot.ts into adapter pattern: 4 hours
- Slack adapter: 3 hours
- Discord adapter: 3 hours
- Teams adapter: 4 hours (most boilerplate)
- Testing across platforms: 2 hours

## Phase 3: Client Deployment Toolkit (Future, ~1 day)

### Hosted Option
For clients who don't want to run on their own Mac:
- Dockerize the starter
- Deploy to a small VPS (Hetzner, DigitalOcean)
- Add `docker-compose.yml` with the bot + SQLite volume
- Monthly hosting becomes part of the Care Plan

### Managed Dashboard
- Fork the Kai Dashboard as a client-facing status page
- Show: scheduled jobs, recent activity, skill status
- White-label with client branding

## Naming

Repo: `ai-assistant-starter` (or a branded name if this becomes a product)
Package: `ai-assistant`
Default assistant name: chosen during setup (Atlas, Echo, Sage, etc.)

## Revenue Model

This maps directly to the service catalog:
- **Custom AI Assistant** ($17,500): clone starter, customize CLAUDE.md, wire skills, deploy, train
- **Care Plan** ($1,095-3,995/mo): ongoing skill development, prompt tuning, monitoring
- **Skill add-ons** ($2,500-5,750): each new skill integration is billable work

The starter repo is the delivery vehicle. It never ships to the client as source (unless they're technical). ELS deploys and manages it.
