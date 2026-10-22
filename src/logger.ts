import pino from 'pino'

// LOG_DEST=stderr keeps stdout clean for CLIs whose output is read back
// (the email-alerts command's reply is relayed to the owner word for word).
const toStderr = process.env.LOG_DEST === 'stderr'
const options: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: !toStderr, destination: toStderr ? 2 : 1 } }
      : undefined,
}

export const logger =
  toStderr && process.env.NODE_ENV === 'production' ? pino(options, pino.destination(2)) : pino(options)
