# Design Doc: LLM-Agnostic Architecture

**Status:** Active. Phase 1 shipped in v1.3.0.
**Decision:** Own the agent loop, abstract the model via the Vercel AI SDK. Do not attempt to abstract across agent harnesses.

---

## 1. Problem

The assistant runs exclusively on the Claude Agent SDK, which ties every install to Anthropic. Users arrive with existing model commitments:

- Existing subscriptions (OpenAI, Google, Anthropic)
- Enterprise contracts on Azure OpenAI or AWS Bedrock (data residency, procurement, existing spend)
- Self-hosted models (Ollama, vLLM, LM Studio) for privacy or cost reasons

Model lock-in is an adoption blocker and a platform risk. The product must run on any capable LLM the user chooses.

## 2. Current state (after Phase 1)

Provider-neutral already: the Telegram bot pipeline, scheduler, skills engine, memory, cockpit, updater, and setup flow.

The provider coupling is isolated behind the `AgentRuntime` interface:

- `src/runtime/types.ts` -- the contract: `run()` (full agent turn with retries), `runOnce()` (bare one-shot for batch jobs like the dreaming sweep), `steer()`, `getActiveWorkspaces()`
- `src/runtime/claude.ts` -- `ClaudeAgentRuntime`, the only file allowed to import `@anthropic-ai/claude-agent-sdk`
- `src/runtime/index.ts` -- factory keyed by `AGENT_RUNTIME` in `.env` (default `claude`)
- `src/agent.ts` -- thin facade keeping the historical `runAgent()` signature and per-chat lane tracking

What the Claude harness still provides invisibly, and what a provider-agnostic runtime must own: the agentic loop (model, tool call, tool result, model), tool execution and permissioning, MCP server connections, session persistence and resumption, and subagent dispatch.

## 3. Strategy

**Own the agent loop, abstract the model.**

There is no cross-provider equivalent of Claude Code to swap in, so we do not abstract at the harness level. We abstract at the model-call level (one interface, many providers) and own a small agent runtime above it.

### Non-goals

- Keeping the Claude Agent SDK as a long-term swappable backend. It is a dev harness, not a product runtime; dual-path maintenance is a bleed. It remains the reference implementation during migration.
- Identical output quality on every model. We certify capability tiers instead (Section 7).
- Supporting models below the capability floor (no tool calling, tiny context).

## 4. Layer 1: Provider abstraction (buy, don't build)

Use the **Vercel AI SDK** as the model interface. TypeScript (matches the stack), actively maintained, one `streamText` / tool-calling API across all majors.

| User situation | Coverage |
|---|---|
| Anthropic subscription | `@ai-sdk/anthropic` |
| OpenAI shop | `@ai-sdk/openai` |
| Google / Gemini shop | `@ai-sdk/google` |
| Enterprise on Azure | `@ai-sdk/azure` (largest enterprise segment) |
| Enterprise on AWS | `@ai-sdk/amazon-bedrock` |
| Self-hosted (Ollama, vLLM, LM Studio, llama.cpp) | OpenAI-compatible provider with custom `baseURL`. One adapter covers the whole self-hosted world |
| Aggregator | OpenRouter as one more provider entry (one key, 300+ models). Optional, never in the core path |

Rules:

- No hand-rolled per-provider HTTP adapters. Maintenance trap.
- No proxy (LiteLLM, gateway) in the request path at launch. In-process abstraction first; gateways can be added later as just another provider entry.
- Prompts stay provider-neutral. Per-provider shims only where a quirk demands it, isolated in the adapter layer.

## 5. Layer 2: Agent runtime (build, the real work)

Replacements for what the Claude Agent SDK provides free today:

| Claude Agent SDK gives us | Replacement |
|---|---|
| Agent loop | AI SDK `Agent` / `stopWhen` loop, including retries and turn-death recovery |
| MCP servers | Official MCP TypeScript SDK client, exposed to the loop as AI SDK tools. Existing skills/integrations keep working |
| Session resumption | Own conversation state in SQLite (already present). Bonus: memory becomes portable across model switches |
| Skills / context injection | The skills engine, unchanged. Already provider-neutral |
| Subagents | Dispatch = new runtime instance with a scoped tool set and its own model config |
| Permissions | Explicit per-install tool allowlist |

## 6. Layer 3: Configuration and routing

- **BYOK / BYOE per install.** Provider + model + key or endpoint URL in config. Keys encrypted at rest, never logged.
- **Task-class routing.** Heartbeats and classification on a cheap model; reasoning and multi-step work on the configured frontier model.
- **Fallback chains.** Primary model down or rate-limited, fall to a declared fallback. AI SDK supports this natively.

## 7. Layer 4: Certification (the honest version of "works with any LLM")

A 7B local model and a frontier model will not behave the same. Set a floor and certify above it.

- **Capability floor:** tool/function calling required, 32k+ context, streaming. Below floor = unsupported.
- **Eval suite:** 30 to 50 golden tasks drawn from real usage (scheduling, email triage, skill routing, multi-step tool chains). Run against each provider/model combination on every release.
- **Tiers:** Certified (evals pass, supported), Compatible (works, best effort), Experimental (self-hosted anything, no guarantees).

The eval harness is the moat. Anyone can call five APIs; knowing exactly which models can run these workloads is the thing competitors won't have.

## 8. Cross-platform setup (macOS and Windows)

The product installs and runs as a local service on the user's machine. Today's setup is macOS-only (launchd, bash `setup.sh`, system Node). Windows is a first-class target, not a port.

Principles:

- **Native Windows, no WSL requirement.**
- **One language for automation.** Every setup and maintenance script becomes Node/TypeScript, same runtime as the product. No bash in the product.
- **Bundle the runtime.** Ship a pinned Node runtime inside the installer (or package a single executable via Node SEA). The user's system Node version becomes irrelevant, which also kills the native-module ABI mismatch class of failure (better-sqlite3).

| Concern | macOS | Windows | Approach |
|---|---|---|---|
| Service / autostart | launchd | Windows Service (winsw or node-windows) | One `service install / uninstall / status / logs` CLI wrapping both |
| Config + data dirs | `~/Library/Application Support` | `%APPDATA%` / `%LOCALAPPDATA%` | env-paths style resolution everywhere; hardcoded paths banned |
| Secrets | Keychain | Credential Manager (DPAPI) | One keyring abstraction, encrypted-file fallback for headless installs |
| Native modules (better-sqlite3) | prebuilt binary | prebuilt binary | Pinned bundled runtime + CI verifies prebuilds for both targets |
| Scripts / cron-style jobs | Node scripts via the scheduler | same | The scheduler owns recurring work; no OS cron/launchd jobs beyond the service itself |

Setup flow, identical on both platforms: installer collects the Telegram bot token and provider key/endpoint, registers the service, runs a self-test (one model round-trip, one Telegram message), prints health status.

CI: matrix on `macos-latest` and `windows-latest`: build, unit tests, plus an install smoke test. Linux/systemd becomes nearly free once the Windows discipline is in place; treat as fast-follow.

## 9. Migration phases

1. **Extract the seam** -- DONE (v1.3.0). `AgentRuntime` interface; Claude Agent SDK wrapped behind it. Zero behavior change.
2. **Build the AI SDK runtime** (the big one). Loop + tools + MCP + session persistence. Run Anthropic-via-API through it and A/B against the Claude path with a regression suite until parity.
3. **Add providers** (days each). OpenAI, OpenAI-compatible endpoint, Azure, Gemini, Bedrock. Mostly config plus per-provider quirks.
4. **Product layer.** BYOK vault, routing rules, cost metering, certification matrix, user docs.
5. **Cross-platform installer** (overlaps Phase 4). Service abstraction CLI, setup wizard, launchd + Windows Service registration, keyring abstraction, install smoke tests on both platforms.

Platform discipline (no new bash, no hardcoded paths, CI matrix on macOS + Windows) starts now, not at Phase 5.

Launch scope: Anthropic + OpenAI + OpenAI-compatible covers most "I already have a subscription" cases and all of self-hosted, day one. Azure/Bedrock/Gemini follow demand.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Runtime parity gap vs the Claude harness (subtle behaviors relied on without knowing) | Phase 2 A/B regression suite against the reference path before cutover |
| Provider quirk sprawl (tool schema strictness, streaming differences) | Quirks live only in the adapter layer; core loop stays provider-blind |
| Weak models produce bad experiences attributed to the product | Capability floor + certification tiers, set expectations in docs and UI |
| Key handling | Encrypted at rest, never logged; audit before first external user |
| AI SDK breaking changes | Pin majors, upgrade deliberately; the interface surface used is small |
| Windows-only failure modes (service permissions, path length limits, AV false positives on a bundled runtime) | Windows in the CI matrix from the start; code-sign the installer; install smoke test per release |
| Bash habits creep back in | CI rule: no `.sh` files in the product; all automation is Node/TypeScript |

## 11. Open questions

- [ ] Hosted multi-tenant offering vs single-tenant installs only (changes BYOK vault and isolation design significantly)
- [ ] Pricing interaction with BYOK
- [ ] Eval framework for the certification suite (roll our own vs Braintrust/promptfoo-style tooling)
- [ ] Packaging: bundled Node runtime inside an installer vs single-executable build (Node SEA)
- [ ] Linux/systemd timing (fast-follow, or sooner if early users self-host on Linux servers)
