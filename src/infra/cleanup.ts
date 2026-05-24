import { logger } from '../logger.js'

export async function runBestEffortCleanup<T>(params: {
  name: string
  cleanup: () => Promise<T> | T
}): Promise<T | undefined> {
  try {
    return await params.cleanup()
  } catch (err) {
    logger.warn({ err, step: params.name }, 'cleanup step failed (non-fatal)')
    return undefined
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logger.warn({ ms, label }, 'cleanup step timed out')
      resolve(undefined)
    }, ms)
    timer.unref()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
