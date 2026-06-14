# Decision Log

Append-only record of decisions {{OWNER_NAME}} makes. Future-{{OWNER_NAME}} (and you, in a later session) needs to know not just *what* was decided but *why*, what was on the table, and what evidence would flip the call later.

File: `{{PROJECT_PATH}}/decisions/log.md`

## When to invoke

**Append a new entry** when:
- {{OWNER_NAME}} says "log a decision", "log this", "decision:", "we decided", "going with X"
- {{OWNER_NAME}} makes a non-trivial call in conversation that's worth remembering (you can offer to log it: "Want me to add that to the decision log?")
- A clear judgment call gets made — choosing between two tools, killing an initiative, picking a customer segment, setting a pricing rule

**Skip** for:
- Trivial choices (which file to open, which color to use)
- Reversible defaults
- Anything that's already a documented preference

**Search/read** when:
- {{OWNER_NAME}} asks "what did I decide about X", "why did we go with X", "decision history", "what's in the log"
- You're about to advise on something that smells like a recurring decision area — grep the log first, surface prior reasoning

## Format

Newest entries go on top. Use this format exactly so the log stays parseable:

```markdown
## YYYY-MM-DD — Short title

**Decision:** what was decided, one sentence

**Why:** the reasoning. What constraints, what evidence, what gut feel.

**Alternatives considered:** what else was on the table and why those lost

**Owner:** who's accountable for the outcome (usually {{OWNER_NAME}}, sometimes a partner/vendor)

**What would change my mind:** the falsifiable trigger — "if X happens by Y date, revisit"
```

## Capture flow

1. **Confirm scope.** If {{OWNER_NAME}}'s message is terse ("we're going with Vercel"), ask one quick question to get the "Why" and "What would change my mind" lines. Don't pad with three questions — get just enough to make the entry useful.
2. **Draft the entry** in the format above. Use today's date in {{OWNER_NAME}}'s timezone.
3. **Append to top** of `{{PROJECT_PATH}}/decisions/log.md`, right after the `# Decisions` heading and any intro paragraph. The newest entry is always near the top so scanning the file shows recent thinking first.
4. **Confirm to {{OWNER_NAME}}** with a one-line: `Logged: <title>`. Don't paste the full entry back, they just wrote it.

## Search flow

1. Read `{{PROJECT_PATH}}/decisions/log.md`.
2. Match on title, decision text, and alternatives — not just keyword.
3. Return: title + date + one-line summary. Offer to expand if {{OWNER_NAME}} wants the full reasoning.

## Worked example

{{OWNER_NAME}} sends:
> Decided to drop Stripe and move to Lemon Squeezy for the side project. Easier tax handling.

You append:

```markdown
## 2026-06-14 — Payment processor: Lemon Squeezy over Stripe (side project)

**Decision:** Use Lemon Squeezy as merchant of record for the side project, not Stripe.

**Why:** Lemon Squeezy handles VAT/sales-tax remittance globally; Stripe makes me chase per-jurisdiction filings. Side project doesn't justify the tax-ops overhead.

**Alternatives considered:** Stripe (tax overhead disqualifying), Paddle (similar to Lemon Squeezy but slower onboarding), self-managed via Wise (no merchant-of-record coverage)

**Owner:** {{OWNER_NAME}}

**What would change my mind:** If revenue passes $50k MRR and tax CPA becomes affordable, revisit — Stripe's fee structure is meaningfully cheaper at scale.
```

Then reply: `Logged: Payment processor: Lemon Squeezy over Stripe (side project)`

## Guardrails

- **Never edit a past entry.** If a decision is reversed, log a NEW entry that references the prior one ("Reversing 2026-04-12 call on X because Y").
- **No corporate-deck speak.** Write the entry the way {{OWNER_NAME}} would explain it to a peer over coffee. Concrete, specific, occasionally opinionated.
- **Don't invent details.** If {{OWNER_NAME}} didn't give you a "what would change my mind", write `(open)` instead of guessing.
- **One file.** All decisions in `decisions/log.md`. Don't fragment into per-topic files — the value is in scanning the whole thing.
