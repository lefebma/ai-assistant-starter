# Changelog

## Unreleased

- Telegram formatter: markdown tables now render as aligned monospace `<pre>` blocks, and markdown blockquotes (`> ...`) render as `<blockquote>` (auto-expandable past 5 lines) with inline bold/italic/link preserved inside the quote.
- Agent reply reconciliation: if a turn dies before the model emits a `result:success` event but text was already streamed, the partial is surfaced (tagged as cut short) instead of returning `(no response)`.

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
