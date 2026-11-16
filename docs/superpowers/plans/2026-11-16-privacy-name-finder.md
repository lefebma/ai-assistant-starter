# Privacy name finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer new person and company names from the owner's main-chat messages for the privacy list, one tap each, without slowing a turn or sending the text anywhere.

**Architecture:** The owner's typed text is queued in memory, and a single background worker tags it with an in-process name model (`Xenova/bert-base-NER` via transformers.js). Finds are filtered and stored in `privacy_suggestions`. A timer modelled on the tips service sends at most 3 cards a day, outside quiet hours. Taps resolve in the click handler and never reach the model.

**Tech Stack:** TypeScript, Node 22, better-sqlite3, `@huggingface/transformers@4.3.2` (pinned, already installed on the branch), vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-privacy-name-finder-design.md`

## Global Constraints

- The finder only reads main-chat messages the owner typed, and never reads commands (text starting with `/`).
- It only runs while the privacy filter is on (`privacyState(undefined).on`, which covers `PRIVACY=on` or any chat switched on).
- Nothing in the request path awaits the finder.
- Model: `Xenova/bert-base-NER`, `dtype: 'q8'`, cache dir `resolve(STORE_DIR, 'models')`. It loads lazily and unloads after 10 idle minutes.
- Finds: PER and ORG only. The entity's mean score must be at least 0.8, it must have at least 3 characters, and a PER must have at least 2 words.
- Cap: 3 cards per local day, never during quiet hours or while the main chat is busy.
- Buttons: `Add` and `Not private`. `Not private` is permanent.
- `PRIVACY_FINDER=off` in `.env` disables it. If the model fails to load, the finder is disabled until restart, with one log line.
- Copy: plain language, no em dashes.

## Review Focus

1. **A name that is already on the list, but in different case or as an alias.** It is never offered. (Task 3 test.)
2. **The owner taps a card twice, or taps a card the timer already resolved.** The second tap answers "Already done." and changes nothing. (Task 3 test.)
3. **A model download fails or the box is out of memory.** The finder goes off, chat is unaffected, and there is no retry storm. (Task 2 test.)
4. **A burst of messages while the model loads.** The queue stays bounded at 50 and drops the oldest. (Task 4 test.)
5. **The same new name in several messages before the first card goes out.** It gets one suggestion row and one card. (Task 3 test.)

---

### Task 1: Tag merging and filtering

**Files:**
- Create: `src/privacy/finder/detect.ts`
- Test: `tests/privacy-finder-detect.test.ts`

**Interfaces:**
- Produces:
  - `type TokenTag = { entity: string; word: string; score: number; index: number }`. This is the transformers.js token-classification output.
  - `type Found = { kind: 'person' | 'company'; value: string; score: number }`
  - `mergeTags(text: string, tags: TokenTag[]): Found[]`
  - `filterFinds(finds: Found[], skip: Set<string>): Found[]`, where `skip` holds lowercased names.
  - `KNOWN_BRANDS: string[]`

- [ ] **Step 1: Write the failing tests.** Use the tags recorded from the real model on 2026-11-16:
  - `mergeTags('Can you draft a follow-up to Marcus Ruddy at Norwin about the invoice?', [B-PER Marcus .999 #9, I-PER R .999 #10, I-PER ##udd .998 #11])` returns `[{kind:'person', value:'Marcus Ruddy'}]`. The partial piece expands to the whole word.
  - Devon Spencer and South/##tel/Communications/Inc return `Devon Spencer` (person) and `Southtel Communications Inc` (company).
  - `Nor`(B-LOC .67) followed by `##win`(I-ORG .62) is one word, typed by its first piece, so it gives LOC and is dropped.
  - `filterFinds`:
    - drops a score of 0.79
    - drops the single-word person `Jill`
    - drops `Google`, which is in KNOWN_BRANDS
    - drops a name in `skip` regardless of case
    - keeps `Bright Path Dental`

- [ ] **Step 2: Run `npx vitest run tests/privacy-finder-detect.test.ts`** and confirm it fails because the module is missing.

- [ ] **Step 3: Implement.**
  - Map pieces to the text with a forward cursor: strip `##`, then `indexOf` from the cursor. A piece that cannot be found is skipped.
  - Each piece belongs to the whitespace or punctuation-delimited word that contains it. A word takes its type from its first tagged piece, and its score is the mean of all its pieces.
  - Consecutive words of the same type join into one entity when they are adjacent in the text (only spaces between them).
  - Trim trailing `.,;:!?'"` and possessive `'s`.
  - `KNOWN_BRANDS`: Google, Microsoft, Apple, Amazon, Meta, Facebook, Instagram, WhatsApp, Telegram, Slack, Zoom, Teams, Outlook, Gmail, OpenAI, Anthropic, Claude, ChatGPT, Gemini, Havn, LinkedIn, YouTube, Netflix, Uber, PayPal, Stripe, Shopify, QuickBooks, Dropbox, Notion.

- [ ] **Step 4: Run the test** and confirm it passes.

- [ ] **Step 5: Commit** with `feat(privacy): merge and filter name-model tags (#275)`.

### Task 2: Model loader

**Files:**
- Create: `src/privacy/finder/model.ts`
- Test: `tests/privacy-finder-model.test.ts`

**Interfaces:**
- Consumes: `TokenTag` (Task 1).
- Produces:
  - `type Tagger = (text: string) => Promise<TokenTag[]>`
  - `createModelTagger(opts: { load: () => Promise<Tagger>; idleMs?: number; now?: () => number }): { tag: Tagger | null; disabled: () => boolean; unloadIfIdle: () => void }`. When `disabled()` is true, `tag` resolves to `[]`.
  - `loadBertNer(cacheDir: string): Promise<Tagger>`, which does a dynamic `import('@huggingface/transformers')`, sets `env.cacheDir`, and builds `pipeline('token-classification','Xenova/bert-base-NER',{dtype:'q8'})`.

- [ ] **Step 1: Write the failing tests.**
  - Loads once across two calls.
  - A `load` that throws makes `disabled()` true, logs once, and later calls do not call `load` again.
  - After `idleMs` (default 600000) with no call, `unloadIfIdle` drops the tagger, and the next call loads again.
  - Concurrent first calls share one load.
  - All tests inject `load`, so the real model is never needed.

- [ ] **Step 2: Run** and confirm it fails.

- [ ] **Step 3: Implement.** Hold a single in-flight load promise. The log line carries only the error name, never text.

- [ ] **Step 4: Run** and confirm it passes.

- [ ] **Step 5: Add `tests/privacy-finder-model.real.test.ts`.** It is skipped unless `RUN_MODEL_TESTS=1`, and it runs `loadBertNer` plus `mergeTags` on "Remind me to call Devon Spencer at Southtel Communications Inc. tomorrow." Run it once locally with the flag.

- [ ] **Step 6: Commit** with `feat(privacy): lazy name model with idle unload (#275)`.

### Task 3: Suggestions store and the card

**Files:**
- Modify: `src/privacy/schema.ts`, to add the table.
- Create: `src/privacy/finder/suggestions.ts`
- Test: `tests/privacy-finder-suggestions.test.ts`, using the in-memory db setup the existing `tests/privacy-store.test.ts` uses.

**Interfaces:**
- Consumes: `Found` (Task 1), plus `findEntry` and `addEntry` from `src/privacy/store.ts`.
- Produces:
  - Table `privacy_suggestions(id INTEGER PK, kind TEXT, value TEXT, lower TEXT UNIQUE, status TEXT DEFAULT 'pending', card TEXT, first_seen INTEGER, offered_at INTEGER)`.
  - `recordFinds(finds: Found[], nowMs?: number): number`, which returns the count of new rows. It skips anything `findEntry(value, {placeholders:false})` knows, and anything already in the table in any status.
  - `nextSuggestion(): { id: number; kind: 'person'|'company'; value: string } | null`, which returns the oldest pending row with no card.
  - `offeredToday(nowMs: number, tz: string): number`
  - `markOffered(id: number, card: string | null, nowMs?: number): void`
  - `suggestionText(value: string, buttons: boolean): string`
  - `SUGGESTION_BUTTONS = ['Add', 'Not private']`
  - `resolveSuggestionClick(primary: boolean, cardId: string, label: string): string | null`, which returns null when the card is not a suggestion.

- [ ] **Step 1: Write the failing tests.**
  - `recordFinds` twice with `Bright Path Dental` creates one row.
  - `bright path dental` already listed (or listed as an alias) creates no row.
  - A click on `Add` calls `addEntry('company','Bright Path Dental')`, sets the status to `added` and replies `Added Bright Path Dental. It stays on this machine whenever the privacy filter is on.`
  - A click on `Not private` sets `declined`, replies `Okay, I won't ask about Bright Path Dental again.`, and a later `recordFinds` with the same name adds nothing.
  - A second click on a resolved card replies `Already done.`
  - A click from a non-primary chat replies `That one only works in your main chat.`
  - An unknown card returns null.
  - `offeredToday` counts by local day in `America/New_York`.
  - `suggestionText('Acme', true)` is `Keep Acme private? It came up in your messages. Add puts it on your privacy list, so it stays on this machine.`
  - `suggestionText('Acme', false)` gives the same first two sentences, then `To keep it private, reply /private add Acme`.

- [ ] **Step 2: Run** and confirm it fails.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** this test and `tests/privacy-store.test.ts`, and confirm both pass.

- [ ] **Step 5: Commit** with `feat(privacy): name suggestions store and card (#275)`.

### Task 4: Queue, worker and offer timer

**Files:**
- Create: `src/privacy/finder/service.ts`
- Modify: `src/config.ts`, adding `PRIVACY_FINDER_ENABLED = (env['PRIVACY_FINDER'] ?? 'on').toLowerCase() !== 'off'` next to `TIPS_ENABLED`.
- Test: `tests/privacy-finder-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3, plus `privacyOnFor` (`src/privacy/index.ts`), `getQuietHours` and `quietUntil` (`src/proactive/settings.ts`), and `loadSetupAnswers` (`src/setup/saved.ts`, which supplies `ownerName` and `assistantName` for `skip`).
- Produces:
  - `noteForFinder(primary: boolean, text: string): void`. It is synchronous and never throws. It returns at once when the finder is disabled, the chat is not primary, the text starts with `/`, the text is shorter than 3 characters, or the filter is off.
  - `startNameFinder(deps: FinderDeps): () => void`
  - `type FinderDeps = { tagger: ReturnType<typeof createModelTagger>; send: (text: string, buttons: string[]) => Promise<string | null>; buttons: boolean; busy: () => boolean; now: () => Date; tz: string; skip: () => Set<string> }`
  - `offerTick(deps: FinderDeps): Promise<'held' | 'nothing' | 'sent' | 'failed'>`
  - `drainQueue(deps: FinderDeps): Promise<void>`, exported for tests.

- [ ] **Step 1: Write the failing tests.**
  - With the filter off, `noteForFinder` queues nothing.
  - A command is not queued.
  - 60 notes leave 50 in the queue (the oldest are dropped).
  - `drainQueue` with a stub tagger returning Devon Spencer's tags records one suggestion.
  - A disabled tagger records none.
  - `offerTick` returns `held` in quiet hours, `held` while busy, and `held` after 3 offered today.
  - Otherwise it sends `suggestionText` with `SUGGESTION_BUTTONS` and calls `markOffered` with the card id.
  - A send that throws leaves the row unoffered and returns `failed`.

- [ ] **Step 2: Run** and confirm it fails.

- [ ] **Step 3: Implement.**
  - The queue is a module-level array.
  - The worker is a single promise chain that one `noteForFinder` kicks off with `setImmediate`.
  - The offer timer runs every 30 minutes (first run after 10 minutes, timers `unref`'d), and each tick also calls `tagger.unloadIfIdle()`.

- [ ] **Step 4: Run** and confirm it passes.

- [ ] **Step 5: Commit** with `feat(privacy): background name finder and offer timer (#275)`.

### Task 5: Wiring, docs, release notes

**Files:**
- Modify: `src/bot.ts`:
  - call `noteForFinder(isPrimaryChat(chatId), trimmed)` right after each `noteOwnerMessage` (lines ~1120 and ~2015)
  - add `answerSuggestionClick` next to `answerTipClick`, at both click sites, keeping the web prefix `web:${chatId}:${id}`
- Modify: `src/index.ts`. Start the finder beside `startTips` when `PRIVACY_FINDER_ENABLED`, with the same `send` shape. The tagger is `createModelTagger({ load: () => loadBertNer(resolve(STORE_DIR,'models')) })`.
- Modify:
  - `docs/PRIVACY.md`: what the finder does, that the first mention has already gone out, the model download, about 400 MB of RAM while loaded, and `PRIVACY_FINDER=off`
  - `CHANGELOG.md`: a new minor version, written in plain owner language
  - `.env.example`, if it lists `TIPS`
- Test: extend the existing bot click test, if there is one, so a suggestion click is answered without a model turn.

- [ ] **Step 1: Write the failing test** for the click routing.
- [ ] **Step 2: Wire it up.** Run `npm run typecheck && npm run build && npx vitest run`. Expect everything green apart from the known flake `tests/ai-sdk-cancel-delegation.test.ts`, which must pass when run alone.
- [ ] **Step 3: Check egress.** Read `src/egress*` to see whether `EGRESS=enforce` restricts the bot process or only the agent CLI. If it restricts the bot, add `huggingface.co` and `cdn-lfs.huggingface.co` to what the finder's download needs, and document it.
- [ ] **Step 4: Check `npm audit`.** Compare it with main, and name any new advisory the dependency brings.
- [ ] **Step 5: Commit, push and open a PR** against main, linking card #275.
