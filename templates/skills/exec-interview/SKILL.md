## Business Discovery Interview

A guided conversation that teaches you who {{OWNER_NAME}} is, what they are
accountable for, what matters right now, and how they want to be worked with.
Run it once shortly after install, then keep learning through the actual work.

The output is `{{PROJECT_PATH}}/PROFILE.md`, which CLAUDE.md imports, so
everything learned here is in front of you on every future turn. Nothing else
in this skill matters if that file does not get written.

Budget 15 to 20 minutes. That is the deal you are offering, so keep it.

### Before you start

Read `PROFILE.md` if it exists.

- **No file, or the placeholder stub** (the stub carries a `havn:profile-stub`
  marker on its first line): this is the first run. Say what the next 15 to 20
  minutes are for, that answers can come in chunks or as voice notes, and that
  they can stop at any point and pick up later.
- **A real profile already there:** do not start over. Say what you already
  know in three or four lines, and ask what has changed. Then work only the
  sections that moved.

Say this much and then ask the first question. Do not paste the whole question
list into the chat. Twenty-eight numbered questions in one message is a form,
and people abandon forms.

### How to run it

**Ask one section at a time.** Two or three questions per message, maximum.
Wait for the answer before moving on.

**Follow up instead of advancing.** The questions below are the frame, not a
script. The value is in the second question, the one the frame does not
contain:

> "My biggest priority is closing three new clients."
> -> "Which three? And what is stopping each one from closing today?"

> "I spend about five hours a week preparing reports."
> -> "Which reports, for whom, and where does the data come from?"

**Skip what does not apply.** A solo consultant does not need the team layer.
Someone who already told you their priorities in section 4 does not get asked
again in section 5. Cutting half the questions because you already have the
answers is the skill working, not the skill failing.

**Do not interrogate.** If an answer is thin and the person seems done with a
topic, take what you have and move on. You will learn the rest by working.

**Capture as you go.** Keep notes in your head or in a scratch file, but do not
narrate the note-taking.

### The questions

**1. Their business**
- In simple words, what does the company do, and who are its customers?
- What are the main products or services?
- How does the company make money?

**2. Their role and responsibilities**
- What is their role?
- What are their main responsibilities?
- What are they personally accountable for, and what results are they expected
  to deliver?
- What decisions do they make regularly?

Two people with the same title can have completely different jobs. The title is
the least useful thing here; the accountabilities are the most useful.

**3. Their people**
- Who are the most important people you should know? Team, clients, partners,
  anyone whose name will come up.
- Are there people or situations that should always get priority attention?

Do not ask for a complete directory. Five to ten names with context beats fifty
names without it, and you will learn the rest from their inbox and calendar.

**4. Their priorities**
- Top three priorities for the next 90 days?
- Which projects or initiatives matter most right now?
- What are they worried might fall through the cracks?

This is what lets you tell an important email from a loud one.

**5. How they work**
- Walk me through a typical week. What takes most of the time?
- Where do they lose the most time or energy?
- What do they repeat over and over?

**6. What they want you to own**
- If you could take three responsibilities off their plate starting tomorrow,
  which three?
- What do they wish an assistant would notice and handle without being asked?

These two questions are the most valuable in the interview. People rarely know
which automations they want. They always know what they are sick of doing.

**7. How to work with them**
- Quick answer first, or the full reasoning?
- Should you challenge their thinking and make recommendations, or mainly
  follow direction?
- When there are options, pick the best one or lay out the choices?
- What should you always ask permission before doing?

Whatever they say here becomes a rule you follow, not a preference you note.

**8. Their systems**
- What tools do they use every day? Email, calendar, CRM, chat, project
  tracking, documents.
- Which systems would be most valuable for you to work with directly?

If they name something that has a skill available here, say so and offer to set
it up after the interview. Do not derail the interview to do it now.

**9. Success**
- "Imagine we have worked together for 30 days. What would I need to have done
  for you to say you do not want to work without this assistant anymore?"

Ask this one exactly. It gets a far better answer than asking whether it was
worth it.

### If more than one person will use this install

Ask these only when the answer to "is anyone else going to use me" is yes:

- Who else will use the assistant, and in what roles?
- What should be shared across the organization, and what stays private to each
  person?
- Should you behave differently depending on who is talking to you?
- Are there company-wide rules, approvals, or boundaries you have to follow?

### Closing

When the sections are done, summarize what you learned. Not a transcript: the
picture. Their business, their role, the people, the priorities, the working
agreement. Ten to fifteen lines.

Then ask them to correct anything wrong. Fix it. Do not defend a summary.

Once they approve, write the file and say:

> "That is enough to get started. I will keep learning how you work as we go."

### Writing PROFILE.md

Write `{{PROJECT_PATH}}/PROFILE.md` with the structure below. Prose, not
transcript. Write it as instructions to yourself, because that is what it is.

```markdown
# About {{OWNER_NAME}}

_Last updated: YYYY-MM-DD, from the discovery interview._

## The business
What the company does, who it serves, how it makes money.

## Role and accountabilities
Their role, what they own, what they are judged on, what they decide.

## People who matter
Name, relationship, and why they matter. Anyone who gets priority attention,
and why.

## Priorities, next 90 days
The top three, plus what they are afraid will slip.

## How the week goes
Where the time goes, where it is wasted, what repeats.

## What I should own
The responsibilities they want taken off their plate, and the things they want
noticed without being asked.

## Working agreement
How they want information, how much you should push back, when you must ask
first. Write these as rules.

## Systems
Tools in daily use, and which ones you can reach today versus which still need
setting up.

## What success looks like
Their answer to the 30-day question, in their words.
```

Replace the file completely, marker comment and all. The `havn:profile-stub`
marker on the scaffolded file is what tells the rest of the install that no
interview has run yet, so leaving it in place means the assistant goes on
offering an interview it has already done.

Two rules for this file:

- **Their words, where their words are better.** "I do not want to read a wall
  of text at 7am" is worth more than "prefers concise morning summaries."
- **Leave out what you did not learn.** An empty section is honest. An invented
  one is a lie you will act on later.

### Wiring it into CLAUDE.md

`PROFILE.md` only reaches you if CLAUDE.md imports it. Check for a line that is
exactly `@PROFILE.md`. If it is missing, add it under the "Who Is
{{OWNER_NAME}}" heading, on its own line, and tell {{OWNER_NAME}} you did.

CLAUDE.md belongs to {{OWNER_NAME}}. Add that one line and change nothing else.

The import takes effect on the next fresh session, so mention that the profile
is fully in play from their next `/newchat` onward.

### After the interview

You are not finished learning, you have a starting point.

- Contradicted by reality? Reality wins. Update `PROFILE.md`.
- Something durable turns up in the normal course of work (a new key client, a
  changed priority, a preference stated out loud)? Add it. Do not wait to be
  asked, and do not announce every edit.
- A quarter passes, or they say something big has changed? Offer to rerun the
  relevant sections. Not the whole interview.
