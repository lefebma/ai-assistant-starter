# /model command (card #270), design

Date: 2026-11-02. Target: starter v1.65.0, branch `feat/model-command`.

## Intent

The owner switches the AI model their assistant answers with by sending `/model`, on any surface. Havn has no `/model` today; only the web chat's picker (Haiku / Sonnet / Opus, card #242) changes the model, and Telegram and Teams turns never pass a model at all.

## Decisions (Marc, 2026-11-02)

1. The choice survives restarts.
2. `/model` lists the latest models from every provider that has an API key in the settings.
3. On a managed box, only the models the plan covers are listed, and the spend cap counts whichever is picked.

## Behaviour

- `/model` shows the current model and one button per choice. Clicking a button switches this chat. `/model default` goes back to the box's configured model. `/model <text>` picks the first choice whose label or id matches, so it works on surfaces without buttons.
- The choice is stored per chat in SQLite (`chat_models`: chat_id, model, updated_at). Telegram and Teams turns pass it to `runAgent`. In the web chat, `/model` sets the open conversation's picker (the conversation's `model` column, already persisted), and the picker lists the same choices.
- Scheduled tasks, proactive messages and voice never read it.

## The model reference

A stored choice is either a tier alias (`haiku`, `sonnet`, `opus`, as today) or `provider:modelId` (`openai:gpt-5.5`, `anthropic:claude-opus-5-5`, `google:gemini-3-pro`). `resolveModel` learns the `provider:` form: it builds that provider with that provider's own key. An unknown provider, or one with no key any more, falls back to the configured default and logs it; the turn never fails because a key was removed.

## Which choices are listed

| Box | Choices |
|---|---|
| Claude subscription (claude runtime, no ANTHROPIC_API_KEY) | Haiku, Sonnet, Opus |
| Key set: ANTHROPIC_API_KEY | latest Haiku, Sonnet, Opus (and Fable when listed) from Anthropic's models list |
| Key set: OPENAI_API_KEY, no AI_BASE_URL | latest of each main GPT family from OpenAI's models list |
| Key set: GOOGLE_API_KEY | latest Gemini Pro, Flash, Flash-Lite |
| AZURE_API_KEY | the configured deployments only (AI_MODEL, AI_MODEL_CHEAP, AI_MODEL_STRONG); Azure keys cannot list the vendor's new models |
| OPENAI_API_KEY with AI_BASE_URL (Together, Ollama, a gateway) | the configured models only; those hosts list hundreds |
| Managed, Claude engine | Haiku, Sonnet, Opus (the managed meter already prices every Claude model) |
| Managed, open-model engine | the one configured model; it is the only one the box has prices for |

"Latest" comes from each provider's models endpoint (the same endpoints `src/secrets/validate.ts` calls). Each provider has a short family table (for example Anthropic `haiku`, `sonnet`, `opus`), and the newest listed id in each family wins (by `created_at` or `created`, else by version number in the id). Non-chat models (embeddings, audio, image, realtime, search) are filtered out. The list is cached for 24 hours in `store/model-catalog.json`, tied to a short hash of the key it came from. Providers are asked in parallel. If a call fails, the cached list is used and that provider is not asked again for ten minutes; with no cache, the provider is left out. (Builder's call: no built-in list of vendor ids, since guessed ids rot; the provider's own list is the source.) Labels use the provider's display name where it gives one ("Claude Opus 5.5"), else the id.

## Which runtime runs a turn

- Anthropic models on a claude-runtime box stay on the claude runtime (it accepts full Claude ids). No session change.
- A non-Anthropic model on a claude-runtime box runs on the ai-sdk runtime for that chat. `getAgentRuntime(lane, model)` picks it.
- Every session is stamped with the runtime that wrote it (`app_state` `session_runtime:<id>`). `runAgent` never resumes a session on the other runtime: whatever moved the chat (a switch, a removed key, managed AI, an edited AGENT_RUNTIME), the turn starts fresh instead of failing.
- Switching between runtimes starts a fresh conversation for that chat, because the two runtimes keep separate session stores. The reply says so ("Switched to GPT-5.5. This starts a fresh conversation; memory carries over."). Switching within the ai-sdk runtime keeps the history: the existing provider-switch sanitizer runs, now keyed on the turn's provider instead of `AI_PROVIDER`.
- Managed boxes keep their forced runtime; only the listed choices can be picked.
- `AI_BASE_URL` applies to an `openai:` or `azure:` choice only when that is the configured `AI_PROVIDER`, so the OpenAI key never goes to an Azure address.
- `/steer` goes to the runtime with a turn running, or the one the chat's model runs on.

## Out of scope

- Effort (`/effort`) and per-task model choice for scheduled tasks.
- Picking any model id the list does not show.
- Umi: its `/model` stays tier-only for now; the port is a follow-up (flagged per the web-UI parity rule).

## Tests

- The catalog: choices per key combination, family pick, non-chat filter, cache and fallback, managed boxes.
- `resolveModel` with `provider:modelId`, including a removed key.
- Persistence: the choice is still there after the store is reopened.
- Runtime routing: a non-Anthropic choice on a claude box goes to ai-sdk, and the session is cleared on the switch.
- `/model` on Telegram (buttons and text), the web (sets the conversation's picker) and a managed box.

## Left to the builder

The exact family tables, filter words and fallback ids, and the wording of replies, within the no-em-dash, plain-language rules.
