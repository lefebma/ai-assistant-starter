## Meeting Briefings and Travel Messages

Before a meeting with other people, the assistant can check recent mail with
the attendees and send the owner a short heads-up: which threads to read
first and anything the owner owes them. It stays quiet when there is nothing
useful to say.

For a meeting at a physical address, it can also send a travel message: the
place, how long it takes to get there and when to leave, plus anything in
the mail about parking, the room or someone running late. The trip starts at
the previous meeting when the owner comes straight from one in person, else
at the starting address they set. Without a maps source the message gives
the place only and says travel time is not available.

Both are off until the owner turns them on, and they are set here, in
conversation.

Every command is one line:

`node {{PROJECT_PATH}}/dist/scripts/proactive.js <command>`

Pass the command's reply back to the owner as it is. It is already written
for them.

### What the owner says, and what to run

| The owner says | Run |
|---|---|
| "brief me before my meetings", "turn on meeting briefings" | `on briefing` |
| "stop the meeting briefings" | `off briefing` |
| "turn off all the proactive messages", "stop messaging me about meetings" | `off` |
| "are meeting briefings on?", "what proactive messages do I get?" | `status` |
| "brief me an hour before" | `lead 60` |
| "tell me when to leave for meetings", "turn on travel messages" | `on travel` |
| "stop the travel messages" | `off travel` |
| "give me 20 minutes before I have to leave" | `buffer 20` |
| "I take transit", "I walk to meetings", "I drive" | `mode transit` (or `walk`, `drive`) |
| "I start from home, 12 Elm St, Toronto", "my office is at ..." | `from 12 Elm St, Toronto` |
| "forget my starting address" | `from off` |
| "quiet hours from 10 pm to 7 am", "don't message me before 8" | `quiet 22:00 07:00` (24-hour times; for "before 8" keep the current start and use `08:00` as the end) |
| "no quiet hours" | `quiet off` |
| "why didn't I get a briefing for ...?", "what did you decide for my meetings?" | `log` |

Quiet hours are one setting shared with email alerts: changing them here
changes them there too. Run `status` first when you need the current start.
The same settings are in the web app, under Settings, Proactive messages.

### Rules

- Turning messages on or off, changing the lead time or quiet hours is the
  owner's call. Do not change these settings unless they asked.
- Turning a kind on replies with which calendars and mailboxes it reads.
  Pass that on; it is how the owner knows what they agreed to.
- The starting address is personal. It stays on this assistant and is only
  sent to the maps source to work out a travel time. Never repeat it to
  anyone but the owner.
- Briefings and travel messages are read-only. Never reply to, send, accept, decline or change
  anything because of one. If the owner asks to act on a briefing, do it as a
  normal request, with the usual approval for anything that sends.
