# Changelog

## 1.5.0 - 2026-07-20

- **New: run your assistant on OpenAI or Gemini, not just Claude.** This is the payoff of the LLM-agnostic roadmap started in 1.3.0. Set `AGENT_RUNTIME=ai-sdk` in `.env`, then pick a provider and model with `AI_PROVIDER` (`anthropic`, `openai`, or `google`) and `AI_MODEL`. The assistant keeps all its skills, tools, memory, and scheduled tasks — only the engine underneath changes. Claude on your subscription is still the default; nothing changes unless you opt in.
- **Self-hosted and OpenAI-compatible models too.** With `AI_PROVIDER=openai` you can set `AI_BASE_URL` to point at any OpenAI-compatible endpoint — Ollama, vLLM, LM Studio, or a gateway — so a local model runs the assistant with no code changes.
- **Different engines for chat vs. scheduled work.** `AGENT_RUNTIME_CRON` lets unattended jobs (like the nightly reflection) run on a different engine than your live chat — for example, keep costly overnight work on your subscription while chat talks to an API.
- **Subscription overflow.** On the Claude runtime, if your subscription usage window runs out mid-conversation and you've set `ANTHROPIC_API_KEY`, the assistant finishes the reply on API billing instead of stalling, and tells you it switched. Leave the key unset to keep it off.
- **Cost control for the API runtime.** `AI_HISTORY_MAX_BYTES` caps how much conversation history is re-sent each turn, trimming the oldest turns when a chat gets long.
- **A cross-provider test harness.** `scripts/ab-eval.ts --providers=anthropic,openai,google` runs a golden-task suite against each engine so you can see which models handle the assistant's workload. Many more automated tests too (`npm test`).
- **Under the hood:** a new runtime (built on the Vercel AI SDK) owns the tool loop, session persistence, MCP tools, and system-prompt assembly, all behind the same runtime interface introduced in 1.3.0.

## 1.4.0 - 2026-07-15

- **Fixed: changing your model in Claude Code no longer breaks your assistant.** Until now the assistant quietly borrowed whatever model you last picked in Claude Code (the `model` setting in `~/.claude/settings.json`). That sounds harmless, but the two don't update in lockstep: the assistant runs its own bundled copy of the Claude engine, which only understands the models it shipped knowing about. So picking a brand-new model in Claude Code could leave the assistant asking its older engine for a model that engine had never heard of. Everything still worked while you chatted, and then every scheduled task failed overnight with "There's an issue with the selected model" — until someone noticed in the morning. Your assistant now chooses its own model and ignores that setting entirely, so the two can't drift apart.
- **New: you can pick the model your assistant runs on.** Set `AGENT_MODEL` in `.env` to `sonnet` (the new default), `opus`, or `haiku`. Opus is the most capable and the most expensive; haiku is the fastest and cheapest. Use these short names rather than a specific version like `claude-opus-4-6` — the short names keep working when the engine updates. Changing it takes effect on the next restart.
- **Heads up:** if you had deliberately set your assistant to Opus via Claude Code's model setting, it now runs on Sonnet instead. Put `AGENT_MODEL=opus` in your `.env` to get it back. If you never touched that setting, this changes nothing for you.
- **More automated tests.** The suite now covers the model pin, so a future change can't silently drop it and reintroduce this bug (`npm test`).

## 1.3.0 - 2026-07-12

- **Groundwork for choosing your own AI model.** The Claude engine now sits behind a pluggable runtime interface (`src/runtime/`) instead of being wired directly into the assistant. Nothing changes in day-to-day use: Claude is still the engine and behaves exactly as before. This is step one of the LLM-agnostic roadmap; future releases will let you point the assistant at OpenAI, Gemini, Azure, or your own self-hosted models by setting `AGENT_RUNTIME` in `.env`.
- **First automated tests.** The repo now has a vitest suite covering the new runtime seam (`npm test`).
- Fixed the `VERSION` file, which was left at 1.2.0 when 1.2.1 was released.

## 1.2.1 - 2026-06-23

- **Nicer-looking replies on Telegram.** Tables in your assistant's answers now show up as cleanly aligned columns instead of raw `| pipes |`. Quoted text (lines that start with `>`) shows up as a proper indented quote — long quotes get a "tap to expand" preview so they don't take over the whole screen.
- **No more silent "(no response)" answers.** If your assistant gets cut off mid-reply (network blip, hit a limit, etc.) it now sends what it had written so far, marked as a partial reply, instead of acting like it had nothing to say.

## 1.2.0 - 2026-06-15

- Expanded the starter skill pack: `apollo`, `wordsmith`, `antilibrary`, `notion`, `kanbanzone`, `wordpress`, all opt-in via setup.sh.
- `decision-log` (always on): append-only record of decisions with Decision / Why / Alternatives / Owner / What-would-change-my-mind. Triggers on phrases like "log a decision", "we decided", "what did I decide about X".
- Wordsmith voice-samples: drop real `.md` writing samples into `skills/wordsmith/voice-samples/` and `wordsmith.sh` auto-loads them into the voice block. Concrete examples mirror voice better than abstract style rules.
- setup.sh: up to 2 Gmail + 2 Outlook accounts via primary/secondary skill folders.
- setup.sh: new `write_secret` helper refuses to overwrite a pre-existing non-empty key file (including symlink targets) — prevents accidental clobbering of real credentials during re-runs.
- setup.sh: fixed `TEMPLATE_DIR` (was pointing at repo root; now resolves to `templates/`).
- Updater: `templates/` is now part of the engine update set, so new always-on skills land on every `/update apply`. Existing user skills in `skills/` are still preserved.
- New `src/skills/sync.ts`: installs missing always-on skills (with `{{OWNER_NAME}}`/`{{PROJECT_PATH}}` substitution) on every boot and after every update. Idempotent — never overwrites a user-customized skill.

## 1.1.1 - 2026-06-15

- Fix stale references in the kanbanzone skill template: removed a pointer to a nonexistent `kanbanzone-sway-crm` sibling skill, and corrected the helper script name from `sway.py` to `kz.py`.

## 1.1.0 - 2026-06-14

- Always-on skill catalog: `buildSkillIndex()` injects an `<available-skills>` block every turn so the assistant is aware of its full toolbox and can route to a skill even when the message lacks a literal trigger word. Full SKILL.md still loads lazily on trigger.
- New default `skill-builder` skill: guides creating, optimizing, and auditing skills against the manifest.json + triggers model (installed by setup.sh alongside weather and decision-log).

## 1.0.0 - 2026-05-25

- Initial release
- Telegram and Slack platform adapters
- Skills system with drop-in folders
- Scheduled tasks with cron expressions
- Voice message support (STT/TTS)
- Memory system with episodic, semantic, and auto-memory providers
- Browser automation via Chrome CDP
- Update system with /update command and morning briefing integration
