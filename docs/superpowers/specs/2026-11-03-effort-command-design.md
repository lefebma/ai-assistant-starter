# /effort command (card #272), design

Date: 2026-11-03. Target: starter v1.67.0, branch `feat/effort-command`. Built from the card as written (Marc skipped the questions); the calls below are the builder's.

## From the card

- `/effort` alone shows the current level and buttons: low, medium, high, xhigh, default. Picking one sets it for this chat.
- Stored per chat, survives a restart, like `/model`. Telegram, Teams and web; in the web it sets the conversation's effort picker.
- Scheduled tasks keep their own setting.
- Only levels the current model supports are offered. A model with no effort setting says so, and the stored choice is ignored rather than sent. Managed boxes get the same rule; the spend cap counts the tokens as usual.

## Builder's calls

- **Storage:** app_state `chat_effort:<chatId>`; a web conversation keeps its own in `web_conversations.effort` (already there for the picker).
- **One gate for every turn:** `runAgent` matches the stored level to the model the turn runs on (`fitEffort`): the level itself, else the nearest level below it the model has, else nothing. So a `/model` switch never sends a level the new model rejects, and the pick comes back when the chat switches back.
- **Setting a level the model lacks is refused** (the reply names the levels it has). `/effort default` always works.
- **Which levels:** Claude ids by rule (current models all four; Opus/Sonnet 4.6 and Opus 4.5 low to high; older none). On the claude runtime the tier aliases resolve inside the vendored CLI, so each process asks the CLI once (`supportedModels()`) and keeps the answer in `store/claude-models.json`; before the first answer an alias offers every level (the CLI lowers one its model lacks). OpenAI GPT-5 family (not `-chat`) and o-series: low to high. Gemini 3+: Pro low/high, others low to high. AI_BASE_URL hosts, Azure deployments and the managed open model: none.
- **ai-sdk runtime now sends effort** (it ignored it before): Anthropic `effort`, OpenAI `reasoningEffort`, Google `thinkingConfig.thinkingLevel`, on the main agent, subagents and isolated turns.
- **Buttons say "effort"** ("High effort") so a click is never mistaken for an agent's own button, and need no per-menu memory.
- **`/model` replies add a line** when the chat's effort does not carry over as it is.
- **Web picker** lists only the chosen model's levels (`/api/web/models` now carries `efforts` per model), keeps a stored level the model lacks visible, and greys out for a model with none.

## Out of scope

- `max` (the card lists four levels).
- Umi: its `/model` port is still pending, so `/effort` is flagged as a gap there too.
