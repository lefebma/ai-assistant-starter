# Managed AI key

For a hosted client who has no AI account of their own. You supply the AI on a capped Anthropic API key. The client never sees an AI sign-in step or an AI bill. This page is written for the operator (you), not the client.

A client who already has their own AI account does not need this. They enter their own key at the setup step (see `docs/HOSTED-VPS.md`).

## How the cost stays capped

Strongest first:

1. A monthly spend limit on the client's own Anthropic workspace. Anthropic enforces it. Nothing on the box can override it.
2. An organization spend limit above the sum of all clients, as a backstop.
3. Prepaid credit instead of open-ended billing (recommended), so the worst case is money already spent.
4. One key per client, in that client's workspace. A leaked key is archived without touching anyone else.
5. Spend per workspace is visible in the Anthropic Console.

API keys cannot be created by any API, and workspace spend limits are set only in the Console. So the setup below is a checklist of Console clicks plus one command.

## One time

1. In the Anthropic Console, put your organization on prepaid credit (recommended).
2. Set an organization spend limit.

## For each new client

1. Create a workspace named after the box, for example `havn-leif`.
2. In that workspace, set the monthly spend limit. Turn on the Console's alert thresholds so you get an extra email as usage climbs.
3. In that workspace, create one API key named after the box.
4. Put the key on the box, as `havn-admin`:

   ```bash
   sudo -u havn bash -lc 'cd ~/havn && node dist/scripts/managed-ai.js set'
   ```

   The command waits for input. Paste the key, press Enter, then press Ctrl-D. The key goes over stdin only, so it never lands in shell history or on a command line. The command refuses a key given as an argument, and it never prints the key back. The prompt does echo what you paste, so the key is visible on your screen: run `clear` straight after, and close the terminal window if you are sharing your screen.
5. If the box is already set up (it has a `.env`), restart it so it picks up the key:

   ```bash
   sudo systemctl restart havn
   ```

   On a box that has not been set up yet, no restart is needed. When the client opens the setup link, they are asked only for the messaging step. The AI and voice questions are skipped.
6. Record in your private notes: the box, the workspace id, the key name and the limit. Never the key. Keep amounts out of this repo.

Check the state at any time with `node dist/scripts/managed-ai.js status`. It says whether the box is managed, whether a key is stored, whether a limit is in force, and which runtime the assistant uses. It never prints the key. A managed box always runs on the claude runtime: an `AGENT_RUNTIME` line in `.env` is ignored while the box is managed, and `status` says so.

## What a managed box does differently

- The key is the box's only AI connection. There is no subscription sign-in and no fallback key.
- Voice and video are off. The client gets "Voice messages aren't available on this assistant." and cannot change the AI keys from chat.
- The box runs the full assistant on this key, including scheduled jobs and email alerts.

### What the key can reach

The assistant's own tools can read its key, the same way they can read any file on the box. So a client, or text the assistant reads (an email, a web page), could get it to reveal the key. The workspace spend limit bounds what a leaked key can cost. One key per client keeps a leak to that client, and rotating the key (below) ends it.

## When the limit is reached

The box stops. It does not retry and it does not switch to anything else.

- The box writes `store/ai-limit.json` (kind, start time and request id only, never the key).
- The client is told once: "I've reached this month's AI allowance, so I'm paused for now. Your provider has been told and will be in touch." After that, at most a short reminder once a day: "Still paused: this month's AI allowance is used up. Your provider has been told."
- Scheduled jobs, email-alert mail reading and the nightly memory job pause. A repeating job skips its runs during the pause and picks up at its next normal time. A one-time task is kept and runs once the pause lifts. Alerts that were already triaged still go out.
- Email alerts look back 48 hours when mail reading resumes. After a longer pause, mail older than that is not checked for alerts.
- You get a Telegram alert from Umi within about 10 minutes, naming the box and what to do. For a client who comes through Marina, the alert has a Send to Marina button with a plain-language draft. Nothing goes to her until you press it. When the box recovers, you get a second alert with a matching "it's back" draft.

### Raising the limit

In the Console, raise the spend limit on that client's workspace (or wait for the month to reset). Nothing to do on the box. While paused, the box checks about every 15 minutes with one small request (a message from the client at that point can serve as the check instead). The first one that succeeds clears the pause and the assistant resumes by itself, with no restart.

## Rotating a key

1. Create the new key in the same workspace.
2. Run the same `set` command with the new key, then restart if the box was already set up.
3. Confirm the box answers a message.
4. Archive the old key in the Console.

## Removing a client

Archive the client's workspace in the Console. This archives its keys within seconds and cannot be undone.

To take a box off managed mode without archiving anything, run `node dist/scripts/managed-ai.js off`. It removes the managed flag and any pause marker, and leaves the stored key where it is.

On a box that is no longer managed, that leftover key becomes the overflow lane: when the client's own subscription window runs out, the assistant carries on billed to your key. If that is not what you want, remove it from the vault:

```bash
sudo -u havn bash -lc 'cd ~/havn && node dist/scripts/vault-cli.js rm ANTHROPIC_API_KEY'
```

Archive the key in the Console as well.
