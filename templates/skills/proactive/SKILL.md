## Meeting Briefings

Before a meeting with other people, the assistant can check recent mail with
the attendees and send the owner a short heads-up: which threads to read
first and anything the owner owes them. It stays quiet when there is nothing
useful to say. It is off until the owner turns it on, and it is set here, in
conversation.

Every command is one line:

`node {{PROJECT_PATH}}/dist/scripts/proactive.js <command>`

Pass the command's reply back to the owner as it is. It is already written
for them.

### What the owner says, and what to run

| The owner says | Run |
|---|---|
| "brief me before my meetings", "turn on meeting briefings" | `on` |
| "stop the meeting briefings" | `off` |
| "are meeting briefings on?" | `status` |
| "brief me an hour before" | `lead 60` |
| "why didn't I get a briefing for ...?", "what did you decide for my meetings?" | `log` |

### Rules

- Turning briefings on or off, or changing the lead time, is the owner's
  call. Do not change these settings unless they asked.
- Briefings are read-only. Never reply to, send, accept, decline or change
  anything because of one. If the owner asks to act on a briefing, do it as a
  normal request, with the usual approval for anything that sends.
