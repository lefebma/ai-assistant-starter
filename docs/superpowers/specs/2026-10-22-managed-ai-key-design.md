# Managed AI key for hosted clients (Kanban card #158)

Status: draft for Marc's review, 2026-10-22. Parent: Kanban feature #157 (Hosted AI Model Tiers), Tier 1. (Kanban card numbers are not GitHub PR numbers.)

## Why

Marc wants this option ready for the day an unsophisticated client signs up for hosted Havn with no AI account of their own. Marc supplies the AI: the client never sees an AI sign-in step or an AI bill. No client is waiting on it today.

Marc's stated top worry: **the cost getting away from him.** Every choice below is judged against that first.

## What Marc decided

1. Each such client gets an Anthropic API key from Marc's Anthropic organization, one key per client, in that client's own workspace with a monthly spend limit.
2. When a client hits the limit mid-month, the assistant **stops and Marc is messaged so he can decide** (raise the limit or wait for the month to reset). It does not keep working, and it does not silently wait without telling him.
3. For clients who come through Marina (AIM Assistant powered by Havn), **both Marc and Marina hear about it.** Marina's note is a **draft with a Send button** on Marc's Telegram alert, never sent automatically. It is plain business language, no technical terms (see the Marina comms rule). The **recovered** alert carries a second draft for her ("it's back"), also behind a Send button. Billing problems (402) and whole-account caps go to Marc only, no Marina draft.
4. **Voice and video are off on managed boxes.** No OpenAI or Google key is supplied, so nothing uncapped can spend. Setup hides voice and video for a managed box, and the client must never see a prompt to add an OpenAI or Google key: the builder finds every such message (for example the bot's "add OPENAI_API_KEY" replies) and gives a managed box a plain "voice messages aren't available on this assistant" instead.
5. **Testing:** the live limit test runs now on a local copy of the starter against a tiny test workspace Marc creates in the Console. The end-to-end check (probe alert, Marina buttons, recovery) runs on havn-test after its email-alerts soak ends on 2026-11-05.

## Facts this design rests on (checked 2026-10-22, platform.claude.com docs)

- Workspaces can be created by the Admin API (`POST /v1/organizations/workspaces`) or in the Console.
- **API keys cannot be created by any API.** They are created by hand in the Console. The Admin API only lists, renames and archives them.
- **Workspace spend limits are set in the Console only** (Workspaces page > workspace > Spend limits), with optional alert thresholds. The Default Workspace cannot have one. Workspace limits cannot exceed the organization's limits, and the organization's limit always applies.
- When a workspace or organization spend limit you set is reached, the Messages API returns **HTTP 400 `invalid_request_error`** (the docs give no exact message text). A usage-tier monthly cap returns **429 `rate_limit_error` with no `retry-after`**. Billing problems return **402 `billing_error`**.
- Usage and cost per workspace can be read with the Admin API's usage and cost reports (for Kanban card #163 later, not this card).

## Goals

- An operator runbook that takes Marc from "new client with no AI account" to "box running on its own capped key" in a few minutes of Console clicks plus one command.
- The box runs on that key as its **primary and only** model connection.
- A spend-limit stop is recognised as such on the box, told to the client once in plain words, and reported to Marc within about 10 minutes.
- Marc can see each client's spend in one place (the Anthropic Console, per workspace).

## Non-goals

- Automating key creation. Not possible; a checklist is enough at a few clients a year.
- The 80% warning and the client-visible usage meter. That is Kanban card #159.
- Detecting a client's own key and skipping caps. Kanban card #160.
- The morning-briefing spend line. Kanban card #163.
- Migrating existing boxes (havn-test, Marina's, Leif's) off their current sign-in. They stay as they are; any of them can switch by hand later with the same runbook. *(Claude's call.)*
- Any price or limit amount in this repo. Amounts live in Marc's private `bd/` notes only.

## Anti-goals (a build that technically works but fails Marc)

- Any path where a box keeps spending after the limit: retry loops on the limit error, falling back to another key or to a subscription sign-in, or scheduled jobs re-firing every minute against a dead key.
- The client seeing a raw API error, a stack trace, or a message every time they type.
- Marc learning about it from the client instead of from his own alert.
- Anything sent to Marina without Marc pressing Send.
- The key appearing in logs, the setup page, chat, the audit log, the Kanban board or this repo.

## Design

### 1. Layers of cost protection (strongest first)

1. **Workspace spend limit** in the Anthropic Console, one workspace per client. Anthropic enforces it; nothing on the box can override it.
2. **Organization spend limit** as a backstop above the sum of all clients.
3. **Prepaid credit** rather than open-ended billing is recommended in the runbook, so the worst case is money already spent. Marc's call; the runbook states it as a recommendation.
4. **One key per client**, never shared, scoped to that client's workspace. A leaked key is archived without touching anyone else.
5. **Visibility**: the Console's per-workspace spend; Kanban card #163 later.

### 2. Operator runbook (new section in `docs/HOSTED-VPS.md`, or a new `docs/MANAGED-AI-KEY.md` linked from it)

Steps, written for Marc:

1. Once, ever: put Marc's Anthropic organization on prepaid credit (recommended) and set an organization spend limit.
2. Per client: create a workspace named after the box (for example `havn-leif`). Console, or a small helper script using the Admin API with an Admin key from Marc's vault. The helper is optional; the Console works.
3. In that workspace: set the monthly spend limit, and turn on the Console's own alert thresholds as an extra email to Marc.
4. In that workspace: create one API key named after the box.
5. Put the key on the box with one command run as `havn-admin` (see section 3). The key goes over stdin, never on a command line, never in the transcript.
6. Record in Marc's private notes: box, workspace id, key name (not the key), limit amount.
7. Key rotation and removal: create the new key, run the same command, confirm the box answers, then archive the old key in the Console. Removing a client: archive the workspace (this archives its keys within seconds; it cannot be undone).

### 3. Putting the key on the box

- Provisioning and web setup already support `ANTHROPIC_API_KEY` as an AI choice. This card adds a **managed** marker so the box knows the key is Marc's, not the client's:
  - a setting in the box's `.env`, for example `HAVN_MANAGED_AI=1` (exact name: builder's call), written by the same command that writes the key.
- On a managed box, **web setup skips the AI-access step** and shows nothing about AI accounts. The client sees only the messaging step. (The minimal-setup flow already reduced setup to messaging and AI access; this removes the second for managed boxes.)
- **Runtime: the `claude` runtime, not `ai-sdk`.** *(Claude's call.)* `ai-sdk` already treats an API key as primary, but agents and skills only work fully on `claude`, and the client must get the full assistant. Both the chat lane and the cron lane (`AGENT_RUNTIME_CRON`: email alerts, dreaming, the index job) run on `claude` with the managed key. Errors reach this runtime through the bundled CLI as result text, not HTTP objects, so section 4's classifier works on that text; the builder confirms what the CLI does with a limit 400 (it should not retry a 400) and turns off or bounds any CLI-side retry that would re-send after a limit.
- On a managed box the API key is the **primary lane**. The rule elsewhere in this repo that `ANTHROPIC_API_KEY` is only an overflow lane, never copied into the environment, does not apply here: the builder must make the managed case explicit in the runtime rather than reusing the overflow path, and must keep the non-managed behaviour exactly as it is.
- No subscription sign-in and no other key exists on a managed box, so there is nothing to fall back to. The builder must make sure no code path tries one.
- The command that writes the key must: read it from stdin, write `.env` with the file readable by the havn user only, never echo it, and restart the service after (or say that a restart is needed, matching how other `.env` changes are handled).

### 4. Recognising the limit on the box

- Classify model-call failures into: **spend limit reached** (400 `invalid_request_error` whose message is about a spend or usage limit; 429 with no `retry-after` that is a tier spend cap), **billing problem** (402), and everything else (unchanged handling).
- The exact message text for the 400 is not documented. The builder must capture the real text by hitting a deliberately tiny workspace limit on a test workspace (see Verification), and match on it narrowly. A 400 that is not about a limit must keep today's handling.
- On **spend limit reached** or **billing problem**:
  - Do not retry. Do not try another lane.
  - Write a small marker file in the box's `store/` (for example `store/ai-limit.json`: `{ "kind": "spend_limit" | "billing", "since": <ISO time>, "lastRequestId": "<req_...>" }`). Request id only, never the key.
  - Reply to the owner **once**: plain words, for example "I've reached this month's AI allowance, so I'm paused for now. Your provider has been told and will be in touch." Further messages while the marker is set get a short version at most once a day, or no reply (builder's call, but never one per message).
  - Scheduled jobs and the email-alerts poller skip model calls while the marker is set, quietly, without logging an error per run.
- **Recovery**: while the marker is set, at most one real model call is allowed per check interval (builder's call, for example every 15 minutes, or on the next owner message). On success the marker is deleted, and the next owner message works normally. No restart and no command on the box.

### 5. Telling Marc (Umi side, `scripts/hosted-probe.ts` in ClaudeClaw)

- `hosted-probe` already runs one SSH command per box every 10 minutes and sends state changes to Marc on Telegram, with a 6-hour reminder while a box stays bad. Extend its command to read `store/ai-limit.json`.
- New state **"AI limit reached"** (and **"AI billing problem"**). Entering it sends one Telegram message to Marc: box name, since when, which kind, and what to do ("raise the limit in the Console for workspace havn-leif, or leave it until the month resets"). The existing 6-hour reminder applies. Clearing it sends the existing "recovered" message.
- This state is not an outage: the probe must **not** restart the service for it.
- **Whole-account caps.** *(Claude's call.)* A 429 with no `retry-after` is the organization's usage-tier cap, not one client's limit. The box records it as its own kind (for example `"kind": "org_cap"`). The probe folds every box in that state into **one** Telegram alert ("the whole Anthropic account has hit its monthly cap; every managed box is paused"), with no per-workspace advice and no Marina drafts. The same applies to an organization spend limit if its 400 text can be told apart from a workspace limit's during the live test; if it cannot, it is reported per box.

### 6. Telling Marina (Umi side)

- `config/hosted-instances.json` gets a per-box field naming the partner to notify, for example `"partner": "marina"`, with her address held where Umi keeps contact details today, not in the starter repo.
- For a box with a partner, the Telegram alert carries a **Send to Marina** button with the drafted email shown in the message. Nothing is sent until Marc presses it. The email goes from Marc's ELS address through the existing ELS send script.
- Draft wording, plain business language: "[Client]'s assistant has reached this month's AI allowance and is paused. I'm reviewing it and will let you know when it's back." On recovery: "[Client]'s assistant is working again." No mention of workspaces, keys, APIs or Anthropic.
- Each Send button sends its own email exactly once. A recovery draft is offered only if the limit draft was offered for the same episode.
- How the button is wired is the builder's call. The probe sends Telegram messages directly, not through Umi's chat session, so the builder must choose between handling the button in Umi's bot callback handler, or having the probe hand the alert to Umi (for example as a one-shot scheduled task) so Umi's normal `[[buttons: ...]]` flow applies. Either way, a press must send exactly once.

## Security

This touches secret handling and the runtime's model routing, so it falls under the starter's and Umi's security-sensitive rule: the builder reads `reference/security-playbooks/` (ClaudeClaw) before shipping.

- The key reaches the box only over stdin to the write command.
- `.env` stays readable by the havn user only.
- The starter has no log redaction (Umi does). The builder must make sure no log line, error object, audit entry or chat reply includes the key or a full request with headers, and should add a test that a failed call's logged error does not contain the key.
- The Admin key, if the optional workspace helper is used, stays in Marc's vault and goes to the helper over stdin.

## Verification

- Unit tests: error classification (limit 400, ordinary 400, 429 with and without `retry-after`, 402); marker written once; one owner reply, not one per message; no retry or lane change; scheduled jobs and email alerts skip while the marker is set; recovery clears the marker; non-managed boxes unchanged.
- **Now, local:** a local copy of the starter (on the MacBook, not Umi) running against a test workspace Marc creates with the smallest allowed spend limit and its own key. Run until the limit hits. Capture the real 400 message text into the classifier and its tests. Confirm the owner reply, the marker, that scheduled jobs pause, and recovery after raising the limit.
- **After 2026-11-05, havn-test:** switch it to a managed test key, trigger the limit, confirm the Telegram alert within 10 minutes, both Marina draft buttons (pointed at Marc's own address for the test), and recovery. Then put havn-test back on its normal sign-in.

## Left to the builder

- Exact setting names, file names, wording of the short repeat reply, the recovery interval.
- Whether the workspace helper script is worth writing now.
- Where the runbook lives (new doc or a section in `docs/HOSTED-VPS.md`).
- The button wiring choice in section 6.

## Calls Claude made (Marc to check)

- Existing boxes are not migrated.
- The client message says "your provider" rather than naming Marc or Marina.
- Prepaid credit is a runbook recommendation, not a requirement.
- The Console's own alert emails are switched on as an extra signal, alongside the probe.
