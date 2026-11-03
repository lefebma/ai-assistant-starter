# Privacy filter: client names stay on this machine

When the privacy filter is on, the assistant swaps the names and companies on
your list, and every email address and phone number, for placeholders before
anything goes to the AI service. "Invoice Acme Corporation, cc
jane@acme.com" leaves the machine as "Invoice COMPANY_1, cc EMAIL_2". The
reply comes back with the real names put back in, here on the machine, so you
read normal text and the assistant's tools (email, calendar, files) act on the
real names.

The list that ties each placeholder to a real name is kept in this
assistant's own database and is never sent anywhere.

## Turning it on

- **One chat:** send `/private on` in that chat. `/private off` turns it off.
- **Every chat:** add `PRIVACY=on` to `.env` and restart. A chat cannot turn
  it off then.

A scheduled task follows the chat it reports to. Background upkeep that
belongs to no chat (memory, titles) is filtered whenever any chat has the
filter on, since what it reads may have come from that chat.

## The list

| Command | What it does |
|---|---|
| `/private` | Says whether it is on here, and how many names are on the list |
| `/private add Acme Corporation, Acme` | Adds a company, with "Acme" as another way it is written |
| `/private add person Jane Smith` | Adds a person (say `company` or `person` when the guess would be wrong) |
| `/private list` | Shows the list (main chat only) |
| `/private remove Acme Corporation` | Takes one off (main chat only) |

Names match whole words in any case, so "ACME corporation" and "Acme's"
match, but "Acmeville" does not. Accented names match however they are typed,
and straight or curly apostrophes and any dash count as the same. Each name
needs at least three characters and cannot contain a double quote or a
backslash.

Email addresses and phone numbers need no list: the first time one is about to
be sent, it is added by itself. Phone numbers are caught when written the
usual North American way (416-555-0199, (416) 555-0199, +1 416 555 0199) or
with a + country code (+44 20 7946 0958). Ten digits run together with no
separators (4165551234) are not caught, since they look like any other
number.

A reply only gets back the words its own request sent. If one chat only ever
says "Acme", replies there say "Acme", never the fuller name on the list, and
typing a placeholder like COMPANY_1 by hand does not reveal what it stands
for.

Only the main chat can show or shorten the list, because it holds every
chat's names.

## What it covers

- Everything the assistant sends to the AI: your messages, its instructions
  and memory, earlier turns, tool results (emails it read, files it opened),
  and the inputs of tools it calls.
- Both engines: Claude through Claude Code (a small local relay on
  127.0.0.1, see below) and the multi-provider engine (OpenAI, Gemini, a
  host in `AI_BASE_URL`).
- A model on this machine or your own network (an `AI_BASE_URL` on
  localhost or a private address) is not a public model, so nothing is
  swapped for it.

## What it does not cover

- **Names not on the list.** Only listed names, emails and phone numbers are
  swapped. A client the list does not know reaches the AI as written.
- **What the assistant's tools send elsewhere.** A tool that runs on this
  machine (sending an email, opening a web page, running a command) uses the
  real names, since that is its job. The AI service only ever sees
  placeholders.
- **Web search on the Claude engine** runs at the AI service, so it searches
  for the placeholder, not the real name, and may find less.
- **Voice.** While the filter is on, replies come as text even with voice
  replies on, since speaking them would send the real names to the voice
  service. Voice notes you send are still transcribed by the voice service
  as audio, and live voice calls send audio straight to it: neither is
  filtered.
- **Images and attached files** are sent as they are.

## How it works

The filter has two halves:

1. **On the way out**, each piece of text is matched against the list, longest
   names first, and every match is replaced with its placeholder
   (`PERSON_3`, `COMPANY_12`, `EMAIL_4`, `PHONE_5`, `NAME_6`). The number is
   the entry's number on the list and never changes, so a conversation stays
   consistent. A short note tells the AI to use placeholders as written and
   never ask for the real names.
2. **On the way back**, placeholders in the reply are swapped for the real
   names. A reply that streams in is restored as it streams, including a
   placeholder that arrives split in two.

For the Claude engine, Claude Code is pointed at a relay on 127.0.0.1 for the
length of a private turn. The relay masks each request, forwards it to
Anthropic (or to your own `ANTHROPIC_BASE_URL`), and restores the reply. It
refuses any request that is not from a running turn, and it refuses to send a
request it could not filter rather than send it unfiltered. On a hosted box
with egress enforced, the relay's exact address is added to the turn's allow
list.

The AI's private reasoning (thinking) is left exactly as the AI wrote it,
because the AI service checks it has not been changed. It is written with
placeholders, so it holds no names. Reasoning from before a name was added,
or from before the filter was turned on, can hold the real name: it is left
out of the request. In the middle of a step (the AI waiting on a tool) it
cannot be left out, so that one request is refused and the next message
starts fresh.

If Claude Code is set up to send its requests elsewhere (Bedrock, Vertex or
Foundry, or an `ANTHROPIC_BASE_URL` in its own settings files), it would not
go through the relay, so a private turn refuses to start instead. A settings
file it cannot read counts as one that might, and stops the turn too. On a
hosted box with egress enforced, a private turn's tools and Claude Code cannot
reach the AI service at all except through the relay.
