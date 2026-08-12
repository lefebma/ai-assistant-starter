import { describe, it, expect } from 'vitest'
import { buildNextSteps, renderNextSteps, type NextStepsInput } from '../src/setup/next-steps.js'

const BASE: NextStepsInput = {
  needsBotCredentials: false,
  gmailAddress: '',
  gmailAddress2: '',
  gogMissing: false,
  outlookAddress: '',
  wordsmith: false,
  serviceInstalled: false,
  nodeBin: '"/app/runtime/bin/node"',
  appEntry: '"/app/dist/src/index.js"',
  serviceEntry: '"/app/dist/scripts/service.js"',
}

const flatten = (i: NextStepsInput) => renderNextSteps(buildNextSteps(i)).join('\n')

describe('buildNextSteps', () => {
  it('never tells you to run it in the foreground while the service is running', () => {
    // The regression. index.ts acquireLock() SIGTERMs the PID-file holder and
    // the launchd job sets KeepAlive, so the foreground process and the
    // service kill each other in a loop. It reads as the app crashing on
    // launch, and the previous list printed this directly above
    // "Already running in the background".
    const out = flatten({ ...BASE, serviceInstalled: true })
    expect(out).not.toMatch(/Test it in this window/)
    expect(out).not.toMatch(/dist\/src\/index\.js"$/m) // no bare foreground run
    expect(out).toMatch(/already running in the background/i)
  })

  it('offers the foreground run only when nothing is running yet', () => {
    const out = flatten({ ...BASE, serviceInstalled: false })
    expect(out).toMatch(/Test it in this window/)
    expect(out).toMatch(/Install as a service/)
    expect(out).not.toMatch(/already running/i)
  })

  it('always offers the self-test, which is safe next to a running service', () => {
    // --selftest returns before acquireLock(), so it cannot disturb the service.
    for (const serviceInstalled of [true, false]) {
      expect(flatten({ ...BASE, serviceInstalled })).toMatch(/--selftest --live/)
    }
  })

  it('ties the restart to the .env edit only when .env is actually incomplete', () => {
    const incomplete = flatten({ ...BASE, serviceInstalled: true, needsBotCredentials: true })
    // With no token the app exits on startup and launchd retries it, so it is
    // installed but not answering. Claiming otherwise sends the owner looking
    // for a bot that cannot reply.
    expect(incomplete).not.toMatch(/already running/i)
    expect(incomplete).toMatch(/as soon as \.env has your credentials/)
    expect(flatten({ ...BASE, serviceInstalled: true, needsBotCredentials: false })).toMatch(/already running in the background/)
  })

  it('numbers steps contiguously from 1 whatever is included', () => {
    const numbers = (i: NextStepsInput) =>
      renderNextSteps(buildNextSteps(i))
        .filter((l) => /^ {2}\d+\./.test(l))
        .map((l) => parseInt(l.trim(), 10))

    const minimal = numbers(BASE)
    expect(minimal).toEqual(Array.from({ length: minimal.length }, (_, n) => n + 1))

    const everything = numbers({
      ...BASE,
      needsBotCredentials: true,
      gmailAddress: 'a@g.com',
      gmailAddress2: 'b@g.com',
      gogMissing: true,
      outlookAddress: 'a@o.com',
      wordsmith: true,
      serviceInstalled: true,
    })
    expect(everything).toEqual(Array.from({ length: everything.length }, (_, n) => n + 1))
    expect(everything.length).toBeGreaterThan(minimal.length)
  })

  it('mentions installing gog only when it is actually missing', () => {
    const withGmail = { ...BASE, gmailAddress: 'a@g.com' }
    expect(flatten({ ...withGmail, gogMissing: true })).toMatch(/brew install gogcli/)
    expect(flatten({ ...withGmail, gogMissing: false })).not.toMatch(/brew install gogcli/)
  })

  it('pairs the OAuth client step with auth add, and covers a second account', () => {
    const out = flatten({ ...BASE, gmailAddress: 'a@g.com', gmailAddress2: 'b@g.com' })
    // auth add fails without credentials set first, so it must never appear alone.
    expect(out.indexOf('gog auth credentials set')).toBeLessThan(out.indexOf('gog auth add a@g.com'))
    expect(out).toMatch(/gog auth add b@g\.com/)
  })

  it('skips Gmail steps entirely when no Gmail account was configured', () => {
    const out = flatten(BASE)
    expect(out).not.toMatch(/gog auth/)
  })

  it('uses absolute paths so the commands work from any directory', () => {
    // Steps 5 and 6 once printed relative `dist/src/index.js` next to an
    // absolute node, which fails everywhere except the install root.
    const out = flatten({ ...BASE, serviceInstalled: false })
    for (const line of out.split('\n').filter((l) => l.includes('node"'))) {
      expect(line).not.toMatch(/ dist\//)
    }
  })
})
