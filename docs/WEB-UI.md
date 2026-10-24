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
- **Settings.** What is connected (AI provider, Telegram, mail and calendar,
  voice), and your signed-in browsers.

### Model and effort

Each conversation has two pickers at the top.

- **Model.** Which AI answers: Default, or a smaller and faster one, or the
  most capable.
- **Effort.** How hard it thinks before answering: Low is quick, High takes
  longer and goes deeper. Default leaves it to the assistant.

## What the file panel hides, and why

The file panel never shows your assistant's working parts or anything secret:
the program files, the stores and logs, saved settings and keys (anything
starting with a dot, such as `.env`), and any file that looks like a credential.
A hidden file looks the same as a file that does not exist, and the assistant
will not send those files either. Uploads land in `workspace/uploads/`; a file
with the same name is kept and the new one gets a number added.

## Hosted boxes

A hosted assistant only answers on the addresses its provider has opened. Ask
your provider to run this on the box, once:

```
sudo node /home/havn/havn/dist/scripts/hosted/enable-teams.js <hostname> --web
```

It opens `/app`, records the address, and needs a service restart. If the box
also uses the voice page or Teams, they must pass those flags in the same run
(`--voice`), because running it again rewrites the whole list of open addresses.
