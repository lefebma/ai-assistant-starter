# Client Onboarding Checklist

Use this during the setup call. Total time: 45-60 min.

## Pre-Call (you do this)

- [ ] Add client as GitHub collaborator: `gh api repos/lefebma/ai-assistant-starter/collaborators/USERNAME -X PUT -f permission=pull`
- [ ] Confirm their machine: Mac (preferred), Linux, or always-on VPS
- [ ] Send calendar invite with screen share link
- [ ] Have this checklist open during the call

## During the Call

### 1. Prerequisites (5 min)

- [ ] Verify Node.js 20+: `node --version`
- [ ] Install if missing: `brew install node`
- [ ] Verify Claude Code installed: `claude --version`
- [ ] If not: `brew install claude-code` or npm method, then `claude auth login`
- [ ] Confirm Claude Code subscription is active (Max or Pro plan)

### 2. Clone and Configure (10 min)

- [ ] Clone: `git clone https://github.com/lefebma/ai-assistant-starter.git my-assistant && cd my-assistant`
- [ ] Run setup wizard: `./setup.sh`
  - Assistant name
  - Owner name
  - Platform (Telegram recommended for solo)
  - Personality style
  - Timezone
  - Email provider
- [ ] Review generated `CLAUDE.md` together, tweak personality section
- [ ] Review `.env`, fill in what we can now

### 3. Create the Bot (10 min)

**Telegram (recommended):**
- [ ] Open Telegram, message @BotFather
- [ ] `/newbot` -> pick a name and username
- [ ] Copy token into `.env` as `TELEGRAM_BOT_TOKEN`
- [ ] Client sends any message to the new bot
- [ ] Get chat ID: `curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep '"id"' | head -1`
- [ ] Add to `.env` as `ALLOWED_CHAT_ID`

**Slack:** Follow docs/SETUP-GUIDE.md Slack section together.

### 4. Connect Email (10 min, optional)

**Gmail:**
- [ ] `brew install gogcli`
- [ ] `gog auth add client@gmail.com --services gmail,calendar`
- [ ] Client authorizes in browser
- [ ] Test: `gog gmail search "newer_than:1d" --account client@gmail.com`
- [ ] Update `skills/gmail/SKILL.md` with their email address
- [ ] Add `CALENDAR_ACCOUNT=client@gmail.com` to `.env`

**Outlook:**
- [ ] Walk through Azure AD app registration (docs/SETUP-GUIDE.md)
- [ ] Or skip and add later (email is optional for first run)

### 5. First Run (5 min)

- [ ] `npm install`
- [ ] `npm run build`
- [ ] `node dist/src/index.js`
- [ ] Client sends "Hello" in Telegram
- [ ] Verify response comes back with correct personality
- [ ] Client sends "What's the weather in [their city]?"
- [ ] If email connected: "Check my email"
- [ ] Kill the process (Ctrl+C)

### 6. Make It Persistent (10 min)

**macOS:**
- [ ] Create launchd plist (template in docs/SETUP-GUIDE.md Step 6)
- [ ] Replace `{{PROJECT_PATH}}` and `{{USERNAME}}` in plist
- [ ] `launchctl load ~/Library/LaunchAgents/com.ai-assistant.app.plist`
- [ ] Verify: `launchctl list | grep ai-assistant`
- [ ] Test: close terminal, send message via Telegram, confirm reply

**Linux:**
- [ ] Create systemd service (template in docs/SETUP-GUIDE.md Step 6)
- [ ] `systemctl --user enable ai-assistant && systemctl --user start ai-assistant`

### 7. Morning Briefing (5 min)

- [ ] Help client craft their first scheduled prompt:
  ```
  /schedule create "Morning briefing: weather for [CITY], today's calendar, urgent emails" "0 7 * * *" --name "Morning Briefing"
  ```
- [ ] Confirm next run time looks right
- [ ] Explain `/schedule list`, `/schedule pause`, `/schedule delete`

### 8. Wrap-Up (5 min)

- [ ] Walk through key commands: `/newchat`, `/memory`, `/voice`, `/help`
- [ ] Explain: "Talk to it like a person, not a search engine"
- [ ] Set expectation: responses take 5-30s depending on complexity
- [ ] Mention: voice messages work (send a voice note, get text back)
- [ ] Schedule 1-week check-in to add skills or tune personality

## Post-Call (you do this)

- [ ] Send follow-up email with:
  - Link to repo (they have pull access)
  - Quick-reference card (commands, troubleshooting)
  - Your contact for support
- [ ] Add client to your tracking (Apollo, CRM, or projects/)
- [ ] Create `projects/clients/<name>/STATE.md` if ongoing engagement
- [ ] Note any custom skills they'll want (CRM, project management, etc.)
- [ ] Calendar the 1-week check-in

## Quick Reference Card (send to client)

```
YOUR AI ASSISTANT - QUICK REFERENCE

Talk to it naturally. It remembers context across messages.

Commands:
  /newchat    - Fresh start (clears memory for this session)
  /memory     - See what it remembers
  /voice      - Toggle voice replies on/off
  /schedule   - Manage scheduled tasks
  /help       - All commands

Tips:
  - Send voice notes, photos, or documents
  - Ask follow-up questions without repeating context
  - "Check my email" / "What's on my calendar"
  - "Remind me tomorrow at 9am to..."

If it stops responding:
  - Wait 30 seconds (it might be thinking)
  - Send /newchat to reset
  - Check with Marc if it persists

Support: marc.l@els-partners.com
```

## Pricing Notes

| Tier | What's included | Price |
|------|----------------|-------|
| Setup | This onboarding call + 1-week check-in | Included in package |
| Starter | Telegram + email + calendar + 3 skills | $2,500 |
| Professional | + custom skills + agents + scheduled automation | $3,500 |
| Enterprise | + multi-user + Slack/Teams + ongoing support | $4,500+ |

Client pays their own Claude Code subscription ($20/mo Pro or $100/mo Max).
