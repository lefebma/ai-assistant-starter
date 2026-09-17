# Should Havn have a named agent roster? No.

Decision record for board card #145. Answered 2026-09-16.

## The question

Umi appears to have a roster of specialists: `phew-cto`, `phew-developer`,
`phew-tester`, `phew-cmo`, `phew-admin`, `umi-tester`, `els-cmo`,
`haiku-researcher`. Should Havn make that a first-class, runtime-independent
product feature, or is "skills plus one generic subagent" the right surface?

None of Umi's roster is a Umi feature. They are plain markdown in
`.claude/agents/` and they work because Umi's agent runtime is Claude Code,
which reads that directory. Havn inherits the same thing on the default
`claude` runtime and gets something different on `ai-sdk`: a single generic
`dispatch_subagent` with no roster. So the answer to "can my assistant have
specialists?" currently depends on one line in `.env`, and nothing tells a
client which line they are on.

## Decision

**Keep it generic. Do not build a roster.** Retract the setup-guide line that
promises `.claude/agents/`, and leave the directory as an undocumented
power-user affordance on the claude runtime.

## Why: the only roster that exists mostly did not earn its keep

Measured across 564 Claude Code sessions on Umi, April to September 2026:

| agent | dispatches | span |
|---|---:|---|
| general-purpose (generic, unnamed) | 96 | Aug-Sep |
| phew-cto | 54 | Apr-Sep |
| umi-tester | 32 | Jul-Sep |
| phew-tester | 4 | Apr-Sep |
| els-cmo | 3 | Aug-Sep |
| phew-cmo | 1 | Aug |
| haiku-researcher | 1 | Aug |
| phew-admin | 0 | never |
| phew-developer | 0 | never dispatched directly |

Three things fall out of that table.

**The generic agent is used as much as the entire roster.** 96 dispatches
against 95 named ones. The catch-all with no persona and no definition file
carries half the load on its own.

**Two agents are the roster.** `phew-cto` and `umi-tester` account for 86 of
95 named dispatches, or 91%. The other six share nine dispatches between them
over five months, and two were never dispatched at all.

**The two survivors are procedures, not personas.** `phew-cto` encodes a
workflow with a definite output: read the work item, break it down, spawn
implementation and test, update the tracker. `umi-tester` encodes a
verification protocol: typecheck, build, vitest, then surface-specific spot
checks. Neither is a character. The ones defined by role, `phew-cmo`,
`phew-admin`, `els-cmo`, total four dispatches in five months.

That last point is the one that decides this. A client-facing roster would be
personas: a drafting agent, an inbox agent, a research agent. That is exactly
the category that died here, built by the most motivated possible user, with
five months to prove itself.

## Why: skills already won the work a client would want

Over the same period, on the same box, 21 distinct skills fired in a single
30-day window (measured by `/audit`). Four never fired. Skills are
keyword-triggered context injection: no separate context, no separate bill,
and they compose with the conversation instead of leaving it.

For "draft like me", "check my email", "update the board", the skill is both
the cheaper primitive and the better fit, and five months of use says so.
`els-cmo` exists and has three dispatches; `wordsmith`, `apollo` and
`kanbanzone` are in constant use as skills.

## Why: the cost lands on the client, not on us

A subagent is a separate context carrying the full tool set and the full
system prompt, and it returns only a final report. On a Claude subscription
that rides the plan. On `ai-sdk` it is the client's own API key, per dispatch.

A visible roster is an invitation to fan out. Havn is priced per box, so
anything that encourages per-dispatch spend on a customer's key needs a
stronger reason than "the other product has one".

## What this is not

**Not a feasibility problem.** Giving `dispatch_subagent` a roster is small:
`buildAgent` in `src/runtime/ai-sdk/index.ts` hardcodes
`instructions: cachedSystem(buildSystemPrompt(cwd))`, so it needs an
instructions override plus a loader for the definitions. Call it thirty lines.
We are not declining because it is hard.

**Not blocked by #113.** Enterprise multi-user is about who is talking:
per-member permissions, visibility, and whether the assistant behaves
differently for different people. A roster is about dispatching a specialist.
Different axis; deciding this now costs #113 nothing.

## Consequences

1. The setup guide no longer tells clients to create agents in
   `.claude/agents/`. That directory has never shipped: it is in neither
   payload list in `src/update/plan.ts` and setup never creates it, so the
   instruction pointed at a path that does not exist on any client box. See
   card #144.
2. `.claude/agents/` is not tracked in this repository at all. It exists only
   on whichever machine someone created it on. So the entire agent story was
   one untracked local directory plus a line in a shipped document promising
   it to clients. Leaving it untracked is fine and stays the position: it is a
   per-developer affordance on the claude runtime, not a product surface.
3. When a client asks for a specialist, the first move is a skill. The
   `skill-builder` skill already exists for exactly this.

## When to reopen

Reopen if two or more clients independently ask for something that is a
**procedure with a definite output** rather than a persona: "run this checklist
every time", "take this through these five steps and report". That is the
shape that worked here. A request for "an agent that writes like me" is a
skill, and should be answered as one.
