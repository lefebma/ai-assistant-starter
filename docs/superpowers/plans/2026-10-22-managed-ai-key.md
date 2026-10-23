# Managed AI Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A hosted box can run on an operator-supplied, workspace-capped Anthropic key; when the cap hits it stops cleanly, tells the owner once, and Umi alerts Marc (with Send-button drafts for Marina).

**Architecture:** Part A (starter repo) adds a small `src/ai-limit.ts` module (managed flag, limit marker file, error classifier, owner reply text), routes the `claude` runtime onto the key as its only lane when managed, and gates every model caller on the marker. Part B (Umi repo) teaches `hosted-probe` to read the marker over SSH, adds an `ai-limit` health state with folded whole-account alerts, and adds Telegram buttons that send a stored partner email exactly once.

**Tech Stack:** TypeScript (Node 22, `/usr/local/bin/node`), vitest, Claude Agent SDK (`claude` runtime), grammY bot (Umi), raw Telegram Bot API (probe).

**Spec:** `docs/superpowers/specs/2026-10-22-managed-ai-key-design.md` (same branch). Code surveys: `/private/tmp/claude-501/-Users-marclefebvre-Projects-ClaudeClaw/e9d74dbb-9903-480f-8e50-8a10b7bd209c/scratchpad/survey-starter.md` and `survey-umi.md` (file:line references below come from them).

## Global Constraints

- Starter work: worktree `~/Projects/ai-assistant-starter-managed-ai`, branch `feat/managed-ai-key`. Umi work: a new worktree `~/Projects/ClaudeClaw-managed-ai`, branch `feat/managed-ai-alerts`. **This machine is the MacMini that runs Umi live from `~/Projects/ClaudeClaw/dist`: never run `npm run build` or `npm run dev` in the main ClaudeClaw checkout, never restart Umi or the probe.** Merging, deploying and restarting need Marc's explicit OK.
- Non-managed boxes behave exactly as today. Every new behaviour is behind `isManagedAi()` or the presence of the marker file (which only a managed box writes).
- No retry, no lane switch, no fallback after a limit error on a managed box.
- The key never appears in logs, chat replies, the marker file, the audit log, tests' snapshots, or the repo. It reaches the box only over stdin.
- No price or limit amount anywhere in either repo.
- Owner-facing copy (exact): first reply `I've reached this month's AI allowance, so I'm paused for now. Your provider has been told and will be in touch.`; repeat reply (at most once per 24 h) `Still paused: this month's AI allowance is used up. Your provider has been told.`; voice `Voice messages aren't available on this assistant.`; secrets `This assistant's AI connection is managed for you, so that key can't be changed here.`
- Marina drafts (exact): subject `[Client]'s assistant is paused`, body `[Client]'s assistant has reached this month's AI allowance and is paused. I'm reviewing it and will let you know when it's back.`; recovery subject `[Client]'s assistant is back`, body `[Client]'s assistant is working again.` `[Client]` = the registry `owner` field. Signature appended from the ELS signature block in ClaudeClaw `CLAUDE.md`.
- Writing rules for all copy: no em dashes, plain language.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Security-sensitive: read ClaudeClaw `reference/security-playbooks/README.md` and the secret-handling playbook before Task A2 and Task B2.
- Starter version: 1.42.0 (new feature).

## Rulings made while planning (spec left these to the builder)

- **Managed flag is a file, not `.env`.** `store/managed-ai.json` (`{ "since": ISO }`). `.env` existing means "already set up" (server.ts:206), so the operator could not mark a box managed before web setup. The file also reads cheaply from separate processes (dreaming) and over SSH.
- **The key lives in the vault** as `ANTHROPIC_API_KEY` (vault wins in `getSecret`, src/vault/index.ts:33). No `.env` line.
- **Recovery:** while the marker is set, a real model call is allowed only when 15 minutes have passed since `since`/`lastProbeAt`; that call sets `lastProbeAt` first. Success clears the marker.
- **Scheduler while paused:** advance `next_run` without running (no "Running:" announce, no result send).
- **Classifier patterns are provisional** until Task A9 captures the real CLI text; tests use fixtures that A9 replaces.

## Review Focus

1. A limit error that arrives as a `result` event with `is_error: true` (not thrown) must still be classified, not delivered as the answer. (Test in A2.)
2. A thrown tier-cap 429 must not be retried by `isRetryableError` (claude.ts:123). (Test in A2.)
3. Email alerts must not `markSeen` mail while paused, or that mail is lost. (Test in A4.)
4. A paused box that receives 20 owner messages sends exactly one full reply and no more than one short reply per 24 h. (Test in A3.)
5. A Send button pressed twice, or pressed after a probe restart, sends one email. (Test in B2.)

---

## Part A: starter repo

### Task A1: `src/ai-limit.ts` module

**Files:**
- Create: `src/ai-limit.ts`
- Test: `tests/ai-limit.test.ts`

**Interfaces:**
- Produces:
  - `export type AiLimitKind = 'spend_limit' | 'billing' | 'org_cap'`
  - `export interface AiLimitMarker { kind: AiLimitKind; since: string; lastRequestId?: string; lastProbeAt?: string; lastToldAt?: string; toldFull?: boolean }`
  - `export function isManagedAi(storeDir?: string): boolean` (exists `store/managed-ai.json`)
  - `export function readAiLimit(storeDir?: string): AiLimitMarker | null` (missing or corrupt file: null)
  - `export function writeAiLimit(m: AiLimitMarker, storeDir?: string): void` (tmp + rename, pattern of `saveRegistry` in src/workspace/registry.ts)
  - `export function clearAiLimit(storeDir?: string): void`
  - `export function classifyAiError(text: string): { kind: AiLimitKind; requestId?: string } | null`
  - `export function recoveryDue(m: AiLimitMarker, now: Date, intervalMs?: number): boolean` (default 15 min)
  - `export function ownerPauseReply(m: AiLimitMarker, now: Date): { text: string; next: AiLimitMarker } | null` (null = stay silent)
  - `export const AI_LIMIT_FILE = 'ai-limit.json'`, `export const MANAGED_AI_FILE = 'managed-ai.json'`
  - `storeDir` defaults to `STORE_DIR` from src/config.ts.

- [ ] **Step 1: Write failing tests** in `tests/ai-limit.test.ts`, each against a fresh `mkdtempSync` dir:
  - `isManagedAi` false with no file, true after writing `managed-ai.json`.
  - `writeAiLimit` then `readAiLimit` round-trips; a file containing `{oops` reads as null; `clearAiLimit` on a missing file does not throw.
  - `classifyAiError`: `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This workspace has reached its spend limit"},"request_id":"req_011ABC"}` gives `{ kind: 'spend_limit', requestId: 'req_011ABC' }`; a 400 `invalid_request_error` about prefill gives null; `402 billing_error` gives `billing`; `429 rate_limit_error` mentioning `spend cap` gives `org_cap`; a plain `429 rate_limit_error` with `Number of request tokens has exceeded your per-minute rate limit` gives null; `Claude AI usage limit reached` (subscription text) gives null.
  - `recoveryDue`: false at since+14 min, true at since+15 min; uses `lastProbeAt` when set.
  - `ownerPauseReply`: first call returns the exact first reply from Global Constraints and `next.toldFull === true`; a second call 1 h later returns null; a call 25 h after `lastToldAt` returns the exact repeat reply.
- [ ] **Step 2: Run** `npx vitest run tests/ai-limit.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Classifier: match the HTTP status and error type first, then a small list of message patterns per kind in one exported const `LIMIT_PATTERNS` so A9 can extend it; `requestId` from `/req_[A-Za-z0-9]+/`.
- [ ] **Step 4: Run** the test file. Expected: PASS. Run `npm run typecheck`.
- [ ] **Step 5: Commit** `ai-limit: managed flag, limit marker and error classifier (#158)`.

### Task A2: managed lane in the `claude` runtime

**Files:**
- Modify: `src/runtime/types.ts:61` (`AgentRunResult`), `src/runtime/claude.ts` (`run` :263, `runOnLane` :317, `runOnce` :214, catch block :502-547, result handling :429-434), `src/agent.ts:50-60`
- Test: `tests/claude-runtime-managed.test.ts` (mock pattern of tests/claude-runtime-cancel.test.ts)

**Interfaces:**
- Consumes: A1's `isManagedAi`, `readAiLimit`, `writeAiLimit`, `clearAiLimit`, `classifyAiError`, `recoveryDue`.
- Produces: `AgentRunResult` gains `aiPaused?: AiLimitKind`; `runAgent` returns it through. `runOnce` on a managed box throws `export class AiPausedError extends Error { kind: AiLimitKind }` (exported from src/ai-limit.ts) instead of calling the model while paused or when a limit is hit.

- [ ] **Step 1: Write failing tests** (mock `@anthropic-ai/claude-agent-sdk`, `../src/env.js`, `../src/vault/index.js`, and point `isManagedAi`/marker at a temp store dir via `AGENT_STORE_DIR` or a mocked module):
  - managed + key: the first `query` call's `options.env.ANTHROPIC_API_KEY` equals the key, and `query` is called once (no subscription attempt).
  - managed, no key: `run()` returns text `The AI connection for this assistant is not set up yet.` and never calls `query`.
  - managed: a thrown `API Error: 400 ... spend limit ...` returns `{ text: null, aiPaused: 'spend_limit' }`, writes the marker with `lastRequestId`, and `query` was called once (no retry, no overflow lane).
  - managed: a thrown tier-cap 429 fixture returns `aiPaused: 'org_cap'` after one call (Review Focus 2).
  - managed: a `result` event `{ type:'result', subtype:'success', is_error:true, result:'API Error: 400 ... spend limit ...' }` returns `aiPaused`, not that text (Review Focus 1).
  - managed + marker set, recovery not due: `run()` returns `aiPaused` with zero `query` calls; recovery due and the call succeeds: marker is cleared and the text is returned.
  - not managed: behaviour unchanged (existing claude-runtime tests still pass; a limit-looking 400 is not classified).
  - managed: the logged error objects (`vi.mock('../src/logger.js')`) never contain the key string, and an ordinary error's chat text (`Ran into an error...`) has the key replaced by `[redacted]` if present.
  - managed `runOnce`: injects the key env; while paused throws `AiPausedError` without calling `query`.
- [ ] **Step 2: Run** `npx vitest run tests/claude-runtime-managed.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `run()`, branch first on `isManagedAi()`: pre-check marker (`recoveryDue`, set `lastProbeAt` before the call), then a single `runOnLane(options, sessionId, cwd, key)`; never reach the overflow block (:284-302). In `runOnLane`, run `classifyAiError` on thrown errors before `isUsageLimitError` (:530) and `isRetryableError` (:534), and on `result` events with `is_error` true; only on managed. Pass `aiPaused` back through `LaneOutcome` and `AgentRunResult`. Scrub the key from the `:547` detail string.
- [ ] **Step 4: Run** the new file and the full suite `npx vitest run`. Expected: PASS. `npm run typecheck`.
- [ ] **Step 5: Commit** `runtime: managed key as the only lane, stop on spend limits (#158)`.

### Task A3: owner reply in chat

**Files:**
- Modify: `src/bot.ts` `handleMessage` (:171, after `runAgent` at :286, before `if (!response)` :302)
- Test: `tests/bot-ai-paused.test.ts` (pattern of tests/bot-pipeline.test.ts)

**Interfaces:**
- Consumes: `runAgent(...).aiPaused` (A2), `readAiLimit`, `writeAiLimit`, `ownerPauseReply` (A1).

- [ ] **Step 1: Write failing tests:** with `runAgent` mocked to return `{ text: null, aiPaused: 'spend_limit' }`: the first message sends the exact first reply; 19 more messages within an hour send nothing; a message 25 h later sends the exact repeat reply; no conversation turn is saved (`saveConversationTurn` not called) on any of them (Review Focus 4). A normal reply path is unchanged.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement:** when `aiPaused` is set, call `ownerPauseReply`, write `next`, send the text if any via the adapter, return early.
- [ ] **Step 4: Run** it and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `bot: tell the owner once when the AI allowance is used up (#158)`.

### Task A4: background callers skip while paused

**Files:**
- Modify: `src/scheduler.ts` `runDueTasks` (:73; insert after the chat-lane check ~:87 and the `computeNextRun` block), `src/email-alerts/service.ts` `tick` (:288, top), `src/email-alerts/cli.ts:42` (replay), `src/dreaming/index.ts` `runDream` (:172), `src/selftest.ts:155`
- Test: `tests/ai-paused-background.test.ts`

**Interfaces:**
- Consumes: `readAiLimit`, `recoveryDue`, `AiPausedError` (A1/A2). Use a helper `export function aiPausedNow(now?: Date, storeDir?: string): boolean` added to `src/ai-limit.ts` = marker set and recovery not due.

- [ ] **Step 1: Write failing tests:**
  - scheduler: with the marker set, a due task's `next_run` advances, `runAgent` is not called, and the sender is never called (no "Running:" and no result).
  - email alerts: `tick` with the marker set returns `{ sent:0, held:0, paused:0, triaged:0 }`, and neither `markSeen` nor `deps.triage` is called (Review Focus 3).
  - replay CLI: returns `The assistant's AI allowance for this month is used up, so a replay can't run now.` without a model call.
  - dreaming: `runDream()` resolves without calling the runtime and without the failure notification.
  - selftest: reports the model check as `skipped (AI allowance used up)` instead of calling it.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** each guard as one early check using `aiPausedNow()`. Log once at info, not error.
- [ ] **Step 4: Run** it and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `Pause scheduled jobs, email alerts and dreaming while the AI allowance is used up (#158)`.

### Task A5: `managed-ai` operator command

**Files:**
- Create: `scripts/managed-ai.ts` (pattern of scripts/profile.ts), `src/managed-ai-cli.ts`
- Modify: `package.json` (script alias `managed-ai`)
- Test: `tests/managed-ai-cli.test.ts`

**Interfaces:**
- Produces: `export async function main(argv: string[], deps: { stdin: () => Promise<string>; vault: { set(name: string, v: string): void; has(name: string): boolean }; storeDir: string; envExists: boolean }): Promise<string>`
  - `set`: reads the key from stdin, trims, rejects anything not starting `sk-ant-api` with `That doesn't look like an Anthropic API key.`, stores `ANTHROPIC_API_KEY` in the vault, writes `managed-ai.json`, clears any limit marker. Output: `Managed AI key saved.` plus, when `envExists`, `Restart the service to use it: sudo systemctl restart havn`.
  - `status`: `Managed: yes|no. Key: stored|missing. Limit: none|<kind> since <since>.` Never prints the key.
  - `off`: removes `managed-ai.json` and prints `Managed AI is off. The stored key was left in the vault.`
  - anything else: usage line, exit 1.

- [ ] **Step 1: Write failing tests** for each command, including: the key never appears in any output; a key passed as an argv entry is refused with `Pass the key on stdin, not on the command line.`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** (stdin reader from scripts/vault-cli.ts:19).
- [ ] **Step 4: Run.** Expected: PASS. `npm run build` compiles `dist/scripts/managed-ai.js`.
- [ ] **Step 5: Commit** `managed-ai command: put an operator key on a box over stdin (#158)`.

### Task A6: setup skips the AI step on a managed box

**Files:**
- Modify: `src/setup/plan.ts` (`EngineChoice` :21 add `'managed'`; `buildEnvContent`), `src/setup/web/answers.ts` (`parseEngine` :80, `answersFromWeb` :137), `src/setup/web/server.ts` (`/setup/api/state` :263, `finish` :192-225), `templates/web-setup/index.html` (step list :59, `show` :160-162, state handling :290), `src/setup/wizard.ts` (`askEngine` :317 call site, `askVoice`), `src/setup/credentials.ts:78`
- Test: extend `tests/web-setup-server.test.ts`, `tests/web-setup-answers.test.ts`, `tests/setup-wizard.test.ts`

**Interfaces:**
- Consumes: `isManagedAi` (A1).
- `buildEnvContent` for `engine: 'managed'` writes no `AGENT_RUNTIME`, `AI_PROVIDER`, `AI_MODEL` or key lines, and no voice keys.

- [ ] **Step 1: Write failing tests:**
  - `/setup/api/state` includes `managedAi: true` when `store/managed-ai.json` exists, false otherwise.
  - `finish` on a managed box ignores any posted `engine` and writes answers with `engine: 'managed'`; the vault gets no provider key from the request.
  - `buildEnvContent({ engine: 'managed', ... })` contains none of `AGENT_RUNTIME=`, `AI_PROVIDER=`, `ANTHROPIC_API_KEY=`, `OPENAI_API_KEY=`.
  - the page, given `managedAi: true`, shows one step (subtitle `One short step.`) and finishing step 1 posts `engine: { kind: 'managed' }` (assert on the HTML/script text the existing tests use).
  - the terminal wizard on a managed box never asks the engine or voice questions.
  - credentials check passes on a managed box with the vault key.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `Setup: no AI step on a managed box (#158)`.

### Task A7: voice, video and secrets on a managed box

**Files:**
- Modify: `src/bot.ts` (:773, :1241, :1363, `/secret` handling :1295/:1456), `src/media.ts` (:93, :105), `src/voice.ts` (`voiceCapabilities` :23)
- Test: `tests/managed-ai-features.test.ts`

- [ ] **Step 1: Write failing tests:** on a managed box `voiceCapabilities()` returns `{ stt:false, tts:false }`; a voice note gets exactly `Voice messages aren't available on this assistant.`; `/voice` and `/voice ui` get the same text; no reply anywhere contains `OPENAI_API_KEY` or `GOOGLE_API_KEY`; the video hint given to the model reads `Video analysis isn't available on this assistant. Tell the owner that plainly.`; `/secret set ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_API_KEY` gets the exact secrets line from Global Constraints and stores nothing. Non-managed: all existing texts unchanged.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with one `isManagedAi()` check per site.
- [ ] **Step 4: Run** it and the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `Managed boxes: voice and video off, AI keys not changeable from chat (#158)`.

### Task A8: runbook, changelog, version

**Files:**
- Create: `docs/MANAGED-AI-KEY.md`
- Modify: `docs/HOSTED-VPS.md:300-302` (replace the "card #159 will remove this step" note with a link), `CHANGELOG.md`, `VERSION` (1.42.0)
- Test: existing `tests/docs-promise-shipped-paths.test.ts`, `tests/update-changelog.test.ts`

- [ ] **Step 1: Write the runbook** following spec section 2 steps 1-7, using the real command as `havn-admin`: `sudo -u havn bash -lc 'cd ~/havn && node dist/scripts/managed-ai.js set'`, pasting the key at the waiting prompt and pressing Ctrl-D, so it never lands in shell history or on a command line. Include what Marc sees when the limit hits and how to raise it. No amounts.
- [ ] **Step 2: CHANGELOG** `## 1.42.0 - <date>` with a one-line summary and `**New:**` bullets in owner language (an assistant can run on an AI allowance supplied by its provider; it pauses and says so when the month's allowance is used up). Bump `VERSION`.
- [ ] **Step 3: Run** `npx vitest run` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 4: Commit** `Docs: managed AI key runbook, v1.42.0 (#158)`.

### Task A9: live capture of the real limit errors (needs Marc)

Marc creates, in the Anthropic Console: a test workspace `havn-limit-test`, the smallest allowed monthly spend limit, and one key. Nothing else in this plan waits on the key except this task.

- [ ] **Step 1:** On this machine (not Umi, not a box), in the worktree: `npm run build`, write `store/managed-ai.json` in a scratch `AGENT_STORE_DIR`, put the test key in a scratch vault over stdin (`AGENT_VAULT_DIR`), and run turns through `ClaudeAgentRuntime` with a small script until the limit is hit. Log the raw thrown error text and any `result` event (redact the key) to the scratchpad.
- [ ] **Step 2:** Replace the provisional fixtures in `tests/ai-limit.test.ts` and `tests/claude-runtime-managed.test.ts` with the captured text; extend `LIMIT_PATTERNS` narrowly. Re-run the suite: PASS.
- [ ] **Step 3:** Raise the limit in the Console, run one more turn after 15 minutes, confirm the marker clears and the reply returns.
- [ ] **Step 4: Commit** `ai-limit: match the real spend-limit text (#158)`. Marc archives the test workspace afterwards.

---

## Part B: Umi repo (worktree `~/Projects/ClaudeClaw-managed-ai`)

### Task B1: probe reads the marker; `ai-limit` state; folded alerts

**Files:**
- Modify: `scripts/hosted-probe.ts` `REMOTE_SCRIPT` (:58-74), `src/hosted/status.ts` (`HealthState` :11, `SshFacts` :13, labels ~:125, `parseProbeOutput` :140, `deriveHealth` :178, `AlertKind`/`decideAlerts` :359)
- Test: extend `tests/hosted-status.test.ts`

**Interfaces:**
- Produces: `HealthState` adds `'ai-limit'` (label `AI limit reached`); `SshFacts.aiLimit?: { kind: 'spend_limit' | 'billing' | 'org_cap'; since: string }`; `AlertKind` adds `'ai-limit'` and `'ai-org-cap'`; `AlertDecision` gains `aiKind?: 'spend_limit' | 'billing' | 'org_cap'`; `export function foldOrgCap(decisions: AlertDecision[]): AlertDecision[]`.

- [ ] **Step 1: Write failing tests:**
  - `parseProbeOutput` with `ai_limit={"kind":"spend_limit","since":"2026-11-06T10:00:00Z"}` sets `aiLimit`; an empty or non-JSON value leaves it undefined.
  - `deriveHealth`: an active service with `aiLimit` gives state `ai-limit`, reason `spend limit` / `billing problem` / `whole account cap`; offline and pending still win over it.
  - `decideAlerts`: online to `ai-limit` gives kind `ai-limit` with text `<name> has hit its monthly AI limit and is paused. Raise the limit for workspace <name> in the Anthropic Console, or leave it until the month resets.` (billing: `<name> is paused: Anthropic reports a billing problem on the account.`); the 6 h reminder applies; `ai-limit` to online gives `recovered` with text `<name> is answering again.`
  - `foldOrgCap`: three `ai-limit` decisions with `aiKind: 'org_cap'` become one `ai-org-cap` decision with text `The whole Anthropic account has hit its monthly cap; every managed box is paused (<names>).`; other decisions pass through.
  - an `ai-limit` box is never sent to the restart path (assert `deriveHealth` keeps `serviceActive` true and the probe's restart guard condition is false).
- [ ] **Step 2: Run** `npx vitest run tests/hosted-status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Remote line: `'echo ai_limit=$(tr -d "\\n" < "$HOME/havn/store/ai-limit.json" 2>/dev/null)'`. Check the Kai dashboard cockpit (`~/clawd/dashboard`) for code that switches on the state union and give `ai-limit` the degraded styling there if needed (read-only check; report if a change is required).
- [ ] **Step 4: Run** it, `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `hosted-probe: AI limit state from the box marker, one alert for a whole-account cap (#158)`.

### Task B2: partner drafts with a Send button

**Files:**
- Create: `src/hosted/partner-drafts.ts`
- Modify: `src/hosted/alert.ts` (`sendTelegramAlert` :8, add `buttons`), `src/bot.ts` (callback handler :1363, new `pd:` branch modelled on `ea:`), `src/hosted/status.ts` (`StaticInstance` :50, `InstanceSpec`, `mergeInstances` :235: add `partnerName?`, `partnerEmail?`)
- Test: `tests/partner-drafts.test.ts`, extend `tests/hosted-alert.test.ts`

**Interfaces:**
- Produces:
  - `sendTelegramAlert(text, opts: { token?; chatId?; fetchImpl?; buttons?: { text: string; data: string }[] })` adds `reply_markup: { inline_keyboard: [buttons] }` when given.
  - `export interface PartnerDraft { id: string; box: string; kind: 'paused' | 'back'; to: string; partnerName: string; subject: string; body: string; createdAt: string; sentAt?: string; sending?: boolean }`
  - `export function createDraft(input: Omit<PartnerDraft, 'id' | 'createdAt'>, file?: string): PartnerDraft` (file default `store/partner-drafts.json`, tmp + rename, id 8 hex chars)
  - `export function pendingPausedDraft(box: string, file?: string): PartnerDraft | null` (latest `paused` draft for the box with no later `back` draft)
  - `export async function handlePartnerDraftButton(data: string, deps: { send: (to: string, subject: string, body: string) => Promise<boolean>; file?: string }): Promise<string>` returns the toast text. Data format `pd:send:<id>` / `pd:skip:<id>` (under 64 bytes).
  - `send` default shells out to `/usr/local/bin/node ~/clawd/scripts/outlook-email.js send <to> <subject> <body>` with `execFile` (argument array, no shell).

- [ ] **Step 1: Write failing tests:**
  - `handlePartnerDraftButton('pd:send:<id>')` calls `send` once and returns `Sent to <partnerName>.`; a second press returns `Already sent.` and does not call `send` (Review Focus 5); a press while `sending` is true returns `Already sending.`; a `send` that returns false clears `sending`, leaves `sentAt` unset and returns `Couldn't send. Try again.`
  - `pd:skip:<id>` marks it handled with no send and returns `Skipped.`
  - an unknown id returns `That draft is gone.`
  - draft text for owner `Leif` matches the exact Global Constraints copy with `[Client]` replaced, plus the ELS signature.
  - `sendTelegramAlert` with buttons posts `reply_markup.inline_keyboard[0][0] = { text: 'Send to Marina', callback_data: 'pd:send:<id>' }`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Persist `sending: true` before calling `send` and `sentAt` after, so a crash mid-send leaves `sending` set (a later press says `Already sending.`; Marc can check Outlook). The bot branch: primary chat only, `answerCallbackQuery` with the toast, then remove the keyboard. Never forward to the agent.
- [ ] **Step 4: Run** the files and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `Partner drafts: Send to Marina button on hosted alerts, sent once (#158)`.

### Task B3: wire drafts into the probe; registry fields

**Files:**
- Modify: `scripts/hosted-probe.ts` send loop (:247-252), `config/hosted-instances.json` (add `partnerName: "Marina"`, `partnerEmail` for havn-marina and havn-leif; address from `projects/els-partners/bd/marina-partnership/STATE.md`)
- Test: extend `tests/hosted-status.test.ts` with a pure `export function draftsFor(decision: AlertDecision, spec: InstanceSpec, hasPausedDraft: boolean): Omit<PartnerDraft, 'id'|'createdAt'> | null` in `src/hosted/partner-drafts.ts`

- [ ] **Step 1: Write failing tests** for `draftsFor`: `ai-limit` with `aiKind: 'spend_limit'` on a box with a partner gives a `paused` draft; `billing` and `ai-org-cap` give null; `recovered` gives a `back` draft only when `hasPausedDraft`; a box with no partner always gives null.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** `draftsFor` and, in the probe send loop, create the draft and attach `[{ text: 'Send to Marina', data: 'pd:send:<id>' }, { text: 'Skip', data: 'pd:skip:<id>' }]`, with the draft body quoted under the alert text. Apply `foldOrgCap` to the decisions before sending.
- [ ] **Step 4: Run** the suite and `npx tsc --noEmit`. Expected: PASS. Dispatch `umi-tester` for the Umi branch.
- [ ] **Step 5: Commit** `hosted-probe: partner drafts on AI limit and recovery alerts (#158)`.

### Task B4: end-to-end on havn-test (after 2026-11-05, needs Marc)

- [ ] **Step 1:** Marc merges and releases the starter (1.42.0), and OKs deploying the Umi branch (build, restart bot and probe).
- [ ] **Step 2:** Marc creates a test key in `havn-limit-test` (A9) and, with OK, it goes onto havn-test with `managed-ai set`; havn-test's registry entry temporarily gets `partnerEmail` = Marc's own address.
- [ ] **Step 3:** Drive havn-test to the limit. Confirm: owner reply once, marker on the box, Telegram alert within 10 minutes with the Send/Skip buttons, Send delivers one email to Marc's address, second press says `Already sent.`, raise the limit, recovery alert with the `back` draft within 25 minutes.
- [ ] **Step 4:** `managed-ai off`, restore havn-test's normal sign-in and registry entry, archive the test workspace. Move Kanban #158 to Verify with a comment.
