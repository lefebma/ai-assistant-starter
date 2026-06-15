---
name: skill-builder
description: Use when creating a new skill, optimizing an existing one, or auditing skill quality. Guides skill development for this assistant's manifest.json + triggers model.
---

## What This Skill Does

Guides the creation and optimization of **skills** (the drop-in integrations that live in `skills/`). Use this whenever:

- Building a new skill from scratch
- Optimizing or auditing an existing skill
- Troubleshooting a skill that isn't triggering or injecting the right context

For the complete reference on the manifest schema, the loader, and conventions, see [reference.md](reference.md).

> This assistant uses a manifest-based, keyword-triggered skill model, NOT the official Claude Code skill format. There is no YAML frontmatter parsing, no `/slash-command` per skill, no `$ARGUMENTS`, no `allowed-tools`, no `context: fork`. If you've used Anthropic's public skills docs, set that aside here. The model below is different and simpler.

## Quick Start: What Is a Skill?

A skill is a folder under `skills/<id>/` containing:

- **`manifest.json`** (required, canonical) — the metadata the loader actually reads: `id`, `name`, `description`, `enabled`, `triggers[]`, optional `context`, optional `priority`.
- **`SKILL.md`** (optional) — free-text instructions. When the skill triggers, this whole file is injected into the assistant's context. **Its frontmatter is ignored** by the loader; only `manifest.json` matters.

**How they load (see [src/skills/loader.ts](../../src/skills/loader.ts)):**

- On startup the loader scans the user-level skills dir then the project `skills/` (project overrides user by `id`).
- Every enabled skill's `id` + `description` is shown to the assistant in an always-on `<available-skills>` catalog, so it knows the toolbox exists even before a trigger fires.
- When an incoming message contains any of a skill's `triggers` (case-insensitive substring match), that skill's `context` + full `SKILL.md` are injected for that turn. Multiple matches are ordered by `priority` (higher first).
- Manage at runtime: `/skill list`, `/skill reload`, `/skill enable <id>`, `/skill disable <id>`.

**Rule of thumb:** static facts the assistant should always know about an integration go in `manifest.context` (short: commands, credential references). Detailed workflows go in `SKILL.md`. Project-wide rules that apply to everything go in `CLAUDE.md`, not a skill.

---

## Mode 1: Build a New Skill

Run the **Discovery Interview** first. Do NOT write files until discovery is complete.

### Discovery Interview

Ask one round at a time using AskUserQuestion. Move on only after each answer. Stop when you're 95% confident you can build it without further clarification.

**Round 1: Goal & ID**
*Why: a clear goal prevents scope creep. The `id` is the folder name and how `/skill enable|disable` references it, so it must be stable and specific.*

- What does this skill do? What problem or workflow does it cover?
- What should the `id` be? (lowercase, hyphens, matches the directory name)

**Round 2: Triggers**
*Why: the assistant injects a skill purely on keyword substring match against `triggers[]`. Bad triggers mean the skill never fires; overly generic ones (e.g. `board`, `mail`) mean it fires constantly and collides with siblings.*

- What words or phrases would the user actually type when they need this? Collect 4-8 specific keywords.
- Are any of them substrings of common words (e.g. `board` matches "billboard")? Tighten if so.
- Do any overlap with an existing skill's triggers? Check `skills/*/manifest.json` and disambiguate.

**Round 3: Step-by-Step Process**
*Why: the assistant follows SKILL.md literally. Vague steps produce vague results.*

- Walk through exactly what happens from trigger to output. Step 1, step 2, and so on.
- For each step: does the assistant do it directly (Bash/MCP/file tools) or delegate to a subagent?
- Is it conversational (back-and-forth) or fire-and-forget?

**Round 4: Inputs, Outputs & Dependencies**
*Why: skills that don't pin down where inputs live and where outputs go produce inconsistent results.*

- What inputs does it need? (files, API responses, live data)
- What does it produce, and where do outputs go?
- External APIs, scripts, or MCP servers? Which ones?
- Credentials? Where do they live? (env vars or a secrets file referenced by path — never inlined)

**Round 5: Guardrails & Edge Cases**
*Why: skills without guardrails do surprising things — wrong outputs, needless API spend, external actions the user didn't approve.*

- What can go wrong? Common failure modes?
- What should this skill NOT do? Hard boundaries? (Especially: anything external/public-facing should draft, not send, unless explicitly approved.)
- Cost concerns? Ordering constraints ("check X before Y")?

**Round 6: Confirmation**

Summarize back in this format, then ask "Does this capture it? Anything to add or change?" Only build once confirmed:

```
## Skill Summary: <id>

**Goal:** [one sentence]
**Triggers:** [keyword list]
**Process:**
1. [step]
2. [step]
**Inputs:** [what it reads/needs]
**Outputs:** [what it produces + where]
**Dependencies:** [APIs, scripts, MCP, credential references]
**Guardrails:** [what can go wrong, what to avoid]
```

**Skipping rounds:** if the user gave enough upfront, skip what's already answered. Don't re-ask.

### Build Phase

**Step 1: Create the folder and `manifest.json`**

`skills/<id>/manifest.json`:

```json
{
  "id": "<id>",
  "name": "Human Readable Name",
  "description": "One specific line: what it does + when it fires. Always visible to the assistant, so make it count.",
  "enabled": true,
  "triggers": ["keyword1", "keyword2", "specific phrase"],
  "context": "Optional short always-injected snippet: key commands, credential references (not secret values).",
  "priority": 50
}
```

Field rules (full spec in [reference.md](reference.md)):

- `id` — required, unique, matches the directory name.
- `name` — required, display name.
- `description` — required and important: it's shown in the always-on `<available-skills>` catalog, so it drives whether the assistant even considers the skill. Be specific.
- `triggers` — required, non-empty. Specific keywords from Round 2.
- `context` — optional. Short static text injected on every trigger. Put credential references and core commands here; keep heavy detail in SKILL.md.
- `priority` — optional, default 50. Only raise it if this skill must win ordering when multiple fire together.
- `enabled` — defaults true. Set false to ship something dormant.

**Step 2: Write `SKILL.md` (if the skill needs more than `context`)**

Structure:
1. **Context** — files to read, APIs to call, credential references.
2. **Workflow** — numbered, literal steps.
3. **Output format** — templates, file paths, structured formats.
4. **Notes** — edge cases, guardrails, what to delegate, what NOT to do.

Rules:
- Keep it tight. Move bulky reference material to a sibling file (e.g. `reference.md`) and point to it.
- Be explicit about subagent delegation — include the exact prompt text.
- Specify all file paths (inputs, outputs, scripts).
- No `$ARGUMENTS`/`$N` — there is no per-skill argument substitution. The skill reads the user's message as-is from context.

**Step 3: Register the skill**

- Add the `id` to the installed-skills list in your `CLAUDE.md` so the roster stays accurate.
- Run `/skill reload` (or restart the service) so the loader picks it up.

**Step 4: Test**

1. **Trigger** — send a message containing a trigger keyword. Confirm the skill's context appears.
2. **Discovery** — send a related message that does NOT contain a literal trigger. The assistant should still be aware the skill exists (from the `<available-skills>` catalog) and route to it or confirm.
3. **No false fires** — send unrelated messages with near-miss words; confirm it doesn't trigger spuriously.
4. **Collisions** — if triggers overlap another skill, confirm `priority` orders them sensibly.

### Complete Example

`skills/meeting-notes/manifest.json`:

```json
{
  "id": "meeting-notes",
  "name": "Meeting Notes",
  "description": "Turns raw meeting notes into a structured summary with action items. Fires on 'meeting notes', 'recap the meeting', 'meeting minutes'.",
  "enabled": true,
  "triggers": ["meeting notes", "meeting minutes", "recap the meeting", "meeting recap"],
  "priority": 50
}
```

`skills/meeting-notes/SKILL.md`:

```markdown
## What This Skill Does
Takes raw meeting notes and produces a structured summary with action items.

## Workflow
1. If the user didn't paste notes, ask for them (or a file path).
2. Extract: attendees, key decisions, action items (owner + deadline), open questions.
3. Format using the template below.

## Output Template
# Meeting: [title]
**Date:** [date or "Not specified"]
**Attendees:** [comma-separated]

## Key Decisions
- [decision]

## Action Items
- [ ] [owner]: [task] (due: [date or "TBD"])

## Open Questions
- [question]

## Notes
- Keep it concise. Don't embellish.
- If notes are too vague to extract action items, flag it instead of inventing them.
```

---

## Mode 2: Audit an Existing Skill

Read the skill's `manifest.json` AND `SKILL.md` first. Then run the checklist.

### Manifest Audit

- [ ] `id` is unique and matches the directory name
- [ ] `name` is present and human-readable
- [ ] `description` is present and specific (it's always in the `<available-skills>` catalog — vague descriptions = poor discovery)
- [ ] `triggers[]` is present and non-empty
- [ ] Triggers are specific enough to avoid false fires, broad enough to catch real phrasing
- [ ] No trigger is a substring of common unrelated words (e.g. `board` → "billboard")
- [ ] No destructive overlap with a sibling skill's triggers; if overlap is intentional, `priority` disambiguates
- [ ] `enabled` is intentional (not accidentally dormant or accidentally live)
- [ ] `priority` is set only when collision ordering actually matters
- [ ] `context` holds short static text (commands, credential references) — heavy detail lives in SKILL.md, not the manifest

### Content Audit (SKILL.md, if present)

- [ ] SKILL.md is reasonably tight; bulky reference material is split into a sibling file
- [ ] Clear, numbered, literal workflow steps
- [ ] Output format specified with templates or examples
- [ ] All file paths (inputs, outputs, scripts) documented
- [ ] Subagent delegation includes the actual prompt text
- [ ] Notes cover edge cases, guardrails, and what NOT to do
- [ ] No leftover official-Claude-Code artifacts: no YAML frontmatter being relied on, no `$ARGUMENTS`/`$N`, no `disable-model-invocation`, `allowed-tools`, `context: fork`, or `/slash-command` references

### Integration Audit

- [ ] Skill `id` appears in the installed-skills list in CLAUDE.md
- [ ] Supporting files (if any) are referenced from SKILL.md, not orphaned
- [ ] Scripts (if any) have correct paths and are executable
- [ ] Credentials are referenced by env var or path, never hardcoded in the skill

### Quality Audit

- [ ] A reader with no prior context could follow it
- [ ] Instructions are actionable, not abstract
- [ ] Delegates to subagents where that keeps main context clean
- [ ] Doesn't duplicate what already lives in CLAUDE.md or another skill
- [ ] Output paths follow a predictable convention

---

## Important Notes

- Always read a skill's `manifest.json` and `SKILL.md` before proposing changes. Never edit a skill you haven't read.
- Before building, check whether an existing skill already covers it and could be extended instead.
- Manifest is canonical. If a SKILL.md has YAML frontmatter at the top, it's cosmetic — the loader ignores it. Flag it as redundant during audits.
- For the full schema, loader behavior, and conventions, see [reference.md](reference.md).
