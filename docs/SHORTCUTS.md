# Apple Shortcuts

Ask your assistant from Siri, the Action Button, a home screen icon, the Share
Sheet, or an Apple Watch, without installing an app. Card #152.

## For the owner

Send `/shortcut` in your chat. Four messages come back:

1. a file called **Ask Havn**
2. the setup steps
3. an address (starts with `https`, or `http` on a box with no public address)
4. a key (starts with `Bearer hvs_`)

On your iPhone, open the file and tap **Add Shortcut**. It asks two questions:
paste the key first, then the address. Then say "Hey Siri, Ask Havn".

- Answers that take longer than about 20 seconds come to your chat instead.
  The iPhone stops waiting at around 25 seconds and cannot be told to wait
  longer, so the shortcut says "Still working on that" and the answer follows
  in the chat.
- A reply with a file, or one that needs your approval, also goes to the chat.
  The shortcut tells you so.
- It is the same conversation as your chat. Ask from the car, continue at
  your desk.
- If you are in the middle of something in the chat, the shortcut says so
  rather than talking over it. Try again in a minute.

`/shortcut status` says when the key was made and last used. `/shortcut revoke`
turns it off. `/shortcut` again replaces it, which also turns off the old one,
so a lost phone is one command away from locked out.

Delete the key message from your chat once the shortcut works.

### If the file will not open

Build it by hand in the Shortcuts app. Name it "Ask Havn" (that name is what
you say to Siri), then add:

1. **Ask for Input**. Prompt: What do you need?
2. **Get Contents of URL**. URL: your address. Show more: Method `POST`.
   Headers: `Authorization`, set to the whole key line including `Bearer`.
   Request Body: `JSON`, with a Text field named `text` set to *Provided Input*.
3. **Show Result**, showing *Contents of URL*.

## For the operator

### The endpoint

`POST /api/shortcut`

- `Authorization: Bearer hvs_...`, a per-chat key minted by `/shortcut`. The
  box token and voice links are not accepted here, and this key is accepted
  nowhere else.
- Body: JSON `{"text": "..."}`, or the question as a plain-text body. 64 KB
  and 8000 characters at most.
- Answers in `text/plain`, which Show Result displays and Siri reads aloud
  without a parsing step.

| Status | Meaning |
|---|---|
| 200 | The answer |
| 202 | Still working; the answer will arrive in the chat |
| 400 | Empty question, or a JSON body with no `text` |
| 401 | Unknown or revoked key |
| 403 | The key's chat no longer has access |
| 409 | That chat is already running a turn |
| 413 | Too long |
| 500 | The turn failed while the phone was waiting |

Every body is a sentence a person can act on, because Show Result shows it.

`SHORTCUT_WAIT_SECONDS` (default 20) is how long the request is held before
the 202. Keep it under 25; past that the iPhone gives up first and shows an
error instead of the handoff line. If the phone does hang up early, the answer
still goes to the chat.

### Keys

One per chat, in `store/` as a SHA-256 hash (`shortcut_tokens`). They do not
expire: a Shortcut that stops working overnight is not one anyone keeps.
Removing a chat with `/authorize remove` kills its key, because access is
checked on every request.

### Reaching it

A hosted box needs `/api/shortcut` on its edge. New edges get it. An existing
one has to be regenerated once:

    sudo node dist/scripts/hosted/enable-teams.js <hostname> [--voice]

(keep `--voice` if the box had it). The edge holds a question for up to 10
seconds across a restart rather than failing it.

A box with no public address (a Mac at home) gives its LAN address instead,
and the shortcut works while the phone is on the same Wi-Fi.

### Rebuilding the shortcut file

`templates/shortcuts/Ask Havn.shortcut` is generic: no address, no key. It
uses import questions to ask for both. Rebuild and re-sign on a Mac:

    python3 scripts/shortcuts/build-ask-shortcut.py /tmp/ask.shortcut
    shortcuts sign --mode anyone --input /tmp/ask.shortcut \
      --output "templates/shortcuts/Ask Havn.shortcut"

The signature carries an Apple-issued certificate identified by an opaque
hash, not the signer's name or Apple ID. The current one was signed
2026-10-02 and its certificate runs to 2027-10-28; re-sign before then.
