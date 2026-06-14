# Web Research Skill

Perplexity-backed research with three depth tiers. Pick the model based on phrasing, optionally inject business context, and shape output for the messaging surface.

## Prerequisites

- Perplexity API key written to `~/.perplexity-api-key` (one line, no trailing newline).
- `jq` and `curl` available on PATH.

## Model selection

Match the phrasing in the ask to a model:

| Phrasing in the ask | Model | Latency |
|---|---|---|
| "quick take on X", "quick research X" | `sonar-pro` | 5-15s |
| "research X", "look into X", "investigate X", "dig into X" (default) | `sonar-reasoning-pro` | 30-60s |
| "deep research X", "deep dive on X" | `sonar-deep-research` | 2-5 min |

If the ask is ambiguous, default to `sonar-reasoning-pro`.

## Business context injection (optional)

If the topic plausibly touches the owner's work, set `PPLX_CONTEXT` to a one-paragraph framing so Perplexity tailors the answer.

**Default context string** (edit to match the owner):

```
The asker is {{OWNER_NAME}}. {{OWNER_BIO}} Frame the answer with that lens where it sharpens relevance, but stay factual and unbiased in citations.
```

**Skip injection if:**
- The ask is a neutral factual query (populations, definitions, specs, general news)
- The user explicitly says "neutral research" or "unbiased research"

**Override context if the user says a specific lens:**
- "personal research X" → no context injection
- "research X for <project>" → swap in a lens scoped to that project

## Invocation

```bash
# Fast, no business context
{{PROJECT_PATH}}/skills/web-research/research.sh sonar-pro "What's new in MCP servers this quarter?"

# Medium, with injected context
PPLX_CONTEXT="The asker is {{OWNER_NAME}}..." \
  {{PROJECT_PATH}}/skills/web-research/research.sh sonar-reasoning-pro "How are SMB consultancies pricing AI automation in 2026?"

# Deep — write to file
SLUG="mcp-servers-sales-automation"
OUT="{{PROJECT_PATH}}/research/$(date +%Y-%m-%d)-$SLUG.md"
mkdir -p {{PROJECT_PATH}}/research
{
  echo "# MCP servers for sales automation"
  echo "Date: $(date +%Y-%m-%d) · Model: sonar-deep-research"
  echo ""
  PPLX_CONTEXT="..." \
    {{PROJECT_PATH}}/skills/web-research/research.sh sonar-deep-research "..."
} > "$OUT"
echo "Saved: $OUT"
```

## Output shaping

- **Fast (`sonar-pro`)**: paste result. Aim ≤ 500 chars. Include top 2-3 citations as `[1]` inline with a short Sources block.
- **Medium (`sonar-reasoning-pro`)**: paste result. Aim ≤ 1500 chars. Full citations block at the end.
- **Deep (`sonar-deep-research`)**: **do NOT paste the full content.** Reply with:
  ```
  Deep research complete.

  <3-line summary of key findings>

  Saved: research/YYYY-MM-DD-slug.md
  Ask to expand any section.
  ```

## Slug generation for deep research files

Build the slug from the core topic of the ask:
- lowercase, words joined by hyphens
- drop stopwords (the, a, of, for, on, in, and)
- max 6 words / 60 chars
- strip non-alphanumeric

"deep research the current state of MCP servers for sales automation"
→ slug = `current-state-mcp-servers-sales-automation`
→ file = `research/YYYY-MM-DD-current-state-mcp-servers-sales-automation.md`

## Error handling

The script exits non-zero on API errors. If it fails:
1. Check `~/.perplexity-api-key` exists and is non-empty
2. Report the error to the user verbatim, do not paper over it
3. Don't retry automatically on 4xx; 429/5xx can retry once after a 5s wait

## Gotchas

- The `research/` folder should be gitignored (private business intel). Don't commit research files.
- `sonar-deep-research` is expensive in both time and tokens. Only use it when the user explicitly asks for deep research.
