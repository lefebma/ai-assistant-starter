# The web app

A page in your browser where you can chat with your assistant, keep projects and
goals, and see the files it works with. It is the same assistant as your chat
app, with more room.

## Getting in

Send `/app` to your assistant in your one-to-one chat. It replies with a
sign-in link. The link works once and expires after 15 minutes. Open it in your
browser and you are in; you stay signed in on that browser for 30 days, and
every visit extends it.

- On a box with a public address the link looks like `https://your-address/app#token=...`.
- On a box without one, the link only works on the same Wi-Fi as the box.
- If the page shows "Send /app to your assistant", your sign-in ended. Send
  `/app` again.

## Signing out

Send `/app signout` in your chat. It signs out every browser, and tells you how
many. You can also sign out from **Settings** in the page.

## What is in it

- **Chats.** Conversations in the web app are separate from your chat app
  thread. Your chat app messages do not show up here, and the other way round.
  Each conversation keeps its history.
- **Projects and goals.** Group conversations by project. Goals are the
  Priorities section of your `PROFILE.md`, the same list your briefing reads.
- **Files.** A panel on the right shows the files in your assistant's folder.
  You can preview text, images and PDFs, and upload files for your assistant.
- **Pictures, files and pasted text in a message.** Paste a screenshot or an
  image into the chat box, drop files on the chat, or use the paperclip. They
  wait above the box until you send, and you can remove any of them. Pasted
  text over about 4,000 characters becomes a "Pasted text" chip instead of
  filling the box. Up to 10 attachments per message, 25 MB each; screenshots
  larger than 2048 pixels are scaled down first. Your assistant sees the
  pictures themselves, not just their names.
- **Settings.** What is connected (AI provider, Telegram, mail and calendar,
  voice), and your signed-in browsers.

### Model and effort

Each conversation has two pickers at the top.

- **Model.** Which AI answers: Default, or a smaller and faster one, or the
  most capable.
- **Effort.** How hard it thinks before answering: Low is quick, High takes
  longer and goes deeper. Default leaves it to the assistant.

### Commands

The slash commands from your chat app work here too, and they do the same
thing: `/schedule`, `/cancel`, `/skill`, `/memory`, `/support`, `/update`
and the rest. Type `/` in the message box to see the list. A command's answer
shows up in the conversation, buttons included.

- **`/newchat`** starts this conversation fresh. Your chat app's thread is
  left alone, and `/newchat` there leaves the web app alone.
- **`/secret set`** works as it does in your chat app. The message holding the
  key is never saved in the conversation history.
- A command the assistant does not know goes to the assistant as a normal
  message, as it does in your chat app.

## What the file panel hides, and why

The file panel never shows your assistant's working parts, data that covers
every chat on the box, or anything secret. It hides:

- **Program files and build output:** `src`, `scripts`, `tests`, `templates`,
  `deploy`, `public`, `dist`, `dist-installer`, `node_modules` and `coverage`.
- **Stores and operational data:** `store` (the database and saved keys),
  `logs`, `support-requests`, `certification`, and `workspaces` (shared
  workspace copies, which hold their own access keys).
- **Saved settings and keys:** anything whose name starts with a dot, such as
  `.env`, `.git` or `.claude`, plus `roles.json` and `key_pair.txt`.
- **Anything that looks like a credential:** names with `token`, `secret` or
  `credential` in them, key and certificate files (`.key`, `.pem` and the like),
  `id_rsa`-style keys, and database files.

These names are hidden wherever they appear, not only at the top. A hidden file
looks the same in the panel as a file that does not exist. The panel is the only
thing that hides them: your assistant itself still works with your whole
folder. Uploads land in `workspace/uploads/`; a file with the same name is kept
and the new one gets a number added. Anything sent with a chat message moves to
`workspace/uploads/chat/<conversation>/` and is deleted with the conversation.

## Hosted boxes

A hosted assistant only answers on the addresses its provider has opened. Ask
your provider to run this on the box, once:

```
sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname> --web
```

It opens `/app`, records the address, and needs a service restart. If the box
also uses the voice page or Teams, they must pass those flags in the same run
(`--voice`), because running it again rewrites the whole list of open addresses.
