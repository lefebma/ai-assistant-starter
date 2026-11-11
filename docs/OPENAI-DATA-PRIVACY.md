# Keep OpenAI from training on your data

If your assistant runs on OpenAI, this page shows how to make sure OpenAI does
not use what you send it to train its models. It takes about five minutes.

OpenAI's screens change from time to time. Where a name below differs on your
screen, look for the same idea. The links at the end go to OpenAI's own pages,
which are the final word.

## The short version

- **Your assistant talks to OpenAI through an API key, not through the ChatGPT app.**
  Those are two separate accounts with separate privacy settings. Turning off
  training in the ChatGPT app does nothing for your assistant, and the other way
  round.
- **OpenAI says it does not train on API data unless you opt in.** So the main job
  is to check that you did not opt in, and to know what OpenAI still keeps.
- **If you also use ChatGPT yourself**, turn off its training setting too. Section 3.

## 1. Check your assistant's account (the API platform)

This is the account your assistant's key belongs to.

1. Sign in at platform.openai.com with the account that created the key.
2. Open **Settings**, then **Organization**, then **Data controls**.
3. Find **Data sharing** (sometimes called sharing inputs and outputs with OpenAI).
   It should say **Disabled**. OpenAI turns it off by default. Some accounts are
   offered free daily usage if they switch it on. That offer works by letting
   OpenAI use your traffic, so do not take it if your assistant handles client
   information.
4. If your organization has several projects, check the setting for each one
   ("enabled for selected projects" should not list any project your assistant uses).

If you see "Enabled", switch it to **Disabled**.

## 2. Know what OpenAI still keeps

Not training is not the same as not keeping.

- **30 days.** By default OpenAI can keep what your assistant sends for up to 30
  days to watch for misuse. It is not used for training in that time.
- **Your own copy of the calls.** On the same Data controls area, under **Data
  retention**, **API call logging** decides whether your organization keeps a
  copy of what your assistant sends, so you can look it over in the OpenAI
  dashboard. This is separate from training. Choose **Disabled** if you would
  rather no copy sits in your account, or **Enabled per call** to keep copies
  only when a call asks for it. OpenAI notes that Responses API calls are
  logged by default unless the call sets `store=false`, so check what yours says.
- **Zero data retention.** Some accounts can ask OpenAI for zero data retention,
  which removes the 30-day period. OpenAI has to approve this, and it is meant for
  organizations with strict rules about client data. If you are one of them, ask
  OpenAI about it. Once approved, you will see a **Data Retention** tab in the same
  Data controls page.
- **What your assistant sends.** Your assistant sends OpenAI the text it needs to
  answer: your messages and the parts of emails, calendar entries and files it is
  working on. The [privacy filter](PRIVACY.md) can swap client names, email
  addresses and phone numbers for placeholders before anything leaves your
  machine. It does not cover names that are not on your list.

## 3. If you also use ChatGPT yourself

Skip this if you never open the ChatGPT app. If you do, set it up so your own
conversations are not used for training either.

1. In ChatGPT, click your profile picture, then **Settings**, then **Data controls**.
2. Turn **Improve the model for everyone** off. It applies to your whole account,
   on every device.
3. For a one-off private conversation, start a **Temporary Chat**. It does not
   show in your history, does not use or create memory, and is not used for
   training. OpenAI deletes it within 30 days.
4. Avoid the thumbs up and thumbs down buttons on answers you want kept private.
   If you give feedback, OpenAI may use that whole conversation to improve its models.

**Business, Enterprise and Edu plans.** OpenAI says it does not train on data from
ChatGPT Business, Enterprise or Edu, or from the API, by default. The training
setting above is mainly for personal accounts (Free, Plus and Pro).

## 4. Your assistant's voice

If you gave your assistant an OpenAI key for voice calls, that key is in the same
account as section 1, so the same Data sharing setting covers it. Voice is a
separate path from text, though, so it is worth checking when you change anything.

## Checklist

- [ ] Data sharing is **Disabled** for the organization and for every project the assistant uses.
- [ ] You have chosen how API call logging is set (Data retention page).
- [ ] You know the 30-day period applies, and you have decided whether you need zero data retention.
- [ ] If you use ChatGPT, **Improve the model for everyone** is off.
- [ ] If client names matter, the [privacy filter](PRIVACY.md) is on.

## OpenAI's own pages

- Data controls in ChatGPT: https://help.openai.com/en/articles/7730893
- How OpenAI uses your data to improve models: https://help.openai.com/en/articles/7039943
- Sharing API data with OpenAI (the opt-in): https://help.openai.com/en/articles/10306912
- API data retention and controls: https://developers.openai.com/api/docs/guides/your-data
- Business data privacy: https://openai.com/business-data/

Checked against OpenAI's pages in November 2026. If anything here no longer
matches what you see, trust OpenAI's page and tell us.
