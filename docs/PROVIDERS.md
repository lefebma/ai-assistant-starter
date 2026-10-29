# Choosing Your Model Provider (BYOK)

The assistant runs on whichever LLM you bring. Claude on a Claude subscription is the
default and needs no configuration. Everything else runs through the AI SDK runtime:
one setting flips the engine, and the assistant keeps all its skills, tools, memory,
and scheduled tasks.

## Quick start

In `.env`:

```
AGENT_RUNTIME=ai-sdk
AI_PROVIDER=openai          # anthropic | openai | google | azure
AI_MODEL=gpt-5.4            # required for every provider except anthropic
OPENAI_API_KEY=sk-...       # or put it in the vault, see docs/VAULT.md
```

Restart the service. That's the whole migration; conversations, skills, and
scheduled tasks carry over.

| Provider | `AI_PROVIDER` | Key variable | `AI_MODEL` example |
|---|---|---|---|
| Anthropic (API) | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` (default) |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.4` |
| Google | `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| Azure OpenAI | `azure` | `AZURE_API_KEY` | your *deployment name* |
| Self-hosted / compatible | `openai` + `AI_BASE_URL` | `OPENAI_API_KEY` (any value some servers ignore) | whatever your server hosts |

Keys are read from the encrypted vault first, then `.env` (see
[docs/VAULT.md](VAULT.md)). They are never logged.

## Bringing your own AI account

If your provider set up your assistant's AI for you, you can move it onto your own account at any time: to pay the AI bill directly, or to use a different company's models. Nothing else changes. Your chats, memory, skills and scheduled tasks stay as they are.

1. Ask your provider to switch your assistant over. They turn off the AI connection they manage, which removes their key from your assistant. Until step 2 is done your assistant can't reply, so do both steps together.
2. Add your own key. In the chat with your assistant, send `/secret set ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `AZURE_API_KEY`). It asks for the key as your next message and stores it encrypted. Your provider then sets the matching `AGENT_RUNTIME`, `AI_PROVIDER` and `AI_MODEL` lines from the Quick start above and restarts the assistant. To use a Claude subscription instead of a key, your provider signs it in for you.
3. Send your assistant a message to check it answers.

From then on your own AI account sets your limits and your bill. The monthly allowance and the "about 80% used" heads-up from your provider no longer apply.

## Azure OpenAI

For organizations that want the models billed and governed under their own
Microsoft agreement. Create an Azure OpenAI resource, deploy a model in Azure
AI Foundry, then:

```
AGENT_RUNTIME=ai-sdk
AI_PROVIDER=azure
AI_MODEL=my-gpt-deployment      # the DEPLOYMENT name you chose, not the vendor model id
AZURE_API_KEY=...               # or put it in the vault
AZURE_RESOURCE_NAME=contoso-ai  # the {name} in https://{name}.openai.azure.com
```

Optional: `AZURE_API_VERSION` pins an api-version if your tenant requires one,
and `AI_BASE_URL` replaces the resource-name URL entirely for sovereign clouds
(Azure Government, custom domains). Usage lands on your Azure invoice; nothing
is billed through us.

## Self-hosted models

Any OpenAI-compatible endpoint works — Ollama, vLLM, LM Studio, llama.cpp server,
or a gateway:

```
AGENT_RUNTIME=ai-sdk
AI_PROVIDER=openai
AI_BASE_URL=http://localhost:11434/v1
AI_MODEL=qwen3:32b
OPENAI_API_KEY=ollama
```

Mind the capability floor: the model must support tool/function calling and a
32k+ context window. Small local models run, but see certification below for
what "works" actually means.

## Different engines for chat vs scheduled work

`AGENT_RUNTIME_CRON` routes ALL scheduled tasks (and the nightly reflection) to a
different engine than live chat. The common setup: chat on an API model you're
testing, unattended overnight work on your Claude subscription where a runaway
task can't run up a bill:

```
AGENT_RUNTIME=ai-sdk
AGENT_RUNTIME_CRON=claude
```

## Certify your model before you commit

Don't take "works with any LLM" on faith — measure it against your own workload:

```bash
node dist/scripts/ab-eval.js --providers=anthropic,openai,google --tier=full
```

The golden-task suite runs real work (shell commands, file edits, multi-step tool
chains, session memory) and grades each provider. Save a baseline with
`--update-baseline` and gate future changes with `--baseline` — see
[certification/README.md](../certification/README.md).

Practical tiers:
- **Certified**: passes the full golden set on your install. Safe to run daily.
- **Compatible**: passes the smoke tier (`--tier=smoke`). Fine for chat; watch
  multi-step tool work.
- **Experimental**: anything below the floor (no tool calling, tiny context).
  Expect failures that look like assistant bugs but aren't.

## Switching providers later

Just change `AI_PROVIDER` / `AI_MODEL` and restart. Existing conversation history
is sanitized automatically on the first turn after a switch (provider-specific
metadata like reasoning signatures is stripped, so replay doesn't break). Your
memory, skills, and schedules are provider-neutral and unaffected.

## Watching what it costs

The AI SDK runtime records token usage for every turn. See where the tokens went:

```bash
node dist/scripts/usage-report.js --days 30
```

Token counts per day/provider/model, no dollar estimates — your provider's own
console is the billing source of truth. Claude-subscription turns aren't metered
(no per-token bill to watch).
