# Anti-Library Skill

LLM-maintained knowledge bases using Karpathy's anti-library pattern. Each Obsidian vault becomes a structured, interlinked wiki that the LLM writes and maintains. {{OWNER_NAME}} curates sources and asks questions. The LLM does all bookkeeping.

## Vault Registry

Known vaults (add new ones here as they're created):

| ID | Domain | Path |
|----|--------|------|
| `default` | (general knowledge) | `{{OBSIDIAN_VAULT_PATH}}` |

When {{OWNER_NAME}} says "set up a new vault at <path>", add it here, then run the Setup workflow below.

## Vault Structure

Every vault follows this layout:

```
<vault-root>/
  CLAUDE.md          # Schema: conventions, workflows, page templates (LLM reads this first)
  sources/           # Raw source materials (immutable, LLM never modifies)
    article-slug.md
    paper-title.pdf
    transcript.txt
  wiki/              # LLM-generated markdown (LLM owns this entirely)
    index.md         # Catalog of all pages with one-line summaries, organized by category
    log.md           # Append-only chronological record of all operations
    overview.md      # High-level synthesis of the entire knowledge base
    entities/        # Pages about specific things (people, tools, companies, projects)
    concepts/        # Pages about ideas, patterns, frameworks
    comparisons/     # Side-by-side analyses generated from queries
    sources/         # One summary page per ingested source
```

## Workflows

### 1. Setup (new vault)

When creating a new vault or initializing an existing folder:

1. Create the directory structure above
2. Write the `CLAUDE.md` schema (see Schema Template below)
3. Create empty `wiki/index.md` and `wiki/log.md`
4. Create `wiki/overview.md` with a placeholder
5. Add the vault to the registry table above
6. Confirm to {{OWNER_NAME}} with the path

### 2. Ingest

Triggered by: "ingest this", "add to vault", "ingest source", or dropping a file/URL

Flow:
1. Read the vault's `CLAUDE.md` to load conventions
2. Read `wiki/index.md` to understand existing content
3. Read the source material (file, URL, or pasted text)
4. If pasted text or URL, save to `sources/` with a slug filename
5. Write a summary page in `wiki/sources/<slug>.md`
6. Create or update relevant entity pages in `wiki/entities/`
7. Create or update relevant concept pages in `wiki/concepts/`
8. Update `wiki/index.md` with new/changed pages
9. Update `wiki/overview.md` if the new source shifts the big picture
10. Append an entry to `wiki/log.md`
11. Report: what was ingested, pages created/updated, key takeaways

A single source might touch 10-15 wiki pages. That's normal.

**Source slugs:** lowercase, hyphens, drop stopwords, max 6 words. Example: "Building LLM Applications with RAG" -> `building-llm-applications-rag`

### 3. Query

Triggered by: questions about the vault's domain, "query the wiki", "what does the wiki say about"

Flow:
1. Read `wiki/index.md` to find relevant pages
2. Read those pages
3. Synthesize an answer with `[[wiki links]]` as citations
4. If the answer is valuable and reusable, offer to file it back as a new wiki page (comparison, analysis, etc.)

### 4. Lint / Maintain

Triggered by: "lint the wiki", "wiki maintenance", "clean up the vault"

Flow:
1. Read all wiki pages
2. Check for: broken `[[links]]`, stale summaries, missing cross-references, pages not in index, contradictions
3. Fix issues directly
4. Append a lint entry to `wiki/log.md`
5. Report: issues found and fixed

### 5. Vault Selection

If {{OWNER_NAME}} has multiple vaults registered and doesn't specify which one:
- If the topic clearly matches a vault's domain, use that one
- If ambiguous, ask: "Which vault? [list domains]"

## Page Conventions

All wiki pages follow these rules:

- **Wikilinks:** Use `[[Page Name]]` for internal links (Obsidian format)
- **Frontmatter:** Every page gets YAML frontmatter with `created`, `updated`, `sources` (list of source slugs that informed the page)
- **Headings:** H1 is the page title, H2 for major sections
- **Tone:** Factual, concise, no fluff. Write for someone scanning quickly.
- **Contradictions:** When sources disagree, note both positions explicitly. Don't silently pick one.
- **Attribution:** When a claim comes from a specific source, cite it inline: "According to [[sources/slug]], ..."

## Index Format

`wiki/index.md` is organized by category:

```markdown
# Index

## Sources
- [[sources/building-llm-apps-rag]] - Summary of RAG architecture patterns (2026-05-31)

## Entities
- [[entities/langchain]] - Python framework for LLM application development

## Concepts
- [[concepts/retrieval-augmented-generation]] - Pattern for grounding LLM outputs in external data

## Comparisons
- [[comparisons/rag-vs-fine-tuning]] - When to use retrieval vs. model customization
```

## Log Format

`wiki/log.md` uses parseable entries:

```markdown
# Log

## [2026-05-31] ingest | Building LLM Apps with RAG
- Source: sources/building-llm-apps-rag.md
- Pages created: sources/building-llm-apps-rag, concepts/retrieval-augmented-generation, entities/langchain
- Pages updated: overview, index
- Key takeaway: RAG works best when chunk size matches query granularity

## [2026-05-31] query | RAG vs fine-tuning tradeoffs
- Answer filed as: comparisons/rag-vs-fine-tuning
- Pages referenced: concepts/retrieval-augmented-generation, concepts/fine-tuning
```

## Schema Template

Use this as the starting point for each vault's `CLAUDE.md`. Customize the domain-specific sections for each vault.

```markdown
# {Domain} Knowledge Base

You are maintaining a structured knowledge base about {domain description}.

## Structure

- `sources/` contains raw source materials. Never modify these.
- `wiki/` contains LLM-generated pages. You own this directory entirely.
- `wiki/index.md` is the catalog. Update it on every ingest.
- `wiki/log.md` is the changelog. Append to it on every operation.
- `wiki/overview.md` is the high-level synthesis. Update when the big picture shifts.

## Page types

- **Source summaries** (`wiki/sources/`): One page per ingested source. Key claims, data points, and takeaways.
- **Entity pages** (`wiki/entities/`): People, tools, companies, projects. Facts, relationships, mentions across sources.
- **Concept pages** (`wiki/concepts/`): Ideas, patterns, frameworks. Definition, how it works, where it appears, open questions.
- **Comparisons** (`wiki/comparisons/`): Side-by-side analyses. Generated from queries or when sources naturally contrast.

## Conventions

- Use `[[wikilinks]]` for all internal references
- YAML frontmatter on every page: created, updated, sources
- When sources contradict, note both positions
- Cite sources inline: "According to [[sources/slug]], ..."
- Keep pages focused. Split when a page exceeds ~500 lines.
- Prefer tables for structured comparisons
- No orphan pages: everything links to/from index.md

## Domain context

{Brief description of what this knowledge base covers and any domain-specific conventions}
```

## Error Handling

- If a source is a URL, fetch it and save the content to `sources/`. If fetch fails, report and stop.
- If a source is a PDF, note that the content was extracted (Obsidian can't render PDFs inline but the wiki pages will have the extracted knowledge).
- If the vault path doesn't exist, ask {{OWNER_NAME}} to confirm before creating it.
- Never modify files in `sources/`. That's the immutable layer.

## Gotchas

- Vault paths may contain spaces (iCloud Obsidian convention). Always quote paths.
- Obsidian auto-syncs via iCloud / Obsidian Sync. Don't worry about sync, just write the files.
- Large vaults (100+ sources): read `index.md` first, then drill into specific pages. Don't try to read everything at once.
- The `CLAUDE.md` in each vault is separate from the project-level `CLAUDE.md`. It's the vault's schema, not the assistant's config.
