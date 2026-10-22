## Email Alerts

The owner can get a short chat message when an email arrives that cannot wait
until tomorrow. Everything about it is set here, in conversation. The owner
never edits a file.

Every command is one line:

`node {{PROJECT_PATH}}/dist/scripts/email-alerts.js <command>`

Pass the command's reply back to the owner as it is. It is already written
for them.

### What the owner says, and what to run

| The owner says | Run |
|---|---|
| "turn on email alerts" | `on` |
| "turn off email alerts" | `off` |
| "email alert status", "are my alerts on?" | `status` |
| "pause my email alerts for an hour" | `pause 1h` |
| "pause my email alerts until tomorrow morning" | `pause tomorrow` |
| "pause my email alerts for a day" / "for a week" | `pause 1d` / `pause 1w` |
| "pause my email alerts until I say so" | `pause off` |
| "pause my email alerts for ..." (anything else) | `pause until <ISO time>` |
| "resume my email alerts", "unpause alerts" | `resume` |
| "always tell me when ... writes" | `vip add <address or domain>` |
| "stop treating ... as a VIP" | `vip remove <address or domain>` |
| "who are my VIPs?" | `vip list` |
| "stop alerting me about ..." | `mute add <address or domain>` |
| "unmute ..." | `mute remove <address or domain>` |
| "who have I muted?" | `mute list` |
| "quiet hours from 10 pm to 7 am" | `quiet 22:00 07:00` |
| "what would have alerted this week?" | `replay 7` |

### Loose durations

Map anything that is not exactly 1h, tomorrow, 1d, 1w or off to an exact time
and use `pause until <ISO time>`, with the owner's timezone offset in it. For
example, "this afternoon" means until about 5:00 pm today, "until Monday"
means Monday at the end of quiet hours. Check the current date and time with
`date` first. A pause can be at most 30 days.

### Addresses and domains

"Anyone at acme.com" is `acme.com`. A person is their full address,
`jane@acme.com`. If the owner gives only a name, ask for the address or look
it up in their mail first. Never guess.

### Rules

- Do not explain how alerts work, how emails are judged, or what happens
  behind the scenes. Answer with the command's reply and nothing more. If the
  owner asks how it works, say it messages them when something cannot wait,
  and leave it there.
- Replay never sends anything and can look back at most 14 days. Run it only
  when the owner asks. It reads each email again and can take several
  minutes, so give the command a long timeout (10 minutes).
- Turning alerts on, off, or pausing them is the owner's call. Do not change
  these settings unless they asked.
