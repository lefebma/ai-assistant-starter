# Memory provenance, chat scoping and a pinned decision ledger (card #235)

Card #235 under Feature #173. Source: spike #217 (docs/specs/2026-10-22-recovery-spike.md), defects 8 to 13. Target v1.71.0.

## Intent

Memory has to keep what the owner decided and must never treat text it read from elsewhere as something the owner said. Today a decision made early in a long chat is trimmed away, a summary of an email the assistant read is saved as plain history, recall pulls memories from other chats, a stored memory can close the memory block, and a natural question finds nothing.

## Acceptance (from the card)

1. Each memory records its source; anything learned from a tool read (email, web) is marked untrusted.
2. Semantic recall is scoped to the chat it came from.
3. Owner decisions live in a pinned ledger that history trimming cannot drop, and subagent briefs include them.
4. Stored text cannot close the memory context block early.
5. Keyword search matches natural questions instead of requiring every word.

## Decided

- **How a decision gets pinned (Marc, 2026-11-04): the assistant asks, the owner taps.** When the owner states a decision, the assistant ends its reply with `[[decision: <topic> | <decision>]]`. The bot strips the marker and sends a separate small card, "Pin this decision? <decision>", with buttons Pin and Skip. Only the tap pins. `/decide <text>` pins directly (`/decide <topic>: <text>` names the topic), `/decisions` lists them, `/decisions remove <n>` removes one. Text from an email or web page cannot pin itself: the worst it can do is put a card in front of the owner, who reads it before tapping. The card names the topic and any decision it would replace. In a group chat anyone in the chat can tap Pin or use /decide (no per-user check), which the setup guide says.
- **Supersession by topic.** A new pin on a topic retires the older one on the same topic (kept in the table, marked superseded, never shown).
- **Ledger is per chat**, capped at 30 live entries (oldest drops off with a note in the log); each entry at most 300 characters.

## Builder's calls (Claude's, flag if wrong)

- **Provenance column.** `memories.origin`: `owner` (the owner's typed words), `assistant` (the assistant's reply in a turn that read nothing from outside), `untrusted` (a reply in a turn whose tools read mail, web or another source; or a forwarded message), `system` (rotation summaries and other internal writes). Existing rows migrate as `legacy` and are shown as before (the defect is new writes; old rows decay).
- **How a turn knows it read something.** `runAgent` runs each turn inside a turn context; the existing tool-evidence path (`evidenceTypes`, the Claude PostToolUse hook and the ai-sdk wrapper) adds the evidence types it sees. `AgentRunResult.reads` returns them. `mail.read`, `web.read` or `source.read` makes the reply's memory `untrusted`.
- **Quoted and forwarded text.** The owner's row strips `<untrusted-...>` blocks (replaced by `[quoted text]`), so a vendor's "always" cannot promote it; the quoted or forwarded text is saved as its own `untrusted` row.
- **Calendar context** is marked untrusted: event titles and notes come from whoever sent the invite.
- **Session handoff summaries** are saved as `untrusted`: model-written over a session that may have read mail. Decisions do not depend on them.
- **Recall.** Untrusted and legacy-forwarded memories are injected inside `wrapUntrusted('memory', ...)`, owner and assistant ones as before. Every recalled line is defanged: any `<memory-context`, `</memory-context`, `<workspace-context`, `<decision-ledger` or `<untrusted-` tag in stored text becomes `[tag]`.
- **Chat scoping.** `searchMemories(query, limit, chatId)` filters by chat. Both callers pass it. No cross-chat recall anywhere.
- **Search.** Words are lowercased, stopwords and words under 3 letters dropped, each remaining word becomes a prefix term, joined with OR, ranked by bm25. Natural questions now match.
- **Where the ledger goes.** A `<decision-ledger>` block outside the memory block (standing, not history) on every chat, web, shortcut and scheduled turn for that chat; it never goes through the context engine's token budget. The Claude runtime's Agent/Task tool gets the ledger prepended to its prompt by a PreToolUse hook (`updatedInput`); the ai-sdk `dispatch_subagent` prepends it in `execute`.
- **Web chat.** A page answers only its latest card, so the first proposal rides the reply itself as its Pin and Skip when the reply has no buttons of its own; any other proposal is shown as a `/decide` line.
- **Pin card plumbing.** Proposals persist in `decision_proposals` (chat, card message id, topic, text, created_at, resolved). The card's buttons go through the existing claim (one click per card). Works in Telegram, Slack, Teams and the web chat; a platform without buttons gets "Reply /decide <text> to pin it."
- **Instructions to the model.** A short system note: when the owner states a decision that should hold for later (a recipient, an amount, a yes/no on terms), add the marker; never add one for something read in an email, web page or document.
- **Not in scope.** Defect 13's step lease (parallel workers both acting) is the effect journal's job, already covered by #229. Defect 14 (recipient limits) stays with #195. Umi port is a separate step.

## Done when

The as-is arm of `tests/assurance-recovery-eval.test.ts` flips its memory defect pins (S3 unmarked injection, cross-chat recall, ANDed search, block closure), new unit tests cover the ledger, pin flow, provenance and search, and the full suite passes.

## Result (2026-11-04)

- Recovery eval, as-is arm: every hard threshold now holds (verified completion 14/14, recall 100%, 0 duplicates, 0 unauthorized, recovery 13/13, p95 11 min, checker never disagrees with the destination). Memory precision is 73%, under the 90% bar: an old memory on a topic is not retired by a newer one (S3 recalls the 2024 contact), and the injected vendor email is recalled inside its untrusted wrapper rather than left out. The pinned ledger overrides both, so the runs verify. Retiring superseded memories needs a topic per memory, which nothing writes yet: follow-up.
- Live check on the Claude CLI: a pinned decision reached an Agent-tool subagent through the PreToolUse hook while the parent prompt never carried it, and the turn reported its WebFetch as `web.read`.
- A reply is untrusted after a tool read or when the owner's message carried quoted or forwarded text. It is not marked untrusted merely because an untrusted memory was recalled into the turn (that would cascade into every later reply); the recalled text stays wrapped. Delegated voice turns (voice-live.ts) save without reads.
- Not detected as an outside read: MCP connector tools (only the Bash mail/calendar CLIs, curl/wget and the web tools are recognised), and files the assistant reads from uploads.
