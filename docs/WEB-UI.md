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
  voice), and your signed-in browsers. When a new version is waiting, a small
  download icon shows next to the Settings link; click it to see the update
  in Settings. It stays until the update is installed, even if you dismiss
  the banner.

### Sending while it is still answering

You can keep typing while the assistant is still writing a reply. Press Send
and your message waits its turn: it shows in the chat marked Queued, and runs
as soon as the reply before it is done. Send several and they run in the
order you sent them.

- **Edit or Remove** sit under each waiting message. Once it has started it
  can no longer be changed. A waiting message cannot be edited into `/cancel`,
  `/steer`, `/secret` or a key; send those as a new message.
- **Stop** ends the reply in progress only. The waiting messages stay and the
  next one starts. If the reply had already finished when you pressed it, Stop
  leaves the next message alone and the page catches up; press it again to
  stop that one.
- **`/cancel`** stops everything in the chat: the reply in progress, every
  waiting message in any of your chats, and scheduled runs.
- **Commands and buttons** wait their turn like any message, except `/cancel`
  and `/steer`, which act straight away.
- **`/secret`** always runs straight away, and so does the key a `/secret set`
  is waiting for. A key is never put in the queue, and a message that was
  already waiting is never mistaken for the key.
- **`/support`** works the same way. The description it asks for, and a typed
  Send, Edit or Discard on its draft, run straight away. A message that was
  already waiting is never taken as the description or as your answer to the
  draft; it goes to the assistant as an ordinary message.
- **Reloading the page** loses nothing. The waiting messages are kept on the
  box, the page picks up the reply where it is, and a message is never sent
  twice. If you hit the AI limit, the waiting messages hold until you open
  the chat again or send something.

### Talking instead of typing

The microphone next to Send lets you dictate a message. Tap it, speak, and
tap it again (or press Send). The words land in the message box where your
cursor was, after anything you already typed, so you can read and fix them
before you send. Nothing is sent until you press Send yourself.

- **While it listens** the microphone turns red and pulses, with a timer
  beside it. It stops by itself at two minutes, keeping what it heard.
- **Who turns speech into text.** If your box can transcribe voice notes
  (it has an OpenAI key, and is not on a managed AI key), the recording goes
  to the box, which sends it to OpenAI for the words and then deletes it. The
  recording is never kept and never becomes part of the conversation.
  Otherwise your browser's own speech recognition does it, and the words
  show as you speak. That can send your voice to your browser's maker (Apple
  or Google, for example).
- **No microphone button?** Your browser offers neither way, or the page was
  opened over plain `http://` on your network (browsers only allow the
  microphone on secure pages). Use the secure link from `/app`.
- **The first time**, your browser asks to use the microphone. If you said
  no, the page tells you how to turn it back on.
- It works while the assistant is still answering. What you send waits its
  turn as usual.

### Talking with your assistant (voice chat)

The waveform button beside the microphone starts a live voice call inside the
chat you have open. You talk, your assistant talks back, you can interrupt it,
and it keeps talking while it looks things up. It is the same live
conversation as `/voice/live` (see the setup guide), without a separate link:
the web app's sign-in is enough.

- **While a call is on** a red bar above the message box shows a running
  clock, Mute and End call. The waveform turns red too; tapping it again also
  ends the call. What you both say shows in the chat as you go.
- **When the call ends** what was said is added to the chat, each line marked
  Voice call, so the conversation reads in order. The next message you type
  in that chat is told what was said on the call. Longer answers (a list, a
  draft) that the assistant puts in the chat during the call appear in place.
  The call is also saved under Calls on the live voice page.
- **Cost.** Calls are billed by the second to the box's OpenAI account (about
  $0.05 a minute, plus the thinking). A call ends when you press End, open
  another chat, delete the chat, close or reload the page, or after five
  minutes in which nobody speaks. Each call is capped at 45 minutes, and at
  most two can run on a box at once.
- **Typing still works** during a call, and messages wait their turn as
  usual. Dictation is off while a call has the microphone.
- **No waveform button?** The box has no OpenAI key, or uses a managed AI
  key. A dimmed button means this browser cannot make calls, or the page was
  opened over plain `http://`; tapping it says which.
- **The first time**, your browser asks to use the microphone. On a laptop,
  headphones stop the assistant hearing itself.

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
