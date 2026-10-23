# Minimal Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setup asks only messaging and AI access. The owner's profile (names, city, tone, bio) is collected by the assistant in the first chat and written into the same files setup writes today.

**Architecture:** Both setup paths save their non-secret answers to `store/setup-answers.json` with a `profilePending` flag, and render the files from provisional values. A new `scripts/profile.ts` CLI (`set` / `skip` / `status`) merges a profile into the saved answers. It re-renders through a filtered `buildSkillPlan` and updates TIMEZONE. The bot greets with welcome questions while the profile is pending, nudges the first three primary-chat turns, auto-skips after that, and restarts after a reply when the CLI asked for it.

**Tech Stack:** TypeScript (Node 20+), vitest, better-sqlite3 app_state, Open-Meteo geocoding.

**Spec:** `docs/superpowers/specs/2026-10-20-minimal-setup-design.md`

## Global Constraints

- Existing installs must not change. A box without `store/setup-answers.json` is never pending, and nothing in this release rewrites its CLAUDE.md, PERSONALITY.md, PROFILE.md or skills on startup or update.
- No question asks for latitude, longitude or a timezone name, on either setup path.
- No optional key is asked unless the operator opts in, through one default-no question in the terminal wizard.
- `store/setup-answers.json` never holds a secret. The `keys` object is dropped entirely before writing, and no token or chat id is stored.
- Name fields keep the existing validation from `parseProfile` (`src/setup/web/answers.ts`): no control characters, no `"` or `\`, owner name ≤ 80 characters, assistant name ≤ 40, city ≤ 80, bio ≤ 600.
- Provisional values:
  - Owner name: the first word of the Telegram pairing name. If that is empty or fails validation, use `the owner`.
  - Assistant name: the bot's `firstName` from getMe, or `Atlas` when there is none.
  - Tone: preset index 1 (`PERSONALITY_PRESETS[1]`).
  - Bio and city: empty.
  - Coordinates: `40.71` / `-74.01`, `celsius`.
- The welcome instruction rides at most 3 inbound turns, in the primary chat only. After the third, if still pending, the bot runs skip.
- While the profile is pending, the interview greeting and the interview nudge are both suppressed.
- Only the city name is sent to Open-Meteo. A failed lookup never blocks `set`.
- No em dashes in any user-facing copy, comments or docs.
- Target release 1.40.0. PR #148 (1.39.0) is expected to merge first. If it has not merged when Task 7 runs, still write 1.40.0.

## Review Focus

1. **City lookup fails or finds nothing** (offline, typo, "the moon"). `set` still succeeds: the city is kept as typed, coordinates and timezone stay unchanged, and the output says the weather location could not be found, without asking for coordinates. (Task 2 test.)
2. **Owner edited PERSONALITY.md before answering the welcome.** `set` keeps the edited file and names it in the output. (Task 2 test.)
3. **Owner ignores the welcome for 3 turns.** Auto-skip clears the flag, and the next turn carries the interview nudge, not the welcome. (Task 5 test.)
4. **`npm run setup` re-run on a pre-1.40 box** (CLAUDE.md exists, no answers file). The profile questions are asked in the terminal, and the names are not reset to provisional. (Task 6 test.)
5. **Telegram name with quotes, emoji only, or an empty first name.** The provisional owner name falls back to `the owner`, and finish does not 400. (Task 4 test.)

---

### Task 1: Saved setup answers and the pending flag

**Files:**
- Create: `src/setup/saved.ts`
- Modify: `src/setup/finalize.ts` (`writeConfiguration` gains an options argument)
- Test: `tests/setup-saved.test.ts`

**Interfaces:**
- Produces:
  - `type SavedSetup = Omit<Answers, 'keys'> & { profilePending: boolean; version: 1 }`
  - `SETUP_ANSWERS_PATH = 'store/setup-answers.json'`
  - `saveSetupAnswers(projectRoot: string, answers: Answers, profilePending: boolean): void`. Drops `keys` and writes JSON with mode 0o600.
  - `loadSetupAnswers(projectRoot: string): SavedSetup | null`. Returns null when the file is missing or unparseable.
  - `isProfilePending(projectRoot: string): boolean`. True only when the file exists and `profilePending === true`.
  - `answersFromSaved(saved: SavedSetup, projectPath: string): Answers`. Sets `keys: {}` and overrides `projectPath`.
  - `PROVISIONAL = { ownerName: 'the owner', assistantName: 'Atlas', vibeIndex: 1, latitude: '40.71', longitude: '-74.01', tempUnit: 'celsius' } as const`
  - `writeConfiguration(answers, creds, projectRoot, home, opts?: { profilePending?: boolean })`. When `opts` is given, it calls `saveSetupAnswers` after the plan is applied. Existing callers that pass no `opts` write no file.

- [ ] **Step 1: Write failing tests** in `tests/setup-saved.test.ts`. Use a tmp dir per test.
  - `saveSetupAnswers strips keys`: answers with `keys: { anthropic: 'sk-x', perplexity: 'p' }`. The file text does not contain `sk-x`, and `'keys' in JSON.parse(text)` is false.
  - `round trip`: save then load gives `profilePending: true`, `version: 1`, and the same `ownerName`.
  - `isProfilePending false without file`, `false for corrupt JSON`, `false when profilePending false`.
  - `writeConfiguration without opts writes no answers file`, and `with { profilePending: true } writes it`. Reuse the fixture answers from `tests/setup-execute.test.ts` or `tests/setup-wizard.test.ts`.
- [ ] **Step 2:** Run `npx vitest run tests/setup-saved.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `src/setup/saved.ts` and the `writeConfiguration` option. `mkdirSync(store, { recursive: true })` before writing.
- [ ] **Step 4:** Run `npx vitest run tests/setup-saved.test.ts tests/setup-execute.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(setup): save non-secret setup answers with a profile-pending flag (#210)`

### Task 2: Applying a profile

**Files:**
- Create: `src/onboarding/profile.ts`
- Modify: `src/setup/web/answers.ts`. `lookUpCity` returns `timezone?: string` from the Open-Meteo result's `timezone` field. Accept it only if `isTimezone()` passes.
- Test: `tests/onboarding-profile.test.ts`

**Interfaces:**
- Consumes: Task 1's `loadSetupAnswers`, `saveSetupAnswers`, `answersFromSaved`. Also `buildSkillPlan`, `applyPlan`, `substituteTemplate`, `PERSONALITY_PRESETS`, `lookUpCity`, `isTimezone`, `buildEmailSignature`.
- Produces:
  - `interface ProfileInput { ownerName?: string; assistantName?: string; city?: string; vibe?: 'professional' | 'friendly' | 'direct' | string; bio?: string }`. Absent fields keep the saved value.
  - `interface ProfileResult { changed: string[]; kept: string[]; place: string | null; placeNotFound: boolean; timezone: string; timezoneChanged: boolean }`. `kept` lists files left alone because the owner edited them.
  - `async applyProfile(projectRoot: string, home: string, input: ProfileInput, deps: { fetch: Fetch; setState?: (k: string, v: string) => void }): Promise<ProfileResult>`. Throws `InputError` (from answers.ts) on invalid input, and when there is no saved setup: message `This assistant was set up before profile changes were possible here. Edit CLAUDE.md and PERSONALITY.md directly.`
  - `skipProfile(projectRoot: string): void`. Sets `profilePending: false` and changes nothing else.
  - `RESTART_AFTER_REPLY_KEY = 'restart_after_reply'`, an app_state key holding an ISO timestamp.

**Behavior (decided by the spec):**
- Vibe: `professional`, `friendly` and `direct` map to `PERSONALITY_PRESETS[0..2]`. Any other non-empty string is a custom vibe (≤ 300 characters, no control characters).
- The email signature is rebuilt from the new owner name with `buildEmailSignature`, but only when the saved signature equals the one built from the old owner name.
- The plan is `buildSkillPlan(merged, home)` with every `secret` action removed, then filtered:
  - **Pending:** keep all `copy`, `edit` and `chmod-exec` actions. For `template` actions with `onlyIfMissing` (PERSONALITY.md, PROFILE.md, decisions/log.md), render the same template with the *old* saved answers' vars. If the file on disk is byte-identical to that render, write the new render; otherwise push it to `kept`. Every other template (CLAUDE.md) is written. PROFILE.md without the `havn:profile-stub` marker is the interview's file: leave it alone and do not list it in `kept`.
  - **Not pending:** keep only the `skills/weather` copy and its manifest edit, and the CLAUDE.md template. Run the same byte-compare for PERSONALITY.md and PROFILE.md, so an unedited file still follows a rename.
- Timezone: if the lookup gives a timezone different from saved `answers.timezone`, replace the `TIMEZONE=` line in `.env`, or append one if missing, and leave every other line untouched. Then call `setState(RESTART_AFTER_REPLY_KEY, new Date().toISOString())`. The default `setState` is `setAppState`.
- Finally `saveSetupAnswers(root, merged, false)`.

- [ ] **Step 1: Write failing tests** in a tmp project. Copy `templates/` in, and run `writeConfiguration(provisionalAnswers, {}, root, home, { profilePending: true })` as the fixture. Use a fake fetch that returns an Open-Meteo body with `latitude: 51.5072, longitude: -0.1276, country_code: 'GB', name: 'London', timezone: 'Europe/London'`.
  - `set renders names`: after `applyProfile({ ownerName: 'Jane', assistantName: 'Nami', city: 'London', vibe: 'direct' })`:
    - `CLAUDE.md` starts with `# Nami` and contains `You are Jane's personal AI assistant`;
    - `PERSONALITY.md` contains `Your name is Nami` and `PERSONALITY_PRESETS[2]`;
    - `skills/decision-log/SKILL.md` contains `Jane` and not `the owner`;
    - `skills/weather/manifest.json` contains `51.51` and `Europe/London`.
  - `set updates TIMEZONE and requests restart`: `.env` starts as `TIMEZONE=America/New_York\nFOO=1\n`. Afterwards it has `TIMEZONE=Europe/London` and `FOO=1`, `setState` was called with `restart_after_reply`, and `timezoneChanged` is true.
  - `same timezone, no restart`.
  - `edited personality is kept` (Review Focus 2): append `\nMy rule.` to PERSONALITY.md first. Afterwards it is unchanged and `kept` contains `PERSONALITY.md`.
  - `city not found` (Review Focus 1): fetch returns `{}`. The call resolves, `placeNotFound` is true, `.env` TIMEZONE is unchanged, CLAUDE.md is still updated with the names, and no `setState` call is made.
  - `fetch throws`: same as not found.
  - `not pending skips skills`: run `set` twice. On the second run (`ownerName: 'Jim'`), `skills/decision-log/SKILL.md` still says `Jane` while CLAUDE.md says `Jim`.
  - `rejects quotes`: `ownerName: 'Ja"ne'` throws InputError.
  - `no saved setup`: throws InputError with the message above.
  - `skipProfile clears flag only`: CLAUDE.md bytes are unchanged and `isProfilePending` is false.
  - `secrets never written`: no file appears under `home` after `set`.
  - In `tests/web-setup-answers.test.ts`: `lookUpCity returns timezone`, and `drops an invalid timezone`.
- [ ] **Step 2:** Run `npx vitest run tests/onboarding-profile.test.ts tests/web-setup-answers.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(onboarding): apply a profile from the first chat (#210)`

### Task 3: The profile CLI and the CLAUDE.md pointer

**Files:**
- Create: `scripts/profile.ts`
- Modify: `templates/CLAUDE.md.template`. Add a short "Your owner's profile" section after the scheduling section.
- Test: `tests/profile-cli.test.ts`

**Interfaces:**
- Consumes: Task 2's `applyProfile`, `skipProfile`; Task 1's `isProfilePending`, `loadSetupAnswers`.
- Produces: the commands below, which Task 5's nudge text and the template quote verbatim:
  - `node dist/scripts/profile.js set [--owner-name X] [--assistant-name X] [--city X] [--vibe professional|friendly|direct|"<text>"] [--bio X]`
  - `node dist/scripts/profile.js skip`
  - `node dist/scripts/profile.js status`
- Output (stdout, plain text, relayed by the assistant). Log lines go to stderr: set `process.env.LOG_DEST = 'stderr'` before importing anything that logs, the same way `scripts/email-alerts.ts` does on the email-alerts branch. Exit code 0 on success, 1 on InputError, with the message as the only stdout line.
  - set: `Saved.` then, when relevant:
    - `Weather and time zone: <place> (<tz>).` or `I could not find "<city>", so the weather location and time zone stay as they were.`
    - `Kept your edited <file>.` per kept file
    - `Restarting after this reply so the new time zone takes effect.` when it changed
  - skip: `Skipped. You can still tell me your name, city or how to talk any time.`
  - status: `Profile: pending|set. Owner: <n>. Assistant: <n>. City: <c or none>. Time zone: <tz>.`

**Template section, exact copy:**

```
## {{OWNER_NAME}}'s profile

When {{OWNER_NAME}} asks you to call them something else, to change your name, their city, or how you talk, or tells you about their work, save it:

    node dist/scripts/profile.js set [--owner-name "..."] [--assistant-name "..."] [--city "..."] [--vibe professional|friendly|direct|"<their words>"] [--bio "..."]

Pass only what changed. Relay its output in your own words. On a bundle install with no system `node`, use `./runtime/bin/node` (macOS, Linux) or `runtime\node.exe` (Windows).
```

- [ ] **Step 1: Write failing tests.** Spawn the CLI with `process.execPath` plus `node_modules/tsx/dist/cli.mjs` (Windows-safe, as in `tests/email-alerts-cli.test.ts` on that branch), with `AGENT_PROJECT_ROOT` and `AGENT_STORE_DIR` pointed at a tmp fixture from Task 2. Test without network: run `skip` and `status`, and `set --owner-name Jane` with no city, so no fetch happens.
  - `status` prints `Profile: pending.` first.
  - `skip` prints the skip line, and `status` then says `Profile: set.`
  - `set --owner-name 'Ja"ne'` exits 1 with the quote message on stdout.
  - stdout never contains `{"level"` (no log lines).
  - In `tests/setup-execute.test.ts` (or a new test), a rendered CLAUDE.md contains `node dist/scripts/profile.js set`.
- [ ] **Step 2:** Run `npx vitest run tests/profile-cli.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the CLI with a small argv parser (no new dependency). The project root is `process.env.AGENT_PROJECT_ROOT || PROJECT_ROOT` (from `src/env.ts`); the override exists for tests and is not documented to owners.
- [ ] **Step 4:** Run `npx vitest run tests/profile-cli.test.ts && npm run build`. Expected: PASS, and `dist/scripts/profile.js` exists.
- [ ] **Step 5: Commit:** `feat(onboarding): profile CLI the assistant runs in chat (#210)`

### Task 4: Web setup without the profile step

**Files:**
- Modify: `templates/web-setup/index.html`
  - Remove the "About you" section.
  - Renumber the steps to "1. Connect Telegram" and "2. Choose its AI", with two step bars.
  - Finish sends `{ timezone: <browser tz>, engine }` with no `profile`.
  - The done screen tells the owner to say hello in Telegram, where the assistant will ask a few quick questions.
- Modify: `src/setup/web/answers.ts`
  - Replace `parseProfile` / `WebProfile` with `provisionalProfile(pairingName: string, botFirstName: string | undefined, timezone: string): WebProfile`. It applies the Global Constraints' provisional rules. Keep the `WebProfile` shape so `answersFromWeb` keeps its signature.
  - Add `parseTimezone(raw: unknown): string`, falling back to `'UTC'` when invalid.
  - Move the name validation into an exported `validName(v: string, max: number): boolean`, which Task 2 and this function both use.
- Modify: `src/setup/web/server.ts` `finish()`:
  - build the profile with `provisionalProfile(paired.state.candidate.name, owner.info.firstName, parseTimezone(body.timezone))`;
  - call `lookUpCity` with an empty city, so no fetch happens;
  - call `writeConfiguration(..., { profilePending: true })`;
  - Telegram message: `Hi, I'm set up. I'll be ready in a minute or two. Say hello then and I'll ask a few quick questions so I can be useful.`;
  - response `city: null`.
- Test: `tests/web-setup-answers.test.ts`, `tests/web-setup-server.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `provisionalProfile('Jane Doe', 'Nami', 'Europe/London')` gives `ownerName: 'Jane'`, `assistantName: 'Nami'`, `vibe: 1`, `ownerBio: ''`, `city: ''`.
  - Fallbacks: `provisionalProfile('Ja"ne', undefined, 'UTC').ownerName === 'the owner'` and `.assistantName === 'Atlas'`; `provisionalProfile('', ...)` gives `the owner`; and a pairing name of `'Unknown'` (the telegram.ts fallback) gives `the owner`.
  - `parseTimezone('Not/AZone')` returns `'UTC'`.
  - In the server test, a finish with no `profile` field succeeds:
    - `store/setup-answers.json` has `profilePending: true` and `ownerName` equal to the first word of the fake pairing name;
    - the sent Telegram text equals the new message;
    - the fake fetch saw no geocoding call.
  - Update or remove the existing server and answer tests that send a profile.
- [ ] **Step 2:** Run `npx vitest run tests/web-setup-answers.test.ts tests/web-setup-server.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the HTML, keep the CSP-nonce pattern and the existing `api()` helper.
- [ ] **Step 4:** Same command. Expected: PASS. Also open `templates/web-setup/index.html` and confirm no `ownerName`, `city` or `vibe` input remains: `grep -c 'id="ownerName"\|id="city"\|name="vibe"' templates/web-setup/index.html` prints 0.
- [ ] **Step 5: Commit:** `feat(setup): web setup asks only Telegram and AI access (#210)`

### Task 5: The first chat in the bot

**Files:**
- Create: `src/onboarding/welcome.ts`
- Modify: `src/onboarding/interview-offer.ts`. `shouldOfferInterview` returns false while `isProfilePending(projectRoot)`.
- Modify: `src/index.ts` (the startup greeting near line 163)
- Modify: `src/bot.ts`:
  - `handleMessage` near line 191: nudge selection;
  - after delivery near line 375: turn accounting, auto-skip, and restart-after-reply.
- Test: `tests/onboarding-welcome.test.ts`, `tests/interview-offer.test.ts`

**Interfaces:**
- Consumes: Task 1's `isProfilePending`, `loadSetupAnswers`; Task 2's `skipProfile`, `RESTART_AFTER_REPLY_KEY`; `requestRestart`, `rememberRestartNotice` from `src/infra/restart.ts`.
- Produces:
  - `WELCOME_TURNS_KEY = 'welcome_turns'` (app_state, a count as a string).
  - `MAX_WELCOME_TURNS = 3`.
  - `welcomeGreeting(ownerName: string, assistantName: string): string`. Plain text. When `ownerName` is `the owner`, the greeting does not use a name.
  - `welcomeNudge(saved: SavedSetup): string`. The bracketed instruction, which names what is still provisional.
  - `shouldWelcome(projectRoot: string, getState?: (k: string) => string | null): boolean`. True when pending and the turn count is below 3.
  - `noteWelcomeTurn(projectRoot: string, deps?: { getState; setState; skip?: (root: string) => void }): void`. Increments the count; at 3, if still pending, calls `skipProfile`.
  - `takeRestartAfterReply(getState?, setState?): boolean`. Reads and clears the key.

**Exact greeting copy** (`<name>` comes from ownerName and is omitted with its comma when provisional):

```
Hi <name>, I'm <assistantName>, and I'm up and running.

A few quick things so I can be useful. Answer in one message if you like, or say "skip":
1. Should I call you <name or "something">?
2. Is <assistantName> a good name for me, or would you like another?
3. Which city are you in? (For the weather and your time zone.)
4. How should I talk to you: professional, friendly, or direct? Or describe it.
5. In a sentence, what do you do?
```

**Nudge rules** (wording is the builder's; these points must be in it):
- answer what was asked first;
- ask only for what is still missing, never repeat answered questions;
- save with the exact `set` command from Task 3 (or `skip` if they decline);
- never ask for coordinates or a time zone name;
- it appears for a few messages only.

**Bot wiring:**
- `handleMessage`:
  - Primary chat and `shouldWelcome` → the nudge is `welcomeNudge(loadSetupAnswers(root)!)`.
  - Otherwise, primary chat and `shouldOfferInterview` → `interviewNudge()` as today.
  - Never both.
- After delivery:
  - if the welcome was attached → `noteWelcomeTurn(PROJECT_ROOT)`;
  - the existing `if (offerInterview) markInterviewOffered()` stays as is;
  - then `if (takeRestartAfterReply())` → `rememberRestartNotice({ chatId, toVersion: <current VERSION> })`, `requestRestart()`, `process.kill(process.pid, 'SIGTERM')`. Do this only when `canSelfRestart()`. Without it, log that the new timezone applies on the next restart.
- Startup in `index.ts`:
  - if `isProfilePending` → send `welcomeGreeting` from the saved names (on a send failure, log and carry on, as today);
  - else the existing interview greeting.
  - The greeting does not count as a turn.

- [ ] **Step 1: Write failing tests** (pure functions, injected state maps):
  - `shouldWelcome false without answers file`; `true when pending and 0 turns`; `false at 3 turns`.
  - `noteWelcomeTurn third call skips` (Review Focus 3): a fixture that is pending; after three calls `isProfilePending` is false, and `shouldOfferInterview` (with an empty state map and a stub PROFILE.md) is now true.
  - `noteWelcomeTurn does not skip once set`: flag cleared by `set` before the third turn, so `skip` is not called.
  - `greeting with provisional owner has no name`: `welcomeGreeting('the owner', 'Atlas')` starts with `Hi, I'm Atlas` and contains `Should I call you something?`.
  - `greeting with name`: `welcomeGreeting('Jane', 'Nami')` starts with `Hi Jane, I'm Nami` and contains `Should I call you Jane?`.
  - `nudge carries the command`: it contains `node dist/scripts/profile.js set` and `skip`, and no em dash.
  - `takeRestartAfterReply reads once`.
  - In `tests/interview-offer.test.ts`: `shouldOfferInterview false while profile pending`.
- [ ] **Step 2:** Run `npx vitest run tests/onboarding-welcome.test.ts tests/interview-offer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the bot.ts and index.ts wiring.
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS (full suite, since bot.ts changed).
- [ ] **Step 5: Commit:** `feat(onboarding): the first chat collects the profile (#210)`

### Task 6: The terminal wizard asks only the core

**Files:**
- Modify: `src/setup/wizard.ts`
- Modify: `scripts/setup.ts`
- Test: `tests/setup-wizard.test.ts`

**Interfaces:**
- Consumes: Task 1's `loadSetupAnswers`, `answersFromSaved`, `PROVISIONAL`, and `writeConfiguration(..., opts)`; `checkBotToken` from `src/setup/web/telegram.ts`.
- Produces: `runWizard(p: Prompter, projectPath: string, hooks?: WizardHooks, opts?: WizardOptions): Promise<Answers>` with `interface WizardOptions { saved?: SavedSetup | null; legacyInstall?: boolean; hostTimezone?: string }`.

**Question flow:**
1. Platform choice.
2. AI access (`askEngine`, unchanged).
3. Profile:
   - If `legacyInstall` → the existing profile questions: name, assistant name, timezone, city, vibe, bio. Remove only the latitude and longitude prompts; temp unit stays.
   - Else if `saved` → reuse saved profile fields, no questions.
   - Else → `PROVISIONAL` values, with timezone `opts.hostTimezone ?? 'UTC'`.
4. `Connect email now?` (yesNo, default no). On yes: the existing email-provider, address and gog flow. The signature is always `buildEmailSignature({ name: ownerName, title: '', phone: '', email: emailAddress })` (signature questions removed).
5. `Set up optional skills now (web research, Apollo, Anti-library, Notion, Kanban Zone, voice, WordPress)?` (yesNo, default no). On yes: the existing optional-skill and voice questions, unchanged.
6. The monthly audit question is removed; `monthlyAudit: false`.

**`scripts/setup.ts`:**
- `legacyInstall = existsSync(CLAUDE.md) && !loadSetupAnswers(root)`.
- Pass `hostTimezone` from `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- After the Telegram token is entered and the profile is provisional, try `checkBotToken(fetch, token)` and use `info.firstName` as the assistant name. On failure, keep `Atlas`, without a warning.
- `profilePending`:
  - true when the profile is provisional;
  - `saved.profilePending` when saved answers were reused;
  - false for legacy.
- Always pass `opts` to `writeConfiguration`, so a terminal install also gets `store/setup-answers.json`.
- At the end, when pending, print one line: the assistant will ask the owner's name, city and preferences in the first chat.

- [ ] **Step 1: Write failing tests**, using the scripted Prompter in `tests/setup-wizard.test.ts`:
  - `fresh install asks only core`: script answers Telegram, the subscription engine, no to email, no to optional. The recorded prompts contain no `Your name`, `Latitude`, `Longitude`, `Perplexity` or `Monthly audit`. `answers.ownerName === 'the owner'`, and `answers.timezone` equals the passed `hostTimezone`.
  - `legacy install asks profile` (Review Focus 4): `legacyInstall: true`. `Your name` is asked, the answer `Jane` lands in `ownerName`, and `Latitude` is not asked.
  - `saved answers reused`: `saved` with `ownerName: 'Jane'`. No `Your name` prompt, and `ownerName === 'Jane'`.
  - `email behind gate`: yes then Gmail then an address gives `gmailAddress` set, and `emailSignature` contains the address.
  - `optional behind gate`: yes leads to the Perplexity question.
  - Update the existing wizard tests that script the old full order.
- [ ] **Step 2:** Run `npx vitest run tests/setup-wizard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npx vitest run && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit:** `feat(setup): the terminal wizard asks only the core (#210)`

### Task 7: Docs and release 1.40.0

**Files:**
- Modify: `VERSION` → `1.40.0`, and `package.json` version → `1.40.0`; check `package-lock.json`'s top-level version too.
- Modify: `CHANGELOG.md`. Add a `## 1.40.0 - <date of commit>` section above 1.38.0 (or above 1.39.0 if present), with a one-line summary and owner-facing bullets: setup is two steps; the assistant asks in the first chat; `npm run setup` asks the core, with email and optional skills behind a question; existing installs unchanged. Keep the existing Unreleased #147 bullet where it is, unless 1.39.0 already absorbed it.
- Modify: `docs/SETUP-GUIDE.md` and `docs/HOSTED-VPS.md`, wherever they describe the profile questions or the web setup's "About you" step. Also `README.md` if it lists the wizard questions.
- Test: none new. Run the full suite.

- [ ] **Step 1:** `grep -rn "About you\|Latitude\|latlong\|Your name" docs README.md templates` and update each hit that describes setup.
- [ ] **Step 2:** Edit VERSION, package.json and CHANGELOG.
- [ ] **Step 3:** Run `npm run typecheck && npm run build && npx vitest run`. Expected: all pass.
- [ ] **Step 4: Commit:** `Release v1.40.0: minimal setup, profile in the first chat (#210)`
