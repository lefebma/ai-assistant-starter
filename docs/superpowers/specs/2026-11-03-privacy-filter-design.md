# Privacy filter (card #187) design

Built straight from the card; Marc skipped the questions. Calls marked "my call" are open for review.

## Intent

IT and security teams, and anyone bound by client confidentiality, ask what leaves the machine. The answer this gives: listed client names and companies, and every email address and phone number, never reach the AI service. Replies are restored locally, so the owner reads normal text and tools act on real names.

## What it does

- **Out:** every piece of text sent to a public model is masked: system prompt, memory, history, tool results, tool inputs. Placeholders are `PERSON_n`, `COMPANY_n`, `EMAIL_n`, `PHONE_n`, `NAME_n`, numbered by the entry's row id (stable, never reused).
- **In:** placeholders in the reply, streamed or whole, are restored, including in tool-call inputs (JSON-escaped). A placeholder split across stream chunks is held until it can be settled.
- A fixed note tells the model to use placeholders as written and never ask for the real names (found in a live spike: without it, Haiku asked for the "real" names).

## Where it sits

- **Claude runtime:** the CLI is out of process, so a private run's CLI gets `ANTHROPIC_BASE_URL` on a loopback relay (`src/privacy/proxy.ts`) with a per-run token in the path. The relay masks `POST /v1/messages` (and `count_tokens`), forwards to the env's own base URL or api.anthropic.com, restores SSE or JSON replies, and passes every other path through. Unknown token: 404. Unparseable Messages body: 400, never forwarded. Verified live against the subscription CLI: tool call ran with real names, 0 of 3 outbound requests carried a real name.
- **ai-sdk runtime:** a language model middleware (`src/privacy/middleware.ts`), so every provider is covered in process.
- **Egress:** on a box with `EGRESS=enforce`, the relay's exact `127.0.0.1:port` joins the run's write list (the CLI reaches it through the egress proxy).
- Left untouched both ways: thinking/reasoning (signed), images and file data, server tool blocks (encrypted), tool names and ids.

## Switch (my call, from "per account or globally")

- `PRIVACY=on` in `.env`: every chat, cannot be turned off from a chat.
- Otherwise per chat: `/private on|off`, app_state `privacy:<chatId>`.
- A run with no chat (runOnce: memory, titles; voice paths without a chat id) is private when any chat is.
- A chat switch that cannot be read counts as off (the list is in the same store, so there would be nothing to mask with); `PRIVACY=on` is read first and always holds.

## The list (my calls on the card's open questions)

- **Entity types:** names and companies from the owner's list, plus emails and phones found by shape and added automatically (source `auto`) the first time one is about to go out. Deal values are not covered.
- **Detection:** deterministic list plus rules, no local model. Hosted boxes have no local model, and a per-turn model call would add latency. A local-model name finder can be a follow-up card.
- Whole-word, case-insensitive, flexible whitespace, longest form first, aliases restore as the main value. Minimum 3 characters per form.
- `/private list` and `/private remove` are main-chat only, since the list holds every chat's names.
- A model on loopback or a private network (`AI_BASE_URL`) is not a public model: no masking.

## Not covered (documented in docs/PRIVACY.md)

Names not on the list; what tools send elsewhere (web search, fetched pages); voice calls (audio goes straight to the voice service); images and attached files.
