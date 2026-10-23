# Spike #219: outcome telemetry, extend Havn's own or adopt LangSmith

Date: 2026-10-22. Timebox: 1 day. Status: done, decision below.

**Question.** Which gaps in Havn's current observability justify a LangSmith integration, and which are better closed by extending the telemetry Havn already has?

**Answer.** Extend. Every gap that matters for "did the job actually get done" is one LangSmith does not close: checking the destination, completion authority, tamper evidence, and keeping client email on the box. LangSmith's real advantage is evaluation tooling. That is worth revisiting later on synthetic datasets only. It is not worth shipping client traces off the box for.

## 1. What Havn records today (origin/main at 054d2a9)

| Source | What it holds | What it cannot say |
|---|---|---|
| `src/assurance/audit-log.ts` (#169) | A hash-chained `audit.jsonl` outside the workspace. Each event has `seq, ts, runId, actor, action, outcome, detail`. Torn writes are tolerated, and `verify()` detects edits, truncation and fabrication. | It is a flat list of events. There is no span, no duration and no parent. |
| `src/assurance/audit-trail.ts` (#196 part 1) | One event per tool call from `gateToolCall`, in both runtimes. `runId` is the session id, `actor` comes from `withActor` (`chat:<id>`, `job:<task>`), and detail is the redacted command or path, or only the argument names for MCP tools. | It records no model calls, no human waits and no results. A send the provider dropped looks the same as one that landed (both are `allowed`). |
| `witness*.ts`, `audit-compare.ts` (#196 parts 2 to 4) | Off-box Cloudflare witness. It gets chain fields plus `sha256(detail)`, sends an hourly heartbeat, and runs a silence and conflict check. | It proves events existed and were not changed. It cannot see what they said, by design. |
| `src/assurance/obligations.ts` (#168) | External completion authority. Only `app` or `tool` evidence counts, and the model can never declare completion. | It has no callers (#197 is still in the backlog). It lives in memory, so a restart loses it. |
| `src/audit/*` | The monthly usage digest and report. It summarises counts from the box's own tables. | It is a different thing from the assurance audit log. It has no per-run view. |
| `src/metering.ts` `usage_log` | Tokens per turn, per provider and model, on the ai-sdk runtime only. | No prices (deliberate). No rows on subscription installs, which is the default Claude lane. No duration. |
| `scheduled_tasks` | `last_run`, `last_result`, `status`. | It has no run history and no attempt count. The overload retry in `scheduler.ts` only goes to pino. |
| `src/logger.ts` | pino, to stdout or stderr. | Unstructured for this purpose. It rotates. |
| OpenTelemetry | None. No `@opentelemetry/*` dependency, and no `experimental_telemetry` on the AI SDK calls. | |
| `src/eval/*` | An offline certification harness with regression diffs per lane. | It runs offline on fixed tasks. It is not connected to live runs. |

Found while tracing the subagent path: `buildSubagentTool` in `src/runtime/ai-sdk/index.ts:180` calls `buildAgent` without `guardSession`. So an ai-sdk subagent's tool calls are audited under `ai-sdk:<cwd>`, not under the parent session. That is a real correlation bug, small to fix, and it is in the extension estimate below.

## 2. The harness

`src/assurance/outcome-trace.ts` and `src/assurance/outcome-trace-scenarios.ts`, tested by `tests/assurance-outcome-trace.test.ts` (13 tests). It follows the #121 pattern: pure prototype, not wired into either runtime.

How it works:

- **A span is two ordinary audit events** (start and end). It therefore inherits the hash chain, the append-only file, `verify()` and the witness, with no schema change.
- **Where each field goes.** `runId` carries the workflow id, which the witness receives in clear. Span id, parent, kind, timings, model and token counts go in `detail`, which leaves the box only as a hash. Each field is a name or a count, never message text.
- **Span ids are the audit seq of the start event.** They survive a restart and double as the evidence locator (`audit#46,47`).
- **Span kinds:** `request, authorize, orchestration, model, tool, human_wait, subagent, verify`.
- **Completion comes from `verdictFromLog`**, which rebuilds the #168 obligation checker from the log. Only `verify` spans (which read the destination) and `human_wait` ends (the owner's click, minted by the app) count as evidence. Evidence the model attaches to its own reply is replayed and refused as `unqualified-origin`.
- **The destination is a mock mailbox** that the verifier reads directly.
- **Today's view runs alongside.** Each scenario also records what `audit-trail.ts` writes today into a second log, so the two views can be compared line for line.

### Representative traces

The output of `SPIKE_PRINT=1 npx vitest run tests/assurance-outcome-trace.test.ts`. All data is synthetic and the clock is injected. `audit#a,b` gives the seq numbers of the start and end events.

The one chain the acceptance criteria ask for, from business request through authorization and execution to an independently verified outcome:

```
trace wf-approval
  request:reply-to-supplier [chat:owner] 12008.0s | ok | audit#39,54
    authorize:role:assistant scope:email.draft [chat:owner] 0.0s | ok | audit#40,41
    model:draft [chat:owner] 6.4s | ok | synthetic-large 8100/720 tok | audit#42,43
    tool:gmail.create_draft [chat:owner] 0.7s | ok | audit#44,45
    human_wait:approve-send [chat:owner] 12000.0s | ok | evidence approval:click-3 | audit#46,47
    authorize:approval:click-3 scope:email.send [chat:owner] 0.0s | ok | audit#48,49
    tool:gmail.send_draft [chat:owner] 0.6s | ok | audit#50,51
    verify:mailbox [chat:owner] 0.3s | ok | evidence mailbox:msg-3 | audit#52,53
  verdict: {"status":"complete","version":1,"unmet":[]}
```

Partial failure. The model claims success and the mailbox disagrees:

```
trace wf-partial
  request:send-three-followups [chat:owner] 16.7s | error | audit#13,38
    authorize:role:assistant scope:email.send [chat:owner] 0.0s | ok | audit#14,15
    model:plan [chat:owner] 5.1s | ok | synthetic-large 6100/640 tok | audit#16,17
    tool:gmail.send [chat:owner] 0.8s | ok | audit#18,19
    tool:gmail.send [chat:owner] 0.8s | ok | audit#20,21
    tool:gmail.send [chat:owner] 1.2s | error | audit#22,23
    model:retry-decision [chat:owner] 1.5s | ok | synthetic-large 6800/90 tok | audit#24,25
    tool:gmail.send [chat:owner] 1.2s | error | attempt 2 | audit#26,27
    model:retry-decision [chat:owner] 1.5s | ok | synthetic-large 6800/90 tok | audit#28,29
    tool:gmail.send [chat:owner] 1.2s | error | attempt 3 | audit#30,31
    model:retry-decision [chat:owner] 1.5s | ok | synthetic-large 6800/90 tok | audit#32,33
    model:final-reply [chat:owner] 1.6s | ok | synthetic-large 7000/150 tok | evidence mailbox:msg-22 | audit#34,35
    verify:mailbox [chat:owner] 0.3s | ok | evidence mailbox:msg-20,mailbox:msg-21 | audit#36,37
  verdict: {"status":"incomplete","version":1,"unmet":[{"id":"delivered","have":2,"need":3}]}
```

Subagent handoff. The subagent stays under its parent, with its own actor:

```
trace wf-subagent
  request:research-then-brief [chat:owner] 20.5s | ok | audit#55,72
    authorize:role:assistant scope:web,email.send [chat:owner] 0.0s | ok | audit#56,57
    model:plan [chat:owner] 3.9s | ok | synthetic-large 5000/300 tok | audit#58,59
    subagent:dispatch_subagent [chat:owner] 15.4s | ok | audit#60,67
      model:research [subagent:research] 9.0s | ok | synthetic-small 14000/1100 tok | audit#61,62
      tool:web.fetch [subagent:research] 2.1s | ok | audit#63,64
      model:summarise [subagent:research] 4.3s | ok | synthetic-small 16000/600 tok | audit#65,66
    tool:gmail.send [chat:owner] 0.9s | ok | audit#68,69
    verify:mailbox [chat:owner] 0.3s | ok | evidence mailbox:msg-4 | audit#70,71
```

Restart. The process dies after the send. A new process with a new `AuditLog` instance resumes the same workflow id and rebuilds the obligations from the log:

```
trace wf-restart
  request:weekly-digest-email [job:digest] 248.5s | ok | audit#73,84
    authorize:role:digest scope:email.send [job:digest] 0.0s | ok | audit#74,75
    model:compose [job:digest] 7.2s | ok | synthetic-large 9000/900 tok | audit#76,77
    tool:gmail.send [job:digest] 0.9s | ok | audit#78,79
    orchestration:resume [job:digest] 0.1s | ok | audit#80,81
    verify:mailbox [job:digest] 0.3s | ok | evidence mailbox:msg-5 | audit#82,83
  verdict: {"status":"complete","version":1,"unmet":[]}
```

Missing evidence. The tool said ok and the provider dropped the message. Another span never closed:

```
trace wf-missing
  request:confirm-booking [chat:owner] 7.7s | ok | audit#85,97
    authorize:role:assistant scope:email.send [chat:owner] 0.0s | ok | audit#86,87
    model:plan [chat:owner] 3.6s | ok | synthetic-large 4800/260 tok | audit#88,89
    tool:gmail.send [chat:owner] 0.9s | ok | audit#90,91
    tool:calendar.create [chat:owner] OPEN | no-end | audit#92
    model:final-reply [chat:owner] 1.4s | ok | synthetic-large 5600/140 tok | evidence mailbox:msg-6 | audit#93,94
    verify:mailbox [chat:owner] 0.3s | ok | audit#95,96
  MISSING s92: no-end
  verdict: {"status":"incomplete","version":1,"unmet":[{"id":"delivered","have":0,"need":1}]}
```

The same six workflows as today's trail sees them:

| runId | tools | outcomes |
|---|---|---|
| sess-1 | gmail send | allowed |
| sess-2 | gmail send x5 | allowed x5 (the three failures are invisible) |
| sess-3 | create_draft, send_draft | allowed, allowed (there is no trace of the 3h20m approval) |
| ai-sdk:/synthetic/workspace | WebFetch | allowed (an orphan: the subagent's call is not under sess-4) |
| sess-4 | gmail send | allowed |
| sess-5a | gmail send | allowed (the resumed half has no tool call, so no record at all) |
| sess-6 | gmail send | allowed (looks the same as a delivered send) |

### Outcome metrics (synthetic)

| Metric | Value |
|---|---|
| Workflows | 6 |
| Verified complete | 4 |
| Unresolved | 2 (wf-partial, wf-missing) |
| Reopened | 1 (wf-restart) |
| p50 end-to-end | 16.7 s |
| p95 end-to-end | 12,008 s (the approval wait dominates. Report active time, end-to-end minus `human_wait`, beside it) |
| Retries | 2 |
| Missing spans | 1 |
| Total model cost | $0.320 at synthetic prices |
| Cost per verified outcome | $0.080, counting every dollar spent (failed and retried work included) over verified outcomes only |
| Model claims refused | 2 (one each in wf-partial and wf-missing) |

## 3. Gap matrix

Options: (a) a small extension to Havn's telemetry, (b) LangSmith, (c) OpenTelemetry to any backend.

| Dimension | Today | (a) Extend | (b) LangSmith | (c) OTel | Pick |
|---|---|---|---|---|---|
| Workflow / run / span correlation | Only the session id. An ai-sdk subagent lands under `ai-sdk:<cwd>`. A restart splits one job into two sessions. | Workflow id as `runId`, span marks, and passing `guardSession` to subagents. Shown working. | Native (`trace_id`, `parent_run_id`, `dotted_order`; confirmed against a local mock). A restart needs the workflow id carried by hand, same as (a). | Native trace and span ids. Restart needs the same manual carry. | a |
| Parent/child hierarchy | None | Shown, including orphan detection | Native | Native | a |
| Model, tool, orchestration and human-wait timings | Tool-call instants only | Shown, with time split by kind | Model and tool spans come automatically from `wrapClaudeAgentSDK` and the Vercel AI SDK wrapper. Human wait and orchestration need manual spans. | AI SDK 6 `experimental_telemetry` gives model and tool spans. The rest is manual. | a |
| Destination-state verification | None | `verify` spans read the destination and feed the obligations. Shown with the mock mailbox; real adapters still to build. | Not provided. Its evaluators judge the trace (LLM or code over inputs and outputs) and never read the mailbox. You would still build (a). | Not provided | a |
| Completion authority | Obligations exist but are unwired and in memory | Rebuilt from the log on restart (shown). #197 wires it in. | None. A trace's status is whatever the writer PATCHes. | None | a |
| Costs and retries | Tokens on ai-sdk only, none on subscription. Retries only in pino. | Tokens on model spans, a price table at report time, and attempt numbers on tool spans. Shown. The Agent SDK result message also reports usage and cost, which can go on the root span. | Computes cost from token counts. Retries show as sibling runs. | Tokens via GenAI semantic conventions. Cost is up to the backend. | a |
| Cost per verified outcome | Impossible | Shown | Has cost but no idea what "verified" means unless (a) feeds it back as feedback | Same | a |
| Missing-span detection | Only whole-log silence (the witness check) | Open spans and orphans flagged per workflow (shown). Can go into the hourly witness check. | Runs that never end show as pending. No alert. | Backend-dependent | a |
| Tamper evidence | Strong (chain plus witness) | Inherited unchanged | None. Runs are mutable by the API key holder. | None | a |
| Evaluation | Offline cert harness (`src/eval`) | Keep extending it on fixtures | Strong: datasets, experiments, online evaluators, annotation queues | None | **b, deferred**, on synthetic data only |
| Export and retention | Box keeps everything; the witness keeps fingerprints | Plain JSONL. Rotation stays our call. | 14-day base, 180-day extended (pricing page today). Export by API. | Any backend | a |
| Privacy | Content never leaves the box; the witness gets hashes | Unchanged. The workflow id goes off-box in clear, so it must stay opaque (no client names). | Off-box by default. `hideInputs` works (verified), but outputs are sent in clear unless `hideOutputs` is also set. With both on, it is a timing viewer. | Depends on the backend | a |
| Instrumentation effort | | 4 to 6 days | 1 to 2 days for SDK wiring, plus all of (a)'s verification anyway, plus the privacy and legal work | About 1 day as a dual-write from the same tracer | a |

## 4. LangSmith specifics (public docs, pricing page, SDK 0.11.0 source)

- **No account needed to test.** The JS SDK ran against a local mock HTTP server with `apiUrl` overridden and a fake key, in a scratch directory outside the repo. It sent POST and PATCH requests to `/runs` with `trace_id`, `parent_run_id`, `dotted_order` and runtime metadata. `hideInputs` replaced the inputs. Outputs were still sent in clear. Nothing went to LangChain.
- **Integrations.**
  - `wrapClaudeAgentSDK` (experimental) and Vercel AI SDK middleware both exist, so both Havn runtimes could be wrapped.
  - An OTel exporter exists under `experimental/otel`. It needs the optional `@opentelemetry/*` peer dependencies.
- **Pricing (as of 2026-10-22).**
  - Developer is $0 with 5k base traces a month and 1 seat.
  - Plus is $39 per seat per month with 10k base traces a month.
  - Enterprise is custom.
  - The pricing page says "pay as you go" without a number. Third-party summaries conflict: some give $2.50 per 1k base traces and $5 per 1k extended, newer ones give $5 per 1k base. Confirm on the live page before quoting.
  - Online evaluators and automation rules can silently upgrade traces to extended retention, which costs more.
- **Volume and cost at Havn's scale.** About 50 workflows a day per box is roughly 1.5k traces a month, so price is not the obstacle. Three boxes fit the free tier. At ten boxes on Plus, expect about $39 to $90 a month.
- **Retention.** 14 days for base traces and 180 days for extended. The extended maximum was reported cut from 400 days in September 2026.
- **Data residency.**
  - Cloud: US or EU region.
  - Hybrid: SaaS control plane, data still in LangChain's cloud.
  - Self-hosted, with data in our VPC, is Enterprise only.

### Privacy: why this decides it

Havn boxes read client Gmail. Google's API Services User Data Policy (Limited Use) restricts transfer of Gmail data to third parties: it is allowed to provide user-facing features, for security, to comply with law, or in a merger. It also bars humans from reading the data except with consent, for security, or for law.

A default LangSmith trace of a model span contains the prompt, and on Havn the prompt is email content. Shipping it to LangChain is a new third-party transfer that would have to be:

- disclosed in the Google verification (spike #208);
- covered by the restricted-scope security assessment;
- added to Havn's privacy terms.

An operator browsing those traces is also "humans reading" the data.

The only compliant LangSmith setup is `hideInputs` plus `hideOutputs` plus metadata scrubbing. That leaves names and timings, which (a) already has locally, with tamper evidence on top.

## 5. Cost and effort estimate

**(a) Extend (recommended): 4 to 6 days, $0 recurring.**

| Work | Estimate |
|---|---|
| Runtime wiring: a root `request` span at the bot and scheduler entry points, `authorize` at `gateToolCall`, `model` spans from the usage callbacks (ai-sdk) and the Agent SDK result message (claude), and `tool` spans around gate and result. The workflow id is persisted on the task row and the outbox entry so a restart resumes it. | 1.5 d |
| Subagent correlation: pass `guardSession` in `buildSubagentTool`, and pass the parent span to the subagent | 0.5 d |
| #197: obligations at run start, plus `verify` adapters. Gmail first (find the sent message by Message-ID in the Sent folder), then Calendar (the event by id). | 1 to 2 d |
| An `npm run outcomes` report (p50/p95 with active time, unresolved, reopened, cost per verified outcome) and a line in the monthly audit digest | 1 d |
| Add open-span and unmet-obligation checks to the hourly witness check | 0.5 d |

Disk use is about 20 events of roughly 400 B per workflow, so around 12 MB a year per box at 50 workflows a day.

**(b) LangSmith: 2 to 3 days on top of (a), plus privacy and legal work, $0 to $90 a month at the current fleet size.** The verification and obligation work is not optional on this path either, because LangSmith cannot provide it. The extra work is SDK wrapping, configuring redaction, a DPA review, a privacy-policy change and a Google verification disclosure.

**(c) OTel: about 1 day, when needed.** Emit the same spans through `@opentelemetry/api` as a dual-write from `OutcomeTracer`, with field names kept close to the GenAI semantic conventions. That leaves the backend open, including LangSmith's OTLP endpoint or a self-hosted Tempo or Jaeger.

## 6. Decision

**Extend (a).** Build it as the #197 follow-up, together with the subagent `guardSession` fix.

**Defer LangSmith (b).** Revisit when any of these is true:

1. Havn has a synthetic, client-free eval dataset worth running experiments on. LangSmith's evaluation UI is then the one thing it does that Havn's own harness does not.
2. A client with no Google data asks for it.
3. Self-hosted LangSmith becomes available at a price that fits.

**Defer OTel (c)** until the fleet passes about five boxes, or someone wants a dashboard across them. Keep span fields mappable so it stays a small job.

## 7. Limitations

- **Synthetic setup.** Six scripted workflows, an injected clock, made-up token counts and prices. The p50/p95 and cost figures show that the metrics can be computed. They are not measurements.
- **"Independent" verification here means independent of the model, not of the host.** The box's own code writes the `verify` span. A compromised box could fabricate one, and the witness would show only that it was written, not that it was true. Real independence would need a second reader of the destination off the box, and for Gmail that is itself another data transfer.
- **The off-box witness cannot rebuild the tree.** Span structure lives in `detail`, which it holds only as a hash. Off the box you can count events per workflow id and nothing more.
- **The Claude runtime's subagent attribution was not exercised.** That runtime passes the SDK hook's `session_id`, which parent and subagent share. This was read from the code, not tested.
- **LangSmith was exercised only against a local mock** (the non-batched `/runs` path). Pricing figures beyond the plan table come from third parties and conflict with each other.
- **No real Gmail or Calendar verify adapter was built.** The mock mailbox stands in.
