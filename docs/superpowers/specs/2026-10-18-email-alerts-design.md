# Email alerts for Havn (card #179, Havn half)

Status: approved by Marc, 2026-10-18.

## Intent

A Havn owner should hear about an email that can't wait, without living in their inbox. The box watches the owner's connected mailboxes and sends one short chat message when something critical arrives. Everything else stays in the inbox until the owner gets to it.

Umi has had this since early October (ClaudeClaw `src/email-alerts/`). Umi's version depends on Jev scoring and the Priority Mail cache, and Havn has neither, so Havn gets its own trigger: a VIP list plus a quick read by a low-cost Claude model. That split was agreed on the card on 2026-10-07.

The why, in the owner's terms: a client problem, a deadline or a same-day change that sits unread for four hours costs real money. A tool that pings about everything gets switched off. The whole design rests on alerting rarely and being right when it does.

## Who it is for

- Leif (havn-leif) and Joy (havn-marina), the hosted pilot users.
- Walid, on his self-installed Havn (ELS Partners, Microsoft 365 mail). He picks it up through the normal update on his own box.
- havn-test, Marc's staging box, where it is proven first.

## Goals

1. Alert on critical email within about 10 minutes of arrival, on the channel the owner already uses (Telegram or Teams, and Slack where an adapter is configured).
2. Keep false alarms rare enough that owners leave it on.
3. Give the owner simple control: VIPs, mutes, quiet hours, and a pause for a set time.
4. Give Marc enough data to judge the soak.

## Non-goals

- No "important, due soon" path. Umi has an "important + action needed + due within N days" rule. Havn drops it on purpose (Marc, 2026-10-18), because owners catch those on a normal inbox check and it is the main source of noise.
- No IMAP-only mailboxes in this version. Gmail and Outlook only.
- No replying, archiving or drafting from an alert. It points at the email, nothing more.
- No change to Umi's own email alerts.

## Anti-goals (a failure even if it technically works)

- More than about 2 alerts on a normal day for a typical owner.
- Any newsletter, receipt, notification or other automated mail getting through.
- An owner pausing it "until turned back on" in the first week.
- Any explanation of how it works shown to the owner. Alerts read like a colleague's tap on the shoulder.

## What triggers an alert

Rules, in order:

1. **Mute list.** A muted sender (address or domain) never alerts. This overrides everything.
2. **VIP list.** Mail from a VIP (address or domain) always alerts, and VIPs come through quiet hours.
3. **Triage.** New mail from a real person (not automated, bulk or a mailing list) is read by a low-cost Claude model, which decides whether it is critical.

**Critical** (Marc, 2026-10-18) means real harm if it waits until tomorrow, for example:
- a client reporting a problem, or signalling they may leave;
- a payment, legal or government deadline in the next day or two;
- a same-day meeting change;
- a real person directly asking for something today.

Not critical: FYIs, normal back-and-forth, sales pitches, receipts, anything automated, and requests with a deadline more than a couple of days out.

VIP mail always counts as critical, including for the pause summary.

The model sees the sender, the subject and the start of the body only, and returns a yes/no plus a one-line reason. If the model is down, slow or errors, that email does not alert (it fails quiet) and the failure is logged. The VIP rule needs no model and still works.

## What an alert looks like

One message per email: the sender, the subject, and one plain line on why it matters. The buttons are:

- **Useful**
- **Not urgent**
- **Mute sender**
- **Pause alerts**

Mute sender asks no follow-up question. It mutes, confirms in one line, and offers an undo.

Pause alerts offers these durations:
- 1 hour
- until tomorrow morning
- 1 day
- 1 week
- until turned back on

If more than 5 alerts are due at once, the box sends the 5 most recent and adds one line saying how many more there were.

Alert buttons stay usable after a click: an owner can tap Useful and later Mute sender or Pause on the same alert. Each action works once per alert. Alert clicks are routed to the alert handler before the shared one-click-per-message claim (Umi's call).

## Pause

- The owner can pause from the button on any alert, or by saying it in chat ("pause my email alerts for the afternoon"). The chat path maps to the nearest duration or an exact end time.
- While paused, nothing is sent, VIPs included. Mail is still checked, and the box still records which emails would have alerted.
- When the pause ends, it sends a header message, "Email alerts are back on," with the count of critical emails that arrived during the pause (Marc, 2026-10-18). Then it sends one message per critical email, with the same sender, subject, reason and buttons, so feedback still works. Only the 5 most recent are sent, and the header says how many more came in (Marc, 2026-10-18). Anything less than critical is left out. If there were none, the header says so in one line.
- "Until turned back on" ends only when the owner turns it back on, and the same summary follows.
- A pause survives a restart or an update.

## Quiet hours

These follow the box's timezone, 22:00 to 07:00 by default, and the owner can change them in chat. Critical non-VIP mail that arrives overnight is held and sent at the end of quiet hours, in the same format as the pause summary (a header, then one message per email). VIPs come through. If a pause and quiet hours overlap, the pause wins.

## Setup and control

- Off by default. It is turned on during onboarding or by asking ("turn on email alerts").
- The VIP and mute lists are managed in conversation ("always tell me when anyone at acme.com writes"). The owner never edits a file.
- It watches every Gmail and Outlook mailbox the box already has connected. If a mailbox's connection lacks mail-read access, the status command says so in plain words.
- A status command shows:
  - on or off;
  - the pause and when it ends;
  - quiet hours;
  - the VIP and mute counts;
  - alerts sent in the last 7 days, and how many were marked Useful or Not urgent.
- A replay command shows what would have alerted over the last N days without sending anything. It re-fetches that mail and re-runs triage with the current rules, outside the at-most-once rule and the daily cap, so it can be used to tune the critical line. It is used on havn-test, and Marc can run it for an owner. It is capped at 14 days (Umi's call).

## Cost guard

- A daily cap of 300 emails triaged by the model (Marc, 2026-10-18). It is a safety net against floods, bugs that re-read the same mail, and burning the owner's subscription limit, not a budget. A real day sits far below it.
- Past the cap, only VIP rules apply until the next day, and the status command shows that the cap was hit.
- Each email is triaged at most once.

## Records and privacy

- A per-alert record is kept on the box only: mailbox, message id, sender, subject, reason, VIP or not, sent/held/paused, timestamps, and the owner's button feedback. Message bodies are never stored.
- Each check that did anything writes one log line with counts only (no subjects, no senders), consistent with the box's log redaction.
- Email content already reaches Claude when the owner asks about their mail, so triage adds no new place where the data goes.

## Rollout and success

1. Ship in the next starter minor release (1.39.0).
2. Turn it on for havn-test with Marc's test inboxes, and run a replay over recent mail to check the critical line.
3. Move the card to Verify for a two-week soak on havn-test.
4. Turn it on for Leif and Joy, and make it available to Walid, only after Marc's OK. Updates go through `applyUpdate()` as usual.

Success means Leif and Joy keep it on through the soak (Marc, 2026-10-18). Useful and Not urgent counts are supporting data, not the bar.

## Decided by Marc

- The trigger is VIP plus model triage over Gmail and Outlook (2026-10-07).
- The definition of critical, with no "due soon" path.
- A pause with set durations, from a button or by chat.
- When a pause ends, a summary of the critical emails that arrived during it: the 5 most recent, plus a count of the rest.
- Success is judged by whether Leif and Joy keep it on.
- Walid gets the release too.

## Calls made by Umi (open to change)

- VIPs come through quiet hours but not a pause.
- Off by default, and enabled in conversation.
- No IMAP in this version.
- Delivery within about 10 minutes and a 5-alert cap per check.
- On first run, existing mail is marked as seen and nothing alerts. Past mail is only looked at through replay.
- Pause and quiet-hours summaries are a header plus one message per email, so each keeps its buttons.
- Alert buttons allow several different actions per alert, each once.
- Replay re-runs triage on re-fetched mail, outside the cap.
- Triage reads only the sender, the subject and the start of the body, and fails quiet when the model is unavailable.
- VIP-only behaviour past the daily cap.
- Records stay on the box, with no bodies, and log lines carry counts only.
- Pause is the fourth button on every alert.

## Left to the builder

- How new mail is detected per provider: polling with Gmail history or Graph delta, or a simple time window plus a seen-message table.
- How the cheap model is called. The agent runtime has no per-call model option today, so the builder decides whether to add one or call the model directly. Either way, the API key or subscription the box already has must be reused.
- How the "real person" filter works (headers, list-unsubscribe, no-reply patterns), and the triage prompt itself.
- How alert button clicks are routed to the alert handler instead of the chat agent, on Telegram, Teams and Slack.
- Table names, file layout, the command names, and tests.
