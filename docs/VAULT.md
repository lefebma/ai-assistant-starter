# The Secret Vault

Your API keys and tokens can live in an encrypted local vault instead of plain
text in `.env`. Nothing requires it — every secret still works from `.env` — but
the vault means a leaked backup, a synced dotfile, or a curious process reading
your home directory doesn't hand over your keys.

## How it works

- Secrets are stored in an AES-256-GCM encrypted file; the encryption key lives
  in a separate file created with owner-only permissions (0600) in a 0700
  directory.
- Everything that needs a secret resolves it in this order: **vault → `.env` →
  process environment**. Migrating a key changes nothing else about your setup.
- Decryption fails closed: a tampered vault yields an error, never silent
  garbage.
- Vault files are gitignored and never leave your machine.

## From chat: the /secret command

On a hosted or headless install you may have no terminal at all. The `/secret`
command manages the vault from the chat, and it is built so the key value
never reaches the AI model: the whole exchange is handled in bot code, outside
the model conversation.

```
/secret set OPENAI_API_KEY   - the bot asks for the key as your next message
/secret list                 - stored key names (values are never shown)
/secret rm OPENAI_API_KEY    - remove a key
/secret cancel               - abort a pending set
```

What happens on `set`: your next message is captured directly into the
encrypted vault, the key is checked against its provider (a rejected key is
not saved), your message is deleted from the chat, and the confirmation shows
only the last four characters. The request expires after 3 minutes, and only
the primary chat can use the command.

Two honest caveats: your chat platform's servers still see the message in
transit (Telegram bot chats are not end-to-end encrypted), and on platforms
where bots cannot delete user messages (Slack) the bot asks you to delete it
yourself. If your security policy forbids keys transiting chat at all, have
your operator set the key over SSH with the CLI below.

The model provider picks a new key up immediately. A few features read their
keys once at startup (voice, the bot token itself), so those apply on the next
service restart.

## Commands

Run compiled, after `npm run build`:

```bash
# Move keys from .env into the vault (non-destructive: .env keeps its copy
# until you delete it yourself)
node dist/scripts/vault-cli.js migrate TELEGRAM_BOT_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY

# Set a secret directly - value comes from stdin so it never lands in shell history
echo -n 'sk-...' | node dist/scripts/vault-cli.js set OPENAI_API_KEY

# Inspect (names only - values are never listed)
node dist/scripts/vault-cli.js list

# Read one value (prints it, so mind your terminal)
node dist/scripts/vault-cli.js get OPENAI_API_KEY

# Remove a secret from the vault
node dist/scripts/vault-cli.js rm OPENAI_API_KEY
```

After migrating, restart the service so it re-resolves secrets. Once you've
confirmed everything works, delete the migrated lines from `.env` — that's the
moment the vault is actually protecting you.

## Which secrets go through it

Everything the engine reads via its secret resolver: `TELEGRAM_BOT_TOKEN`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `HTTP_BEARER_TOKEN`,
`ELEVENLABS_API_KEY`. Non-secret config (chat ids, ports, model names, flags)
stays in `.env` on purpose — it's not sensitive, and keeping it visible makes
setups debuggable.

## Keeping the master key in the OS credential store

By default the encryption key is a file (`vault.key`) locked to your user with
POSIX permissions. On Windows that lock doesn't exist (NTFS uses ACLs, not
permission bits), and even on macOS/Linux you may prefer the OS-managed option:

```bash
node dist/scripts/vault-cli.js migrate-key-to-keyring
```

This stores the key in the macOS Keychain, Windows Credential Manager, or
Linux Secret Service (via the audited `@napi-rs/keyring` native module), and
verifies your secrets decrypt through it. Then:

1. Add `VAULT_KEY_BACKEND=keyring` to `.env`
2. Restart the service and verify the assistant works
3. Delete `vault.key` — that's the moment the migration is complete

The encrypted `secrets.json` blob stays where it was; only the key moves.
Headless servers without a credential store should stay on the file backend.

## Custom vault location

Set `AGENT_VAULT_DIR=/path/to/dir` to keep the vault somewhere other than the
default. The test suite always points this at a throwaway directory so tests can
never touch your real vault.
