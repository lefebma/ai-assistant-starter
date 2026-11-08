import pino from 'pino'
import { readEnvFile } from './env.js'
import { createScrubber, secretValuesFromEnv } from './log-redact.js'

/**
 * Every log call is scrubbed before it is written (see log-redact.ts): the exact value of
 * every secret-named env var, secrets registered at runtime from the vault, and well-known
 * token shapes. A box holds the owner's mail, tokens and API keys, and logs rotate rather
 * than purge, so a secret that reaches a log would stay there.
 */
/** The logger is imported first by nearly everything, so reading .env must never be able to stop it loading. */
function envFile(): Record<string, string> {
  try {
    return readEnvFile()
  } catch {
    return {}
  }
}

const scrubber = createScrubber(
  secretValuesFromEnv({ ...envFile(), ...(process.env as Record<string, string | undefined>) }),
)

// LOG_DEST=stderr keeps stdout clean for CLIs whose output is read back
// (the email-alerts command's reply is relayed to the owner word for word).
const toStderr = process.env.LOG_DEST === 'stderr'
const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  hooks: {
    logMethod(args, method) {
      return method.apply(this, args.map((a) => scrubber.deep(a)) as Parameters<typeof method>)
    },
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: !toStderr, destination: toStderr ? 2 : 1 } }
      : undefined,
}

export const logger =
  toStderr && process.env.NODE_ENV === 'production' ? pino(options, pino.destination(2)) : pino(options)
