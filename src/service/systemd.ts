import { join } from 'node:path'
import type { ServiceIO, ServiceManager, ServiceOptions, ServiceStatus } from './types.js'

export function buildUnit(opts: ServiceOptions): string {
  return `[Unit]
Description=AI assistant service (${opts.name})
After=network-online.target

[Service]
ExecStart="${opts.nodePath}" "${opts.entry}"
WorkingDirectory=${opts.cwd}
Restart=on-failure
RestartSec=5
StandardOutput=append:${opts.logFile}
StandardError=append:${opts.logFile}

[Install]
WantedBy=default.target
`
}

export function parseIsActive(code: number, out: string): ServiceStatus {
  const state = out.trim()
  if (state === 'active') return 'running'
  // systemctl exits 3 for inactive-but-known, 4 for unknown unit.
  if (code === 4) return 'not-installed'
  return 'stopped'
}

export class SystemdManager implements ServiceManager {
  readonly kind = 'systemd' as const

  constructor(
    private readonly opts: ServiceOptions,
    private readonly io: ServiceIO,
    private readonly home: string
  ) {}

  artifactPath(): string {
    return join(this.home, '.config', 'systemd', 'user', `${this.opts.name}.service`)
  }

  renderArtifact(): string {
    return buildUnit(this.opts)
  }

  async install(): Promise<void> {
    this.io.writeFile(this.artifactPath(), this.renderArtifact())
    await this.io.exec('systemctl', ['--user', 'daemon-reload'])
    await this.io.exec('systemctl', ['--user', 'enable', '--now', this.opts.name])
  }

  async uninstall(): Promise<void> {
    await this.io.exec('systemctl', ['--user', 'disable', '--now', this.opts.name])
    this.io.removeFile(this.artifactPath())
    await this.io.exec('systemctl', ['--user', 'daemon-reload'])
  }

  async start(): Promise<void> {
    await this.io.exec('systemctl', ['--user', 'start', this.opts.name])
  }

  async stop(): Promise<void> {
    await this.io.exec('systemctl', ['--user', 'stop', this.opts.name])
  }

  async status(): Promise<ServiceStatus> {
    const { code, out } = await this.io.exec('systemctl', ['--user', 'is-active', this.opts.name])
    return parseIsActive(code, out)
  }
}
