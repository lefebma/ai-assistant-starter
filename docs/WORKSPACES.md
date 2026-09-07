# Shared workspaces

A shared workspace is a private git repo of plain markdown that your assistant
and other people's assistants read and write together. Each person keeps
talking to their own assistant; the assistants stay in step through the files.

## Join one

From chat (primary chat only):

    /workspace join <name> <ssh-url>

The assistant creates an SSH key just for this workspace and shows you the
public half. Add it to the repo as a deploy key with write access (GitHub:
repo Settings, Deploy keys, Add deploy key, tick "Allow write access"), then
send the same command again. It clones the repo under `workspaces/<name>/`,
reads `WORKSPACE.md`, and starts syncing every 30 minutes from that moment, no
restart needed.

The URL must be an SSH one: `git@github.com:org/repo.git` or
`ssh://git@github.com/org/repo.git`. An https URL is refused, because the
per-workspace deploy key can only be used over SSH.

The key is pinned in `~/.ssh/havn-workspaces.conf`, which the assistant adds to
the top of your `~/.ssh/config` with a single `Include` line. It is pinned
there rather than appended to `~/.ssh/config` so that an existing `Host *`
block cannot lend the workspace clone your personal key.

From a shell on the box: `npm run workspace -- join <name> <ssh-url>`, same
two passes. Joining from the shell while the assistant is running does not put
the workspace on that process's timer; restart the assistant, or join from
chat.

## What the assistant sees

Whenever a message mentions the workspace, one of its members, or arrives in a
chat you have linked to it, the assistant gets the matching `STATE.md` files
under a banner naming everyone who can see them, plus standing rules: never
copy private material in, write only to the workspace the request concerns,
mark drafts, ask when unsure. The banner and the rules are delivered as live
instructions, separately from the assistant's conversation history.

The gate is the mention: a message that names no workspace and no member, in a
chat linked to none, pulls in nothing. Name the workspace to pull it in.

Workspace content is not scoped to one chat. Any chat authorized on this box
can surface it, the same way project context works.

## WORKSPACE.md

The repo should carry a `WORKSPACE.md` at its root:

    ---
    name: havn
    shared-with: partner
    members: [Marc Lefebvre + Umi (owner), Marina Alex + Joy (partner)]
    boards: [kanbanzone:pW2nxIua]
    ---

`shared-with` is one of `partner`, `internal`, `client`. Without the file the
workspace is treated as `unknown` and the assistant will not write to it.

## Guards

Before every push the assistant holds back, and tells you about, any file
that looks like a secret, contains private-key material, is over 95MB, is
not markdown, text, or an image (except under `inbox/`), or contains a line
from `workspaces/.private-patterns`. Put phrases or numbers there that must
never leave this install, one per line. If a guard cannot actually unstage the
file it flagged, the whole sync is abandoned and nothing is pushed.

`/workspace status` prints how many private patterns are loaded, or says the
file is missing. A missing file means that guard is doing nothing, so it is
worth a look. The file is the one thing under `workspaces/` that the daily
backup keeps.

Anything under `inbox/` is exempt from the file-type guard, and binary files
are never scanned for content, so a binary dropped in `inbox/` is pushed
unread. Treat `inbox/` as the place for material you have already decided is
shareable.

## Other commands

    /workspace status         each workspace, members, last sync, pattern count
    /workspace sync [name]    sync now
    /workspace leave <name>   remove the clone and the schedule (keeps the key)

## How a sync runs

Stage, run the guards, commit what survives them, then `git pull --rebase`,
then push. Committing first is deliberate: the assistant writes plain files and
they are committed by the next sync, so the working tree is normally dirty, and
git refuses to rebase a dirty tree. It also means a failed pull with unmerged
files is a real conflict rather than a dirty tree in disguise. Any of the
assistant's uncommitted, held-back edits still sitting in the working tree are
stashed across the pull and restored afterwards, so one held-back file never
stalls the workspace.

Conflicts are left in the file with markers and reported to you once, and once
more when they clear. A pull that fails for any other reason (auth, network) is
reported as itself, and three failures in a row get one message; recovery gets
one more. Held-back files are named once per change to the set, not once per
sync. A rebase left half-finished by a crash is reported as needing a human
rather than retried forever.
