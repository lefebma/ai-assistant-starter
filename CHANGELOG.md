# Changelog

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
