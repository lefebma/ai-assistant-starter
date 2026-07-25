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

## Custom vault location

Set `AGENT_VAULT_DIR=/path/to/dir` to keep the vault somewhere other than the
default. The test suite always points this at a throwaway directory so tests can
never touch your real vault.
