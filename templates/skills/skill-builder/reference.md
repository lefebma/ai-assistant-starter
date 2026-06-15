# Skill Builder Reference

Complete technical reference for this assistant's **skills**. This is the manifest-based, keyword-triggered model the assistant actually uses, defined in [src/skills/types.ts](../../src/skills/types.ts) and [src/skills/loader.ts](../../src/skills/loader.ts). It is **not** the official Claude Code skill format — there is no YAML frontmatter, no `/slash-command` per skill, no `$ARGUMENTS`, no `allowed-tools`, no `context: fork`.

---

## CLAUDE.md vs Skills

| | CLAUDE.md | Skill |
|---|---|---|
| **When loaded** | Every conversation, always | `description` is always shown in the `<available-skills>` catalog; full `context` + `SKILL.md` inject only when a trigger keyword matches |
| **What it's for** | Project-wide rules, personality, conventions | A specific integration's commands, credentials, and workflows |
| **Examples** | Tone rules, "draft before sending external content", the agent roster | "Weather lookups", "post to the kanban board", "draft a newsletter" |

**Rule of thumb:** if the assistant should *always* apply it, put it in CLAUDE.md. If it's specific to one integration and only relevant when that topic comes up, make it a skill. CLAUDE.md rules still apply inside a triggered skill — the skill layers on top, it doesn't override.

---

## Skill Anatomy

```
skills/<id>/
  manifest.json    # required, canonical — the only file the loader parses for metadata
  SKILL.md         # optional — free-text instructions, injected verbatim on trigger
  reference.md     # optional — bulky detail referenced from SKILL.md
  scripts/         # optional — helper scripts the skill calls
```

`SKILL.md` may carry a `name`/`description` block at the top for human readers, but **the loader ignores SKILL.md frontmatter entirely**. Metadata comes only from `manifest.json`.

---

## Manifest Schema

From [src/skills/types.ts](../../src/skills/types.ts) — `SkillManifest`:

| Field | Required | Type | Default | Purpose |
|-------|----------|------|---------|---------|
| `id` | Yes | string | — | Unique id; matches the directory name; referenced by `/skill enable\|disable <id>` |
| `name` | Yes | string | — | Display name |
| `description` | Yes | string | — | One line; always shown in the `<available-skills>` catalog, so it drives discovery |
| `triggers` | Yes | string[] | — | Case-insensitive substring keywords; any match injects the skill |
| `enabled` | No | boolean | `true` | `false` ⇒ skipped by the loader and absent from the catalog |
| `context` | No | string | none | Static text injected on every trigger (commands, credential references) |
| `priority` | No | number | `50` | Ordering when multiple skills match; higher fires first |

Loader validation ([src/skills/loader.ts](../../src/skills/loader.ts)): a manifest missing `id`, `name`, or a non-empty `triggers` array is **skipped with a warning**. `enabled` defaults to `true` (only an explicit `false` disables). `priority` defaults to `50`.

Example:

```json
{
  "id": "weather",
  "name": "Weather",
  "description": "Current conditions and forecast for a location. Fires on 'weather', 'forecast', 'temperature', 'rain'.",
  "enabled": true,
  "triggers": ["weather", "forecast", "temperature", "rain"],
  "context": "Use: curl 'https://api.open-meteo.com/v1/forecast?...'",
  "priority": 50
}
```

---

## How Loading & Triggering Work

Reference: [src/skills/loader.ts](../../src/skills/loader.ts).

1. **Scan order** — `loadSkills()` reads the user-level skills directory then the project `skills/` directory. Later wins on `id` collision, so **a project skill overrides a user skill with the same id**.
2. **Catalog (always-on)** — `buildSkillIndex()` emits an `<available-skills>` block listing every *enabled* skill's `id`, `description`, and triggers. This is injected into the prompt on every turn (in [src/bot.ts](../../src/bot.ts), as a sibling block to the memory context, NOT inside it). It gives the assistant awareness of the whole toolbox even when no trigger fires, so it can route semantically.
3. **Trigger match** — `matchSkills(message)` lowercases the message and selects enabled skills where any `trigger` is a substring of the message. It's pure substring matching — `"board"` matches `"billboard"`. Matches are sorted by `priority` descending.
4. **Injection** — `buildSkillContext()` wraps the matched skills in a `<skill-context>` block: `manifest.context` first, then the full `SKILL.md`. This is what gives the assistant the integration's commands and detailed workflow for that turn.
5. **Runtime management** — `/skill list` (uses `getSkills()`), `/skill reload` (`reloadSkills()` re-scans disk), `/skill enable <id>` / `/skill disable <id>` (`setSkillEnabled()`, in-memory until next reload).

### Catalog vs context (the two-tier model)

| Tier | What's shown | When | Cost |
|------|--------------|------|------|
| Catalog | `id` + `description` + triggers, every enabled skill | Always | ~one line per skill |
| Context | `manifest.context` + full `SKILL.md` | Only on trigger match | Full skill body |

Keep `description` lean (it's always loaded) and push heavy detail to `SKILL.md` (lazy).

---

## Writing Good Triggers

Triggers are the whole routing mechanism, so they're where most skills succeed or fail.

- **Be specific.** Prefer multi-word phrases and distinctive nouns ("kanban board", "blog draft") over generic stems ("board", "mail", "data").
- **Avoid accidental substrings.** `"art"` matches "start", "smart", "chart". `"ai"` matches "email", "again". Lengthen or qualify them.
- **Avoid sibling collisions.** Two skills sharing a trigger both fire. If that's intended (a general + a specialized variant), set `priority` so the right one leads, and make the specialized one's triggers narrower.
- **Cover real phrasings.** Add the words the user actually types, including shorthand and the proper nouns of the integration.
- **The catalog backstops misses.** Because `description` is always visible, the assistant can still recognize a relevant skill when phrasing dodges every trigger — but it only gets the full instructions once a trigger fires, so don't rely on the catalog alone for routing.

---

## When to Add Supporting Files

Keep `SKILL.md` focused. Move to a sibling file when:

- Reference material is long (API field tables, enums, troubleshooting trees) → `reference.md`, linked from SKILL.md.
- The skill runs real logic → a `scripts/` helper the SKILL.md invokes by path.

Supporting files are not parsed by the loader; they're just there for the assistant to read or run when SKILL.md points at them.

---

## Credentials Convention

Reference credentials **by env var name or file path**, never inline the secret value. Put the reference in `manifest.context` or SKILL.md so the assistant knows where to look. Keep actual secrets in `.env` (gitignored) or a secrets file outside the repo.

---

## Troubleshooting

### Skill never triggers
1. Confirm a trigger keyword is actually a substring of the messages you send. Matching is literal substring, case-insensitive — no stemming, no synonyms.
2. `/skill list` to confirm it loaded and is enabled. If absent, check the manifest has `id`, `name`, and a non-empty `triggers` array (the loader silently skips manifests missing these).
3. Run `/skill reload` after editing the manifest on disk.
4. Widen/adjust `triggers` to match real phrasing.

### Skill triggers too often
1. A trigger is too generic or is a substring of common words. Narrow it.
2. Lower its `priority` if it's crowding out a more specific skill that should lead.

### Two skills both fire
- They share a trigger substring. Either narrow one, or set `priority` so the intended one leads and document the routing in both skills' notes.

### Edits aren't taking effect
- The loader caches in memory. Run `/skill reload` (or restart the service). `setSkillEnabled` changes are in-memory only and reset on reload.

### SKILL.md frontmatter seems ignored
- It is. Only `manifest.json` drives metadata. Move anything load-bearing into the manifest.

---

## Related Code

- Manifest schema: [src/skills/types.ts](../../src/skills/types.ts)
- Loader, matcher, catalog, context builder: [src/skills/loader.ts](../../src/skills/loader.ts)
- Catalog injection into the prompt: [src/bot.ts](../../src/bot.ts)
