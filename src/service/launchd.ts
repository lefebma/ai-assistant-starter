import { join } from 'node:path'
import type { ServiceIO, ServiceManager, ServiceOptions, ServiceStatus } from './types.js'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildPlist(opts: ServiceOptions): string {
  const e = xmlEscape
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(opts.nodePath)}</string>
    <string>${e(opts.entry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(opts.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${e(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${e(opts.logFile)}</string>
</dict>
</plist>
`
}

export function parseLaunchctlList(code: number, out: string): ServiceStatus {
  if (code !== 0) return 'not-installed'
  return /"PID"\s*=/.test(out) ? 'running' : 'stopped'
}

export class LaunchdManager implements ServiceManager {
  readonly kind = 'launchd' as const

  constructor(
    private readonly opts: ServiceOptions,
    private readonly io: ServiceIO,
    private readonly home: string
  ) {}

  artifactPath(): string {
    return join(this.home, 'Library', 'LaunchAgents', `${this.opts.label}.plist`)
  }

  renderArtifact(): string {
    return buildPlist(this.opts)
  }

  async install(): Promise<void> {
    this.io.writeFile(this.artifactPath(), this.renderArtifact())
    await this.io.exec('launchctl', ['load', '-w', this.artifactPath()])
  }

  async uninstall(): Promise<void> {
    await this.io.exec('launchctl', ['unload', this.artifactPath()])
    this.io.removeFile(this.artifactPath())
  }

  async start(): Promise<void> {
    await this.io.exec('launchctl', ['start', this.opts.label])
  }

  async stop(): Promise<void> {
    await this.io.exec('launchctl', ['stop', this.opts.label])
  }

  async status(): Promise<ServiceStatus> {
    const { code, out } = await this.io.exec('launchctl', ['list', this.opts.label])
    return parseLaunchctlList(code, out)
  }
}
