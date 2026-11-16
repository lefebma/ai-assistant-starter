# Privacy filter: name finder (card #275) design

Follow-up to the privacy filter (#187, `docs/superpowers/specs/2026-11-03-privacy-filter-design.md`).

## Intent

The privacy filter only hides names the owner added with `/private add`. A client nobody added goes to the AI service as written. The finder notices client names and companies in the owner's own messages and offers each one with a tap, so the list keeps up without the owner having to remember.

## Goals

- New person and company names in the owner's messages are offered in the main chat: "Keep Acme Corporation private?" with **Add** and **Not private**.
- Nothing the finder reads leaves the machine.
- No added delay on a chat turn.

## Non-goals

- Reading email, tool results or web pages (Marc, 2026-11-16: owner messages only for now; email can come later if this proves too narrow).
- Adding anything without the owner's tap.
- Protecting the first mention: the finder runs after the message has been sent, so a new name has already gone out once. It protects every mention after that. Documented in `docs/PRIVACY.md`.

## Anti-goals

- A stream of cards about ordinary words, places or the owner's own name.
- Asking about a name the owner already declined.
- Slowing down, or taking memory from, a 2 GB hosted box in a way that hurts normal use.

## Approaches

1. **Small name-detection model in-process (chosen).** `@huggingface/transformers` running `Xenova/bert-base-NER` (MIT license, English, about 109 MB quantized), CPU only. It works on every box, hosted ones included, with no separate service. The costs are one new dependency, a one-time model download from Hugging Face, and a few hundred MB of RAM while it is loaded.
2. **Local LLM (the card's original idea).** This only works where something like Ollama runs (Marc's Mac). On all four hosted boxes, with 2 GB of RAM and 1 or 2 cores, it would always be off.
3. **Rules only (capitalized words plus company suffixes).** No dependency, but noisy: it fires on sentence starts and misses lowercase names. That would mean more of the wrong cards.

Marc accepted option 1 on 2026-11-16, raising no objection when it was proposed.

## How it works

- **Source:** every main-chat message the owner types, on Telegram and on the web. This is the same point where `noteOwnerMessage` is called today (`src/bot.ts`), and it covers typed text only. Commands are skipped.
- **When:** only while the privacy filter is on (`PRIVACY=on`, or any chat switched on). With the filter off, a suggestion has nothing to protect.
- **Queue:** the text goes into a small in-memory queue, which is bounded and drops its oldest item when full. A single background worker handles the queue one message at a time, after the turn has started. Nothing awaits it in the request path.
- **Model:** it loads lazily on first use and unloads after 10 idle minutes (my call, to keep RAM free on 2 GB boxes). The cache lives under `store/models/`. The download carries no message text.
- **What counts as a find:** PER and ORG entities, merged across word pieces and widened to whole words. Each entity needs a mean score of at least 0.8 and at least 3 characters (the list's own minimum), and people need a full name (2 or more words). LOC and MISC are ignored. PER becomes person, ORG becomes company. A short built-in list of well-known brands (Google, Microsoft, Telegram, Claude and so on) is skipped. These were tuned on a spike against the real model on 2026-11-16: bare first names and big brands were the noise, and 0.85 missed real companies such as Norwin.
- **Filters:**
  - The name is not already on the list (`findEntry`, which also checks aliases).
  - The name was not offered before.
  - The name is not the owner's or the assistant's own name, where setup knows them.
- **Store:** a new `privacy_suggestions` table with columns kind, value (unique, case-insensitive), status (`pending` / `added` / `declined`), first_seen and offered_at. **Not private** sets `declined` forever. **Add** calls `addEntry(kind, value)` and sets `added`.
- **Offer:** a card in the main chat with the two buttons, following the same pattern as tip cards and decision cards (resolved in the click handler, never sent to the agent).
  - At most 3 cards a day (my call). Any extra finds stay pending and go out on the following days.
  - Cards respect the proactive quiet hours.
  - On a surface without buttons, the card says to reply with `/private add <name>`.
- **Off switch:** `PRIVACY_FINDER=off` in `.env`. If the model cannot load (download blocked, out of memory), the finder turns itself off until restart and logs it once. Turns are never affected.

## Tests

- A found name produces one card. **Add** puts it on the list, and **Not private** means it is never offered again.
- A name already on the list, or one of its aliases, is not offered.
- With the filter off, nothing is queued.
- When the model is unavailable, the finder is off, no card appears and turns run normally.
- The daily cap holds extra finds for the next day.
- The model is stubbed in unit tests. One opt-in test runs the real model when it is present locally.

## Left to the builder

- The exact merge of word pieces, and the label mapping from the pipeline output.
- Where the worker starts in `src/index.ts`.
- Whether `EGRESS=enforce` needs the Hugging Face host allowed for the bot process, or only for the agent CLI. Check before shipping.

## Then

- Release the starter with a CHANGELOG entry and a docs/PRIVACY.md update.
- Mirror to Umi only if Marc wants it there.
