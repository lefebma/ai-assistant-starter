# Browser Automation — for Checklists and Attachments

The Kanban Zone Public API v1.3 covers most card operations, including comments. The two remaining UI-only features are **checklists (tasks) and attachments**. Drive these via the Chrome MCP (`mcp__Claude_in_Chrome__*`). Everything else should go through `scripts/kz.py` against the API.

## Prerequisites

1. The user has Kanban Zone open in a Chromium-based browser (Chrome, Comet, Edge, Brave, Arc).
2. The Chrome MCP extension is connected to that browser. If you see tabs that don't match the user's Kanban Zone session, call `mcp__Claude_in_Chrome__switch_browser` to prompt them to pick the right window.
3. The user is already logged in. Per safety rules, never enter credentials on their behalf.

## Finding a card fast

Navigate directly to the card's URL rather than clicking through the board:

```
https://kanbanzone.io/b/{BOARD_ID}/c/{card_number}
```

Only the numeric `number` matters (returned by any `scripts/kz.py` read or create).

## Comments — use the API

Comments are fully API-accessible. Use `scripts/kz.py comment --id <N> --text "..."` (calls `POST /cards/{id}/comments`). No browser step required.

## Checklists (tasks)

**Adding a checklist:**

1. Navigate to the card URL.
2. Find the `Add Checklist` button under the Tasks section.
3. Click; a name prompt opens.
4. Type the checklist name (e.g., "Proposal sent checklist"); press Enter.
5. For each item: find the "+ Add Item" input inside the new checklist, type the item, press Enter.

**Toggling an item:**

1. Navigate to the card URL.
2. Find the checklist item by its text label.
3. Click the checkbox to the left of the item.

Checklist progress updates live via WebSocket — take a screenshot after toggling to confirm the count updated (e.g., `1/3` → `2/3`).

Note: the API returns `completedTasksCount` and `totalTasksCount` on each card, so you can *read* overall checklist progress without the browser — you only need the UI to add or toggle.

## Attachments

**Uploading:**

1. Navigate to the card URL.
2. Find the Attachments section in the right sidebar; click to expand.
3. Click "+ Add Attachment" or the upload button.
4. The user's file picker opens — the assistant cannot interact with the native OS file picker. Tell the user to pick the file themselves, OR if the attachment is already on their filesystem at a known path, use `mcp__Claude_in_Chrome__file_upload` with the file's ref.

Given safety rules typically prohibit downloading files on the user's behalf, attachment workflows are mostly about *uploading* things the user already has. Don't try to download attachments from cards programmatically.

## Login

The Chrome MCP operates in the user's logged-in session. If you land on `https://kanbanzone.io/login`, don't attempt to enter credentials — tell the user and pause.

## Common flaky spots

- **Card panel close** — clicking outside the panel sometimes doesn't close it; use the `×` icon or press Esc.
- **Inline edits** — clicking a field may enter edit mode; Enter commits, Esc cancels.
- **WebSocket delay** — Kanban Zone updates UI via WebSocket; wait ~500ms after an action before verifying with a screenshot.

## Do not

- Submit the Delete Card action. If the user wants to remove a card, archive it via the UI's archive option, or ask them to delete it themselves.
- Click outbound links in card descriptions from the Chrome MCP. If you need to verify external content, navigate to the URL explicitly with `navigate`, and only when the user has asked for it.
- Enter the user's password. Ever.
