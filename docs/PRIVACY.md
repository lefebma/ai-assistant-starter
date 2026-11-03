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
match, but "Acmeville" does not. Each name needs at least three characters.
Email addresses and phone numbers need no list: the first time one is about to
be sent, it is added by itself.

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
- **What tools send elsewhere.** A web search or a web page the assistant
  opens uses the real words, since the tool runs on this machine with the
  real names. The AI service only ever sees placeholders.
- **Voice calls.** Umi Live style voice calls send audio straight to the voice
  service and are not filtered.
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

The AI's private reasoning (thinking) is left exactly as the AI wrote it, with
placeholders in it, because the AI service checks it has not been changed.
