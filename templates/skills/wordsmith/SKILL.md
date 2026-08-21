# Wordsmith Skill

Delegate prose generation to a dedicated writing call on the install's configured LLM provider (anthropic, openai, google, or azure; no separate API key). You orchestrate (intent, context, voice, post-processing, send/no-send), the writing model writes. A focused single-purpose call with voice samples produces more human-sounding prose than drafting inline mid-conversation, so for any externally bound copy reach for this skill.

## When to invoke

**Invoke for:**
- Outbound emails (replies, follow-ups, support responses, vendor messages)
- Newsletters, announcements, community comms
- Marketing copy, landing-page sections, ad copy, social posts
- Rewrites, polish, tightening, humanizing existing drafts
- Any "draft / write / compose / rephrase X" ask aimed at a human reader

**Skip for:**
- Code, code comments, commit messages, PR descriptions
- Terse chat replies back to {{OWNER_NAME}} (just answer)
- Internal status updates, scheduled-task heartbeats
- Structured data (JSON, YAML, tables)
- One-liners under ~15 words

If unsure, default to invoking. Worst case is a small extra hop.

## Model selection

The first argument is a tier; `wordsmith.mjs` maps it to the configured provider's models (e.g. anthropic: claude-sonnet-5 / claude-haiku-4-5, openai: gpt-5.4 / gpt-5.4-mini, google: gemini-2.5-pro / gemini-2.5-flash). An explicit model id also works (required form for azure, whose "model" is the tenant's deployment name; it falls back to AI_MODEL).

| Phrasing | Tier |
|---|---|
| Default for any substantive prose | `quality` |
| Quick rewrites, short polishes, one-paragraph touch-ups, "tighten this" | `fast` |
| User explicitly says "quick" | `fast` |
| User explicitly says "best quality" / "important send" | `quality` |

Provider override: set `WORDSMITH_PROVIDER` / `WORDSMITH_MODEL` in .env to pin wordsmith to a different provider than the chat lane (any provider whose API key is in .env works).

## Voice block (always pass via WORDSMITH_VOICE)

Customize the lead sentence to describe {{OWNER_NAME}} and their role. Keep the hard rules verbatim — they are voice-defining.

```
You are writing on behalf of {{OWNER_NAME}}. Match their voice: direct, competent, write like a person, not a brand.

Hard rules — never break:
- No em dashes anywhere. Use commas, periods, or parentheses instead. Rewrite sentences if needed.
- No AI cliches: never use "Certainly!", "Great question!", "I'd be happy to", "As an AI", "I understand", "Absolutely!", "Dive into", "Delve into", "In today's fast-paced world", "Game-changer", "Unlock the power of".
- No sycophancy, no filler, no corporate speak, no hedging adverbs ("very", "really", "quite") unless they earn their place.
- Contractions are fine and usually preferred (it's, don't, we're).
- Vary sentence length. Short sentences land. Longer ones explain.
- Specific over generic. Concrete nouns, real numbers, named things.
- If the audience is technical, talk technical. If it's a prospect, sell the outcome not the method.

Output only the requested copy. No preamble, no "Here's the draft:", no trailing commentary unless asked.
```

## Voice samples (concrete examples, automatic)

`{{PROJECT_PATH}}/skills/wordsmith/voice-samples/` holds real {{OWNER_NAME}} writing — a few representative pieces of email/Slack/LinkedIn copy. `wordsmith.mjs` reads any `.md` files in that folder and appends them to the voice block as worked examples. Concrete samples constrain the writing model more reliably than abstract rules.

You don't need to do anything to use them — invoking `wordsmith.mjs` picks them up automatically. To refresh: drop new samples in, delete stale ones, no other config needed. See `voice-samples/README.md` for what makes a good sample.

## Brand context (optional, via WORDSMITH_CONTEXT)

Inject when the writing task plausibly touches a specific audience or brand and the framing matters. Build your own brand-context blocks (one per audience) over time and reach for the matching one. Skip context injection for purely personal drafts or when the user provides their own framing.

## Invocation

Pass voice as env var, task as arg. Pipe source text on stdin when polishing/rewriting existing copy.

```bash
# Short draft from scratch
WORDSMITH_VOICE="$(see voice block above)" \
  {{PROJECT_PATH}}/skills/wordsmith/wordsmith.mjs \
  quality \
  "Write a 4-line follow-up email to a prospect who liked our discovery call last Tuesday but hasn't replied to my proposal sent Friday. Goal: get a yes/no without sounding pushy."

# Polish existing copy
echo "$EXISTING_DRAFT" | \
WORDSMITH_VOICE="..." \
WORDSMITH_CONTEXT="audience context..." \
  {{PROJECT_PATH}}/skills/wordsmith/wordsmith.mjs \
  fast \
  "Tighten this to 80 words. Keep the call to action."
```

## Post-processing (you, after the model returns)

Before showing the draft to {{OWNER_NAME}}, scan it for voice violations and silently fix:

1. **Em dashes (—, –):** replace with commas, periods, or parentheses. Reword if a comma changes meaning.
2. **AI cliches:** strip them. If the sentence collapses, rewrite it.
3. **Greetings that don't match the ask:** if {{OWNER_NAME}} said "reply to <thread>", the reply should not start with "Hi <name>" if it's mid-thread.
4. **Length compliance:** if the user asked for a specific length and the model overshot by >20%, ask for a tighter pass.
5. **Signature block:** if it's an email going out as {{OWNER_NAME}}, ensure the configured email signature is appended (see CLAUDE.md) unless the thread already has one upstream.

Don't show {{OWNER_NAME}} the raw wordsmith output. Show the cleaned version.

## Output protocol

For anything externally bound (email, newsletter, public post, support reply), present the draft and end the message with the platform's confirmation pattern (e.g. `[[buttons: Send | Edit | Discard]]` on Telegram). For internal-only or "just write me a thing" requests, just show the draft.

## Error handling

- If `wordsmith.mjs` exits non-zero, report the error verbatim and offer to fall back to native writing.
- 429 / 5xx: wait 5s and retry once. If it still fails, fall back.
- Empty response: retry once with the tier upgraded (fast → quality). If still empty, fall back.

## Gotchas

- Models sometimes add a preamble despite the voice rules ("Here's a draft:"). Trim it post-hoc if it sneaks through.
- Default model markdown can be heavier than chat platforms like. For Telegram-bound copy, strip headings and use plain paragraphs.
- Don't pipe huge files (>50KB) into the source. Summarize first or chunk.
- If the user is iterating ("shorter", "punchier", "less corporate"), keep the same tier and pass the previous output as the source on stdin with the new instruction.
