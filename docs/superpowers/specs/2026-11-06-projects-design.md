# Projects (card #281)

Card #281 under Feature #282. Target v1.73.0. Marc chose to skip the questions, so everything under "Builder's calls" is Claude's and open to change.

## Intent

A customer can carve work into projects, the way Marina does in ChatGPT Projects: a named space with standing instructions, its own chats and its own memory, so a client's work stays with that client. Import (#280) and cross-model review (#283) both build on this.

## What a project is

A row in `projects`: id, the owning chat, name, instructions, timestamps. It owns its web chats, its memory, its pinned decisions, its Telegram session and its scheduled tasks.

## How it works

- **Scope.** `memoryScope(chatId, projectId)` returns the chat id for General and `<chatId>::project::<id>` inside a project. Memory rows, pinned decisions and agent sessions are stored under the scope. Every existing query already filters on that one value, so a code path that never heard of projects lands in General and cannot read a project. Delivery, permissions, privacy and the turn queue keep the real chat id.
- **Instructions.** A `<project>` block rides every turn in the project: chat, web, Shortcut and scheduled job, plus Agent tool briefs. It sits outside history, like the decision ledger, so trimming cannot drop it. Capped at 8,000 characters. Text that would close the block is neutralised.
- **Telegram and other chat platforms.** One active project per chat, in `app_state`, stored by `/project`. Read when a message is queued, so a message sent before a switch runs where it was sent. Each project keeps its own session, so switching back resumes it.
- **Web app.** A chat belongs to the project it was started in. The active Telegram project does not affect the web, and the reverse.
- **Scheduled tasks.** `scheduled_tasks.project_id`. A task created inside a project belongs to it, and runs with its instructions and decisions.

## Commands

`/project` shows where you are and lists projects. `/project new <name>` creates one and goes into it. `/project <name>` goes in. `/project off` returns to General. `/project instructions` shows them, `/project instructions <text>` sets them. `/project rename <name>` renames the current one. `/project delete <name>` says what will go, `/project delete <name> confirm` does it. In the web chat, going in and out uses the sidebar; the rest works the same on the conversation's project.

## Web app

The sidebar gets a New project button, and a project row gets an edit button. Both open a dialog with the name and instructions; editing also offers delete. The chats stay in the sidebar under the project. A full project page like Claude desktop's is a later step. Folder projects (`projects/**/STATE.md`) stay as they are: listed, read-only, and sharing General's memory.

## Builder's calls

- **Strict walls.** Inside a project, recall and pinned decisions are the project's only. General's are not read, and the project's never reach General. The card says "recall stays inside it".
- **Scope key, not a new column on memories.** See above. A missed query fails towards General, never across projects.
- **Owned by the chat.** Projects belong to one chat, like decisions. In a group anyone can change them, matching Marc's call on pinning.
- **Delete is real.** It removes the project's chats, uploads, memory, decisions, session and scheduled tasks, after a confirm. There is no archive in this version.
- **Web voice calls in a project.** The call's transcript is saved to the project's memory, and the project's instructions join the call's notes.

## Not in this version

- Files attached to a project (the card marks them optional). A follow-up, likely with #280.
- The brain folder and shared workspaces are not scoped, the same as chats today.
- Monthly `/audit` counts General memory only.
- Umi port.

## Review focus

- A message queued before a switch runs, saves and resumes in the project it was sent to.
- A Pin tapped after switching lands in the project the card came from.
- `/newchat` and `/forget` in a project clear that project's session only.
- A deleted project's stale id on a chat or task falls back to General rather than failing a turn.
- Instructions cannot close their own block.
