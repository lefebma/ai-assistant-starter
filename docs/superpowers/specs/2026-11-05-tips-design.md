# Tips and tricks (card #273)

Card #273 under Feature #277. Target v1.72.0. Marc chose to skip the questions, so everything under "Builder's calls" is Claude's and open to change.

## Intent

A customer should find out what Havn can do without reading release notes or remembering commands. The assistant suggests one thing at a time, only when it applies, in plain words, and stops once the customer uses it, turns tips down or says no.

## Acceptance

The ten criteria on the card.

## How it works

- **No model, no network.** `src/tips/` is a timer like the update notice. Choosing and sending a tip is local code, so it costs nothing on a capped box and runs while the AI allowance is paused.
- **Catalog.** `src/tips/catalog.ts`, one entry per tip: `id`, `since` (version), `text` (what it does), `tryIt` (one example, a command or a sentence), `applies(ctx)`, `used(ctx)`, and `commands` / `phrases` that count as trying it. Order is priority.
- **Context.** `src/tips/context.ts` reads local state only: connected mail and calendars, proactive and email alert settings, scheduled tasks, pinned decisions, voice keys, whether the platform has buttons. A source that fails reads as "not connected", so at worst a tip is held back.
- **State.** One JSON value in `app_state` (`tips.state`): pace, per-tip shown count, last shown, done or dismissed, recent send times, last version seen, the current card. No table, no migration.
- **Sending.** To the owner's main chat, every platform, buttons Got it and Not for me where the platform has buttons, otherwise a line pointing at `/tips hide`. The click is handled in the callback and never reaches the model.
- **Web app.** The last tip sent shows as a quiet strip beside the update banner with the same two actions, read from `GET /api/web/tips`. Acting on it in either place clears it in both.

## Rules

- **Pace.** `normal` is at most one a day and three in any seven days. `less` is one in any seven days. `off` sends nothing and stays off through updates. `/tips` always answers when asked, even when off, and does not use up the day's tip.
- **When.** Between 10:00 and 17:00 local, outside the owner's quiet hours (the shared setting), with no turn running in the main chat and nothing from the owner in the last 30 minutes.
- **What.** A tip is eligible when it applies, is not done, is not dismissed, and was not shown in the last 30 days. Fewest times shown wins, then catalog order. That gives the loop: when everything has been shown once, the list starts over from the top. The 30-day gap stops a customer with three eligible tips hearing the same three every week.
- **Uptake.** A tip is done when its `used(ctx)` is true, when the owner sends one of its commands, or when a message matches one of its phrases. Messages are matched in memory and never stored. Done is permanent. Every tip must have at least one of the three signals, and a test enforces it.
- **After an update.** The first time the assistant runs a newer version, it picks up to two tips with `since` newer than the last version seen and sends them in one message, once, inside the same time window. Skipped when off. Counts against the day. Those tips also count as shown, so they do not come round again for 30 days. A new install, or a box's first run with tips, records its version and sends no update tip.
- **Never on by itself.** Tips only say how. Nothing in `src/tips/` writes a setting other than its own.

## Commands

`/tips` shows the next tip and lists the ones already seen. `/tips off`, `/tips on`, `/tips less`, `/tips normal` set the pace. `/tips hide` hides the last tip shown; `/tips hide <n>` hides one from the list. Changing the pace or hiding works in the main chat only.

## Definition of done for a feature

`tests/tips-catalog.test.ts` reads `CHANGELOG.md`. Every `- **New:` bullet in a version at or after 1.72.0 needs a tip with that `since`. Provider-only work is written `- **New for providers:` and needs none. The failure message says what to add.

## Builder's calls

- **On by default.** The card describes turning tips off, so they start on. This means every box starts getting unprompted messages after this update. `TIPS=off` in the settings turns the feature off for a box, for a provider who wants that.
- **Two-day hold.** The first paced tip waits 48 hours from the first run, so it cannot land during the welcome questions. Boxes updating to 1.72.0 wait too.
- **Window 10:00 to 17:00.** Quiet hours alone would allow a tip at 07:00, stacked on the morning briefing.
- **Back catalogue.** About 20 tips for features customers can use today, drafted from the changelog in plain language. Marc approves the wording in the PR.
- **Per box, not per person.** A box has one owner, so state is per box and tips go to the main chat only.
- **Buttons.** Got it and Not for me only. A "Try it" button that runs the example would spend model time and is left out.

## Not in this version

- Marina seeing which tips her clients tried (card's open question). State stays on the box; nothing is reported anywhere.
- Partner-specific tips.
- Tips about features the customer's plan or provider has not enabled: `applies` covers what the box can see, nothing more.
- Umi port. Umi's catalog would differ, so it is a separate decision.
