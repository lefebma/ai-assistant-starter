# Import from ChatGPT (card #280 follow-up)

Feature #282. Builds on Import from Claude (v1.74.0). Marc asked for it on 2026-11-09 after reading what a real export holds, and approved the shape below in chat: projects come across with their conversation history; the customer names each project and pastes its instructions.

## What the ChatGPT export holds

Checked against Marc's export (2026-11-09). One zip, about 800 MB:

- `conversations-000.json` ... `conversations-014.json`: a JSON array each, 100 conversations a shard, about 50 MB in all. Older exports have one `conversations.json`.
- About 2,900 `file-<id>.dat` attachments (pictures, voice recordings, a few PDFs), named in `conversation_asset_file_names.json`.
- `library_files.json`, `user_settings.json`, `group_chats.json`, `codex.json`, `pages/`, `index.html` and others.

A conversation in a ChatGPT project carries the project's id in `conversation_template_id`, starting `g-p-`. Marc's export: 1,432 conversations, 8 projects, 100 conversations in them.

**Not in the export:** project names, project instructions, project files, and ChatGPT's memories. Searched every file, including the HTML viewer.

Each conversation: `id`, `title`, `create_time`, `update_time` (seconds), `current_node`, and `mapping`, a tree of nodes `{id, parent, message}`. The thread shown in ChatGPT is the path from `current_node` up through `parent` to the root. A message has `author.role`, `content.content_type` and `content.parts`, `recipient`, `create_time`, `metadata`.

## Intent

A customer with ChatGPT projects can bring each one to Havn with its past conversations, so the assistant can look back at earlier work there, and carry on in the same project. The customer supplies what the export leaves out: the name and the instructions.

## Goals

1. Import from ChatGPT beside Import from Claude, in the same dialog.
2. One row per ChatGPT project: the customer recognises it by its conversation titles, names it, optionally pastes its instructions, ticks it.
3. Each imported project holds its conversations as readable files.

## Non-goals

- Conversations outside projects. They stay out, and never leave the customer's computer.
- Pictures, voice recordings and other attachments. A picture becomes `[picture]` in the text.
- ChatGPT memories and custom instructions (not in the export).
- Project files from ChatGPT (not in the export as files tied to a project).
- Updating a project from a newer export.

## Anti-goals

- Uploading the whole 800 MB export to the box.
- Text from a conversation acting as an instruction. It is project file text, already counted as an outside read (`file.read`), so replies built on it are stored as outside text.
- Logging names, titles or content. Counts only.

## How it works

**In the browser.** The customer picks the export zip, or, when Safari has already unzipped it, the `conversations` files inside. `public/app/chatgpt-export.js` reads the zip's directory, inflates only `conversations.json` or `conversations-NNN.json` (at the top or one folder down) with `DecompressionStream('deflate-raw')`, keeps the conversations whose `conversation_template_id` starts `g-p-`, and uploads them as one JSON array. Nothing else in the zip is read. Limits: 300 MB a conversations file uncompressed, 100 MB upload. Other entries are listed from the directory but never opened, so the zip's size does not matter.

**On the box.** `POST /api/web/projects/chatgpt-import` takes the JSON array (octet-stream, web session, 100 MB), writes it to `store/import-tmp/`, parses it as hostile input and answers with a preview and an `importId`, the same way the Claude import does. The upload is deleted once parsed; the parsed projects are held in memory under the same rules (one per chat, an hour at most, swept).

**Review rows.** For each project, newest activity first: a tick, a name field prefilled `ChatGPT project 1`, 2, ..., the number of conversations and their date range, the five newest titles, and Show for all titles plus an instructions box. Already imported: shown, not selectable.

**Import.** `POST /api/web/projects/chatgpt-import/:id` with `{ projects: [{ id, name, instructions }] }`. Each project is created through the same path as Claude's: `chatgpt:<g-p id>` as `source` (unique per chat), name through `cleanName` with `(ChatGPT)`, `(ChatGPT 2)` on a clash, instructions over 8,000 characters cut with the full text saved as `Full instructions.md`. Then the history files. Per-project results as for Claude. Cancel uses the existing cancel route.

## History files

- **Text.** Markdown: the title, `Imported from ChatGPT.` and the dates, then each message as `**You:**` or `**ChatGPT:**` followed by its text, with a `### <date>` line when the day changes. Dates are UTC days.
- **Which messages.** The `current_node` path only (edited-away branches drop out). Roles `user` and `assistant`, `recipient` `all`, content `text` or `multimodal_text`, not marked hidden. Parts: strings as written, `audio_transcription` as its text, pictures as `[picture]`, anything else dropped. Empty messages dropped.
- **Files.** At most 40 history files a project, leaving room for the owner's own. One file per conversation, `ChatGPT <YYYY-MM-DD> <title>.md`, when they fit; otherwise one per month, `ChatGPT <YYYY-MM>.md`, and if months do not fit, one per year. Grouped files get an index, `ChatGPT conversations.md`, listing each title, date and file. A file over 25 MB is split into parts. What does not fit the project's limits is listed as left out.
- **Hostile input.** Tree walk with a visited set and a 20,000-node cap; non-string fields count as absent; a conversation that cannot be read is counted and skipped; 5,000 conversations and 1,000 projects at most.

## Errors

- Not a ChatGPT export (no conversations files, or the JSON is not an array of conversations): "This doesn't look like a ChatGPT export."
- A Claude file picked in the ChatGPT view: same message.
- No conversations in projects: "There are no ChatGPT projects in this export."
- Too large, corrupt, expired: as the Claude import.

## Tests

- Parser and transcript against a fixture shaped like the real export, made-up content: branches, hidden and tool messages, pictures, voice, cycles, bad fields, duplicates.
- File planning: per conversation, by month, by year, split, limits.
- Routes: preview, import, already imported, clash, double submit, another chat's import refused, temp file gone.
- Browser reader in Node: stored and deflated entries, one folder down, non-matching entries never inflated, a corrupt zip, loose JSON files.

## Claude's calls, open to change

Browser-side reading. Projects only. 40 history files, per conversation then month then year. `ChatGPT project N` as the starting name. `(ChatGPT)` suffix. Pictures as `[picture]`. UTC days. Newest project first.
