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
reads `WORKSPACE.md`, and starts syncing every 30 minutes.

From a shell on the box: `npm run workspace -- join <name> <ssh-url>`, same
two passes.

## What the assistant sees

Whenever a message mentions the workspace, one of its members, or arrives in a
chat you have linked to it, the assistant gets the matching `STATE.md` files
under a banner naming everyone who can see them, plus standing rules: never
copy private material in, write only to the workspace the request concerns,
mark drafts, ask when unsure.

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
never leave this install, one per line.

## Other commands

    /workspace status         each workspace, members, last sync
    /workspace sync [name]    sync now
    /workspace leave <name>   remove the clone and the schedule (keeps the key)

Conflicts are left in the file with markers and reported to you. Three failed
syncs in a row get one message; recovery gets one more.
