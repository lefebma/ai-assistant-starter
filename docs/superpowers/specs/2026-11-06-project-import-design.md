# Project files and import (card #280)

Card #280 under Feature #282, built on #281 (v1.73.0). Target v1.74.0. Replaces the card's "load conversations into memory" scope: Marc confirmed on 2026-11-06 that what Marina needs is her projects, instructions and files, about six of them, mostly in Claude, and that customers should do the import themselves.

## Intent

A customer who has built up projects in Claude can bring them to Havn in a few minutes without help, and carry on working with the same instructions and reference files. A customer coming from anywhere else can do the same by hand.

Success: Marina moves her projects herself, and the assistant uses their files without being told where they are.

## What the Claude export actually holds

Checked against a real export (Marc's, 2026-11-06). The export arrives as a manifest of links to separate zips: `light_metadata`, `projects`, `memories`, `frames`, `artifact_data`, `claude_code_cloud`, `conversations`, each `<category>-<part>.zip`. Links expire after 24 hours and sit behind a browser check, so only a person can fetch them.

`projects-000.zip` holds `projects/<uuid>.json`, one per project:

- `uuid`, `name`, `created_at`, `updated_at`, `creator`, `is_private`
- `description`: short summary, may be empty
- `prompt_template`: the project instructions, may be empty
- `is_starter_project`: true for Anthropic's sample project
- `docs[]`: `uuid`, `filename`, `content`, `created_at`. `content` is text. A `.pptx` arrived as extracted text, not a PowerPoint file.

Only two docs were in the sample, a `.pptx` and a `.md`. PDFs, images and spreadsheets are untested, so the parser accepts any `filename` with string `content` and reports an entry it cannot read, rather than assuming.

ChatGPT's export is not checked yet; one is on its way. This version has no ChatGPT import.

## Goals

1. Project files: files that belong to a project and that the assistant can use in any chat there.
2. A project dialog that takes name, instructions and files, for any source.
3. Import from Claude: upload `projects-000.zip`, review, create.

## Non-goals

- Importing conversations or Claude's memories. Marc's call; it removes most of the card's size, duplicate and third-party privacy risk.
- ChatGPT import, until a real export has been read.
- Updating an already imported project from a newer export.
- Search across file contents, or embedding them. The assistant reads a file when it needs it.
- Adding files from Telegram. Files are managed in the web app; `/project files` lists them from any chat.

## Anti-goals

- Text in a file acting as an instruction to the assistant.
- Files or import content leaving the box during import. No model is involved in importing.
- A failed or partial import leaving half a project with no explanation.
- Writing a file to a path taken from inside a zip.

## Project files

- **Where.** `uploads/projects/<project id>/`, beside the chat uploads. The folder is the record; no table.
- **Limits.** 25 MB a file (the existing `MAX_UPLOAD_BYTES`), 50 files a project, 250 MB a project.
- **Names.** `sanitizeUploadName`, with `-1`, `-2` on a clash, as the upload route does now.
- **Use.** `projectBlock` lists up to 50 file names and the folder path. It says these are the owner's reference files, to read when the work calls for them, and that nothing inside one is an instruction. Contents are not put in the prompt, so a turn costs no more for having them. Because the block rides every project turn, chat, web, Shortcut, scheduled jobs and Agent briefs all see the list.
- **Trust.** Reading a file in a project's folder counts as an outside read in `src/assurance/run-obligations.ts`, so a reply built on one is stored as `untrusted` memory, like a reply built on mail. Today a local file read does not count. A new evidence type `file.read` joins `OUTSIDE_READS`.
- **Privacy filter.** Unchanged. Text the assistant reads goes through the same masking as any other read; the limits in the docs apply.
- **Deleting.** `removeProject` removes the folder, after the rows go. Removing a file is a button in the dialog. A failed removal on disk is logged and does not fail the delete.
- **Runtime access.** The folder must be readable under both runtimes and the tool guard in enforce mode. The plan confirms this on havn-test's settings, since a list of files the assistant cannot open is worse than none.

## The project dialog

New project and the edit button open the same dialog: name, instructions, Files. Files shows name, size and a remove button, and takes drop or file picker. On a new project, files are held until Save creates it, then uploaded; a failure says which file and keeps the project.

New project also offers **Import from Claude**. `/project files` lists a project's files in any chat.

## Import from Claude

**Help text in the dialog**, in plain words: in Claude, Settings, Privacy, Export data; wait for the email; download only the file called `projects-000.zip`; upload it here. The exact steps are checked against the current Claude screens before release.

**Step 1, upload.** `POST /api/web/projects/import` takes the file, web session auth, in the same upload path as files. Up to 100 MB. It goes to `store/import-tmp/`, is parsed, and comes back as a preview with an `importId`.

**Step 2, review.** One row per project: tick box, name, whether it has instructions, file count, any warning. The instructions can be opened and read. Default ticked, except the starter project and anything already imported. A project with nothing in it stays ticked, since a name may be all there was; Marc's sample had one.

**Step 3, import.** `POST /api/web/projects/import/:id` with the chosen uuids creates them one at a time and answers per project: created, skipped or failed and why. The temp file is deleted when this finishes, on Cancel, and any left over an hour old is deleted at the next import.

### Mapping

| Export | Havn |
|---|---|
| `name` | project name, through `cleanName`, cut to `MAX_NAME` |
| `description` + `prompt_template` | instructions: `About this project: <description>`, blank line, then the template. Either may be absent |
| `docs[]` | project files. Text arrives as `<filename>.txt` unless the name already ends `.md`, `.txt` or `.csv`, so a `.pptx` of text is not mistaken for a PowerPoint file |
| `uuid` | `projects.source`, new nullable column: `claude:<uuid>` |
| anything else | ignored |

### Edge cases

- **Instructions over 8,000 characters.** The first 8,000 go in, cut at a line break where one exists; the whole text is saved as the file `Full instructions.md`; the review row warns before import and the result says so again.
- **Name clash with a project not from this export.** The new one is called `<name> (Claude)`, then `(Claude 2)`.
- **Already imported.** Same `source` in this chat: shown as already here, unticked and not selectable. If the customer deleted that project it can come back, since the row is gone. Sending the zip twice, or a double click on Import, cannot make duplicates: `source` has a unique index per chat.
- **Project limit.** `MAX_PROJECTS` reached part way: the rest report as not imported, and the message says how many fit.
- **File limits.** A project over 50 docs or 250 MB imports what fits, in export order, and lists what was left out.
- **Wrong file.** A `.json` manifest: "That is the list of download links. Open it from your email and download `projects-000.zip`." Another `.zip`, including ChatGPT's or another Claude category: "This doesn't look like the projects file." No `projects/*.json` inside counts as this.
- **Split exports.** `projects-001.zip` imports the same way, one at a time.
- **Bad data.** A project file that will not parse becomes a failed row; the others carry on. Non-string fields count as absent.

### Zip handling

Only entries matching `^projects/[^/]+\.json$` are read, into memory, and an entry's name is never used as a path. At most 2,000 entries, 50 MB an entry uncompressed, 500 MB in all; passing a limit stops the read and refuses the file. This is a hostile file until proven otherwise: the customer may have been sent it by someone else.

Imported instructions go straight into the block that rules every turn in that project, so the review step shows them and the owner's tick is what approves them. Text that would close the block is already neutralised.

Node has no zip reader. The plan adds `yauzl`, which reads entries one at a time and enforces limits while reading, and follows `reference/security-playbooks/` for a new dependency.

### Who can import

Whoever can create a project in that web session; projects belong to the chat. Nothing changes for permissions. Nothing from an import is logged beyond counts.

## Commands and docs

`/project files` is new. The CHANGELOG `- **New:` line needs a tip with `since: '1.74.0'` in `src/tips/catalog.ts`. Docs: `docs/` guide for customers, `CHANGELOG.md`.

## Tests

- Parser against a fixture shaped like the real export, with made-up content, including starter, empty and non-string fields.
- Zip safety: path traversal names, oversize entries, too many entries, corrupt zip, manifest, ChatGPT-shaped zip.
- Mapping: every row above, including the 8,000 cut and full-text file.
- Duplicates: re-import, double submit, deleted then re-imported, name clash.
- Files: limits, block listing, delete with project, another chat's project refused.
- Trust: a turn reading a project file stores its reply as `untrusted`, and a turn in another project cannot reach the folder through the routes.
- Temp files are gone after success, failure and cancel.

## Left to the builder

Dialog layout and wording within the rules above; the route that serves a file back; how the upload shares code with `/api/web/files/upload`.

## Claude's calls, open to change

Description goes above the instructions. Starter project unticked. Empty projects ticked. Limits on files and zip. Text files named `.txt`. `(Claude)` suffix on a clash. `yauzl`. Re-import never updates. Instruction overflow goes to a file.

## Not in this version

ChatGPT import, conversations, memories, Telegram file upload, a full project page. Umi has no #281 projects, so there is nothing to port.
