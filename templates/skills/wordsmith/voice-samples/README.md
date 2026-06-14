# Voice Samples

Drop **real {{OWNER_NAME}} writing** into this folder so Wordsmith can mirror the actual voice instead of guessing from the abstract voice block in `SKILL.md`.

## What to add

Two to five files. Each one a single piece of writing that's a clean example of how {{OWNER_NAME}} sounds. The more representative, the better.

Good candidates:
- A recent outbound email that landed well
- A Slack/Telegram message that was characteristic
- A LinkedIn post or short blog excerpt
- A reply to a vendor or prospect

Bad candidates:
- Forwarded emails (someone else's voice)
- Marketing copy written for {{OWNER_NAME}} by an agency
- Anything {{OWNER_NAME}} would describe as "not how I'd say it"

## Format

One sample per file, plain markdown. Filename hints at audience and context:

```
voice-samples/
  apollo-followup-2026-05-15.md
  vendor-pushback-2026-05-22.md
  client-kickoff-2026-06-01.md
  internal-slack-product-decision.md
```

Each file can be just the text, or a short header + the text:

```markdown
# Apollo follow-up (warm prospect, no response in 2 weeks)

Hi {first_name},

Quick nudge on the proposal I sent two weeks back. ...
```

## How Wordsmith uses these

When invoked, the skill reads the files in this folder and includes them in the `WORDSMITH_VOICE` block as concrete examples ("write like this, not like the abstract rules"). The voice rules in `SKILL.md` set the floor; the samples set the ceiling.

Keep this folder fresh. If you stop sounding like the samples, drop new ones in and delete the stale ones.
