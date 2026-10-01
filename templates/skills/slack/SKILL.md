---
name: slack
description: Post and read in your Slack workspace as your assistant's own bot (its own name and avatar, with Slack's APP tag), not as you.
---

# Slack as your assistant

Your assistant gets its own Slack app, so a message it sends shows who really sent it. A connector that is signed in as you cannot do this: anything it sends shows as you.

## Install (once)

This skill is optional. If `skills/slack/` is not on the box yet, copy it from the bundled templates and fill in the paths, then reload:

```
cp -r templates/skills/slack skills/slack
sed -i "s#{{PROJECT_PATH}}#$(pwd)#g; s#{{OWNER_NAME}}#YOUR NAME#g" skills/slack/manifest.json skills/slack/slack-app-manifest.json
chmod +x skills/slack/scripts/slack.py
```

Then send `/skill reload`.

## Set up the Slack app (about 5 minutes)

1. Go to https://api.slack.com/apps, **Create New App**, **From an app manifest**, pick your workspace.
2. Edit `slack-app-manifest.json` first: set `name` and `display_name` to your assistant's name (they appear in Slack). Paste it in and create the app.
3. **Install to Workspace** and approve. Copy the **Bot User OAuth Token** (starts `xoxb-`).
4. Put it in `.env` on the box as `SLACK_BOT_TOKEN=xoxb-...`. Never in chat, never in a shared workspace repo.
5. In each channel the assistant should use, type `/invite @YourAssistant`.
6. Check: `python3 skills/slack/scripts/slack.py whoami` prints the bot's name and your workspace.

## Scopes

`chat:write` post. `channels:read` and `groups:read` list. `channels:history`, `groups:history`, `im:history` read. `im:write` open DMs. `users:read` and `users:read.email` look people up. There is no scope that lets the bot change its own name per message, and no user token: the bot posts only as itself. The script refuses any token that is not a bot token.

## Rules

- Slack is outward-facing. Show the owner the draft and wait for a yes before `post` or `dm`, unless they told the assistant to send it.
- No secrets, client names or pricing in Slack.
- Outbound only for now. Reacting to @mentions needs Slack's Socket Mode and a long-running listener, which this skill does not have.
