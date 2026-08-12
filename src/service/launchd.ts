// posix.join on purpose: launchd paths are POSIX by definition, and the
// manager must render identically on any host (tests run on Windows CI too).
import { posix } from 'node:path'
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
    return posix.join(this.home, 'Library', 'LaunchAgents', `${this.opts.label}.plist`)
  }

  renderArtifact(): string {
    return buildPlist(this.opts)
  }

  async install(): Promise<void> {
    // launchd does not create parent directories for StandardOutPath /
    // StandardErrorPath. Without this the job loads (so `launchctl list`
    // exits 0 and status reads "stopped") but never spawns, and because the
    // failure is in setting up stdio there is no log to say so. KeepAlive
    // cannot rescue it: the exec never happens.
    this.io.ensureDir(posix.dirname(this.opts.logFile))
    this.io.writeFile(this.artifactPath(), this.renderArtifact())
    // `launchctl load` is a no-op when the label is already loaded: launchd
    // keeps the definition it read the first time and silently ignores the
    // file we just wrote. A second install (moved folder, reinstall to a new
    // path) therefore leaves launchd running the OLD paths, which by then may
    // not exist. It reports success at every layer and never spawns, with no
    // log at the new location to say why. Unload first so install is
    // idempotent. A not-loaded label makes this exit non-zero, which is fine.
    await this.io.exec('launchctl', ['unload', this.artifactPath()])
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
