# Minimal setup: the profile moves into the first chat (card #210)

Status: draft, 2026-10-20.

## Intent

An owner should be able to get an assistant running by answering two things: how they message it, and how it reaches an AI model. Everything about who they are is something the assistant can ask itself, in plain conversation, in the first chat.

v1.34.0 got most of the way. The web setup asks only Telegram and AI access as required steps, skips email and optional keys, and the assistant offers the discovery interview after its hello. Two pieces are left (Marc's comment on the card, 2026-10-13):

1. The web page still asks the profile up front: owner name, assistant name, city and timezone, tone, and a line about their work.
2. `npm run setup` still runs the full terminal wizard.

Marc decided on 2026-10-20 that the profile moves into the first chat, rather than keeping a short profile step on the page.

The why: every question before the first hello is a place a non-technical owner can stall. A conversation is where the assistant is at its best, and it can explain why it asks.

## Who it is for

- New Havn owners, on hosted boxes (web setup link) and self-installs (installer opens the web setup).
- Operators (Marc) running `npm run setup` on a box.
- Not existing installs. They already have a profile, and nothing here changes their files.

## Goals

1. A fresh install with only the core answers starts and greets the owner in chat.
2. The welcome conversation produces the same files the setup writes today: PERSONALITY.md, the CLAUDE.md identity lines, PROFILE.md's stub, the skill files that carry the owner's name, the weather location, and TIMEZONE in .env.
3. No question asks for coordinates, and no optional key is asked for up front.
4. `npm run setup` keeps working for operators, and asks only the core by default.

## Non-goals

- No /connect command (#201). Email connection stays where it is today.
- No new way to install optional skills from chat. That gap already exists for web installs and is a separate card.
- No change to the discovery interview itself (exec-interview). It still writes the full PROFILE.md.

## Anti-goals

- An owner who just wants to ask a question gets interrogated first. The assistant answers what was asked, then asks.
- The welcome feels like a form read aloud. It is a few short questions, conversational, and it can be done in one reply.
- An existing install's CLAUDE.md, PERSONALITY.md or skills change because of this release.
- The assistant asks for latitude, longitude or a timezone name.

## What setup asks now

**Web setup:** connect Telegram (token and pairing, as today), then AI access (subscription sign-in or API key, as today), then Finish. The profile section of the page goes away.

The timezone is still captured, silently: the page already reads the browser's timezone, and it is sent with Finish as a provisional value, never shown as a question. On a hosted box the browser is the owner's, so it is usually right. The first chat corrects it from the city.

**Terminal wizard (`npm run setup`):** messaging platform and its credentials, then AI access. The provisional timezone is this machine's. Then the existing operational steps (build, browser tools, background service, model check) stay as they are, because they are about the box, not the owner.

## Defaults before the first chat (Umi's calls)

Until the welcome conversation, files render with provisional values:

- **Owner name:** the first word of the name on the owner's Telegram account, which the web setup already sees during pairing. The terminal path uses "the owner", and so does a Telegram name that fails the existing name validation (for example, one containing quotation marks). The web setup is Telegram-only.
- **Assistant name:** the bot's display name from BotFather, which the web setup already reads. The terminal path calls Telegram's getMe when a token is given, and otherwise uses "Atlas" (the wizard's existing default).
- **Tone:** the "Warm but efficient" preset (the web page's current default).
- **Bio:** empty.
- **City:** empty, with the weather skill on the wizard's existing fallback coordinates until the first chat.

These are guesses the first chat confirms, never facts it assumes. For example: "I'll call you Marc, and you can call me Nami. Change either if you like."

## The first chat

The bot knows the profile is pending from a flag set by setup (see Records below). While it is pending:

- **Startup greeting.** It replaces today's interview greeting. It says the assistant is running, and asks the welcome questions in one short message:
  - what to call the owner (confirming the Telegram name);
  - what the owner wants to call the assistant (confirming the bot's name);
  - which city they are in;
  - how it should talk (the three presets in plain words, or their own description);
  - a line about their work.

  It also says they can answer in one go, or skip it.
- **The first three inbound turns in the primary chat while pending** carry a short instruction to the assistant:
  - Answer what was asked first.
  - Collect whatever is still missing, without repeating questions already answered.
  - Once the owner has answered, or has said to skip, run the profile command.

  The turn count lives in app_state. If the third turn ends with the flag still set, the bot runs `skip` itself, keeping the provisional values. An assistant that keeps asking is worse than one with a guessed name, and "call me Jim" still works later. Other authorised chats and groups never see the instruction.
- **The interview offer waits.** Today's interview greeting and nudge are suppressed while the profile is pending, on both the startup path and the first-turn path.
- **The profile command** is a CLI the assistant runs, like the other owner commands: `node dist/scripts/profile.js set` with name, assistant name, city, tone and bio. A `skip` subcommand keeps the provisional values and clears the flag.
- **After the profile is set,** the existing interview offer runs exactly as it does today: once, folded into the next reply. The two never appear in the same message.

On Teams, the startup greeting cannot be sent to a fresh install, and today's interview offer has the same limitation. The pending instruction on the first inbound turn covers it.

## What the profile command does

1. **City.** It looks up the city with Open-Meteo's geocoding, the service the weather skill already calls; only the city name is sent. That one lookup gives coordinates, the temperature unit, and the city's IANA timezone. If the lookup fails, the city is kept as typed, coordinates stay on the fallback, and the timezone stays provisional. The assistant says so in one line and does not ask for coordinates.
2. **Re-render.** It re-renders the profile-bearing files from the saved setup answers, with the new profile merged in. It uses the setup plan's own builders, filtered to the steps that carry the profile, so it cannot drift from what setup writes. It never runs the plan's secret steps.
   - **CLAUDE.md** is rendered again from the template. Setup re-runs already rebuild it, so this changes nothing about who owns it.
   - **The weather skill** is copied from its template again and filled in with the city's coordinates, unit and timezone.
   - **PERSONALITY.md, PROFILE.md and decisions/log.md** are normally written only when missing. Here each one is replaced only if it is byte-identical to what setup rendered from the provisional values. The check re-renders that provisional version and compares. A file that differs is left alone, and the output names it, so the assistant can say "I kept your edited personality file."
   - **The other skills that carry the owner's name** (decision-log, exec-interview, browse, imap-mail, daily-briefing, and any optional skills setup installed) are re-copied from their templates and filled in again. This happens only while the pending flag is set: the box is fresh and nobody has edited them. A later `set` leaves them alone.
3. **Timezone.** When the city gives a different timezone, it updates TIMEZONE in .env. It also records a "restart after this reply" request. The bot checks for that request after it has delivered the reply, then restarts through the existing restart path and notice. A confirmation is never cut off mid-send.
4. **Flag.** It clears the pending flag and prints a one-line confirmation for the assistant to relay.

Running `set` again later gives "change my city" or "call me Jim" a real path: it updates CLAUDE.md, the weather skill and the timezone. Once the flag is clear, it never replaces an owner-edited file and never re-copies skills.

## Records

- **`store/setup-answers.json`** holds the non-secret setup answers, so the profile command and a terminal re-run can reproduce the same files. It is written by both setup paths. Keys and tokens are stripped; they live in the vault and .env as today.
- **The pending flag** is a field in that file, so a box without the file (any existing install) is never pending.
- The web setup cannot run twice: it already refuses once a .env exists. So the only re-run is the terminal one, covered below.

## Terminal re-runs and operators

- On a box that has `store/setup-answers.json`, `npm run setup` asks only the core. It keeps the saved profile and does not reset it to provisional values.
- On an existing install without the file (anything set up before this release), the wizard asks the profile questions in the terminal as before. Re-running setup on an old box therefore never blanks its owner's name.
- **Email** (Umi's call): #201 /connect does not exist yet, and today the terminal wizard is the only way an operator installs the Gmail or Outlook skill. It stays, behind one "Connect email now?" question that defaults to no.
- **Optional skills and the voice key** (Umi's call): these sit behind one "Set up optional skills now?" question that defaults to no, with the existing questions inside it. No key is asked unless the operator opts in. This keeps the operator's only install path for those skills until there is a chat path.
- **Monthly audit:** off by default, as in the web setup. `/audit monthly on` turns it on.
- The email signature questions go; the signature is built from the owner's name, as the web setup does. The latitude and longitude questions go; the coordinates come from the city.

## Hosted provisioning

Hosted boxes reach setup through the web setup link (#147), so they get the same flow. Nothing in cloud-init asks for a profile.

## Success

- A fresh web setup is two steps and Finish, and the owner's first chat ends with the same files a full wizard run would have written.
- The acceptance criteria on the card hold:
  - A fresh install with only the two core answers starts and greets the owner in chat.
  - The welcome conversation produces the same profile and personality files as today's wizard.
  - No question asks for coordinates, and no optional key is asked for up front.

## Decided by Marc

- Minimal setup: only messaging and AI access up front (card #210).
- The profile moves into the first chat (2026-10-20).

## Calls made by Umi (open to change)

- Provisional names come from Telegram (the owner's first name and the bot's name), and the first chat confirms them.
- The timezone is captured silently from the browser or the machine, then corrected from the city in the first chat.
- The welcome questions go in one message, and the owner can skip them.
- The interview offer follows the welcome and is never combined with it.
- The welcome instruction rides at most three turns in the primary chat, then it auto-skips with the provisional values.
- Name-bearing skills are re-copied only on the first `set`. Edited personality and profile files are never replaced.
- A timezone restart waits until the reply has been delivered.
- The profile command re-renders through the existing setup plan, using saved non-secret answers.
- PERSONALITY.md and PROFILE.md are replaced only while they are unedited.
- A timezone change triggers a restart through the existing restart path.
- Old installs without saved answers keep the full profile questions on a terminal re-run.
- In the terminal wizard, email and optional skills stay behind one default-no question each, until #201 and a chat skill-install path exist.

## Left to the builder

- The flag's exact field name, and the CLI's flag names and output wording.
- How the pending instruction and the greeting are worded, within the rules above.
- How "still matches what setup rendered" is checked, for example by re-rendering the provisional version and comparing, or by a marker.
- Test layout.
