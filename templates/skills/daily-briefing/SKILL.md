## Daily Briefing

{{OWNER_NAME}}'s start-of-day summary. Four sections, in this order: weather,
email, calendar, loose ends.

The point of a briefing is that it is shorter than the thing it summarises.
If {{OWNER_NAME}} has to read it twice, or scroll it on a phone, it failed.

### Where the data comes from

Use whatever email and calendar skill is installed here. Do not hardcode a
CLI in this file: the install may be on Gmail, Outlook, both, or neither, and
those skills carry the current commands. Read them, use them.

If no email skill is installed, skip the email section entirely rather than
apologising for it. Same for calendar. A briefing with two sections is fine;
a briefing that explains what it could not do is not.

### Weather

One line. High, low, and precipitation chance. Lead with it, and keep it to
that: nobody needs an hourly breakdown at 8am.

The location lives in the weather skill, which is installed here and holds the
coordinates and city name. Use it rather than asking or guessing.

### Email

**Never paste raw tool output.** Search results arrive as a table with IDs,
labels, and thread columns. That is a database row, not a briefing, and it is
unreadable on a phone. Read the results and write prose.

Split into two groups:

**Needs {{OWNER_NAME}}:** anything asking a question, waiting on a reply,
carrying a deadline, or from a person rather than a system. One line each:
who it is from and what they actually want.

> Sarah Chen wants the Q3 numbers before Thursday's board call.
> Your accountant is asking which of two filing options you want.

**Everything else:** one short paragraph for the lot. Group by kind, name the
senders worth naming, and say plainly when there is nothing in it.

> Six promotional emails (Shein, Tangerine, two airlines), a Google security
> alert for a sign-in you made yesterday, and a TD device-login notice.

Never list IDs, labels, or thread identifiers. If {{OWNER_NAME}} wants to act
on one, they will ask and you can look it up then.

Judge importance by who sent it and what it asks, not by whether it is unread.
Newsletters stay in the second group no matter how recent.

### Calendar

Today's events with times, in order. If the day is empty, say so in one line.
Flag anything that needs preparation or travel, and anything that starts
within an hour of the briefing landing.

### Loose ends

The section that makes this an assistant rather than a digest.

Look back over yesterday's conversation for things that were left open:
something {{OWNER_NAME}} said they would do, a question you asked that never
got answered, a decision that was deferred, a task that was started and not
finished. Two or three at most, and only real ones.

If yesterday was quiet, omit the section. Never pad it. An invented loose end
costs more trust than a missing one.

### Format

Short lines. A section header only where it earns one. No preamble, no
sign-off, no "here is your briefing" — just the briefing. Aim for something
readable in under thirty seconds.

### Scheduling it

When {{OWNER_NAME}} asks for this to run automatically, use the scheduler that
ships with this assistant. Do not write a cron entry, a launchd plist, a
systemd timer, or a scheduled task by hand, and do not use any scheduling tool
from the surrounding harness: those live outside the assistant, so
`/schedule list` cannot see them, `/schedule delete` cannot remove them, and
they are lost or orphaned on the next update.

```
node dist/src/schedule-cli.js create "Run my daily briefing" "0 8 * * *" "<chat_id>" --name "Daily Briefing"
```

- `<chat_id>` is `ALLOWED_CHAT_ID` from `.env`
- The prompt must contain the word "briefing" so this skill loads when it fires
- Timezone follows `TIMEZONE` in `.env`; pass `--tz` only to override it
- On a bundle install there may be no system `node`: use `./runtime/bin/node`
  (macOS and Linux) or `runtime\node.exe` (Windows)

Confirm afterwards by running `node dist/src/schedule-cli.js list` and telling
{{OWNER_NAME}} the time it will fire and the timezone it resolved to. If they
want a different hour, change the cron rather than creating a second task.
