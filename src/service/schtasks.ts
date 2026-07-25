import type { ServiceIO, ServiceManager, ServiceOptions, ServiceStatus } from './types.js'

/**
 * Windows baseline: a Task Scheduler logon task. No new binaries, works
 * today; limitations vs a real SCM service (no crash-restart supervision)
 * are documented and get upgraded to winsw with the installer slice.
 */
export function buildCreateArgs(opts: ServiceOptions): string[] {
  return [
    '/create',
    '/tn', opts.name,
    '/sc', 'onlogon',
    '/rl', 'LIMITED',
    '/tr', `"${opts.nodePath}" "${opts.entry}"`,
    '/f',
  ]
}

export function parseQuery(code: number, out: string): ServiceStatus {
  if (code !== 0) return 'not-installed'
  return /\bRunning\b/.test(out) ? 'running' : 'stopped'
}

export class SchtasksManager implements ServiceManager {
  readonly kind = 'schtasks' as const

  constructor(
    private readonly opts: ServiceOptions,
    private readonly io: ServiceIO
  ) {}

  artifactPath(): null {
    return null // schtasks registers via command, no file artifact
  }

  renderArtifact(): string {
    return `schtasks ${buildCreateArgs(this.opts).join(' ')}`
  }

  async install(): Promise<void> {
    await this.io.exec('schtasks', buildCreateArgs(this.opts))
    await this.start()
  }

  async uninstall(): Promise<void> {
    await this.io.exec('schtasks', ['/end', '/tn', this.opts.name])
    await this.io.exec('schtasks', ['/delete', '/tn', this.opts.name, '/f'])
  }

  async start(): Promise<void> {
    await this.io.exec('schtasks', ['/run', '/tn', this.opts.name])
  }

  async stop(): Promise<void> {
    await this.io.exec('schtasks', ['/end', '/tn', this.opts.name])
  }

  async status(): Promise<ServiceStatus> {
    const { code, out } = await this.io.exec('schtasks', ['/query', '/tn', this.opts.name, '/v', '/fo', 'LIST'])
    return parseQuery(code, out)
  }
}
