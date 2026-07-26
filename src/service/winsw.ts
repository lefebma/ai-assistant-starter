/**
 * Real Windows service via winsw (Phase 5 installer). The installer bundles
 * a pinned winsw executable as tools/winsw/<name>-service.exe; this manager
 * writes the sibling XML config and drives install/start/stop/status through
 * it. Unlike the schtasks baseline, winsw supervises the process (restart on
 * failure) — this is the launchd/systemd equivalent for Windows.
 */
import { posix, win32 } from 'node:path'
import type { ServiceIO, ServiceManager, ServiceOptions, ServiceStatus } from './types.js'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function buildWinswXml(opts: ServiceOptions): string {
  const e = xmlEscape
  return `<service>
  <id>${e(opts.name)}</id>
  <name>${e(opts.name)}</name>
  <description>AI assistant service (${e(opts.name)})</description>
  <executable>${e(opts.nodePath)}</executable>
  <arguments>"${e(opts.entry)}"</arguments>
  <workingdirectory>${e(opts.cwd)}</workingdirectory>
  <log mode="roll"></log>
  <onfailure action="restart" delay="5 sec"/>
  <stoptimeout>15 sec</stoptimeout>
</service>
`
}

export function parseWinswStatus(code: number, out: string): ServiceStatus {
  if (/NonExistent/i.test(out)) return 'not-installed'
  if (code !== 0) return 'not-installed'
  return /Started|Active/i.test(out) ? 'running' : 'stopped'
}

/** XML config path: sibling of the winsw exe, same basename. */
export function winswXmlPath(exePath: string): string {
  const path = exePath.includes('\\') ? win32 : posix
  const dir = path.dirname(exePath)
  const base = path.basename(exePath, '.exe')
  return path.join(dir, `${base}.xml`)
}

export class WinswManager implements ServiceManager {
  readonly kind = 'winsw' as const

  constructor(
    private readonly opts: ServiceOptions,
    private readonly io: ServiceIO,
    private readonly exePath: string
  ) {}

  artifactPath(): string {
    return winswXmlPath(this.exePath)
  }

  renderArtifact(): string {
    return buildWinswXml(this.opts)
  }

  async install(): Promise<void> {
    this.io.writeFile(this.artifactPath(), this.renderArtifact())
    await this.io.exec(this.exePath, ['install'])
    await this.io.exec(this.exePath, ['start'])
  }

  async uninstall(): Promise<void> {
    await this.io.exec(this.exePath, ['stop'])
    await this.io.exec(this.exePath, ['uninstall'])
    this.io.removeFile(this.artifactPath())
  }

  async start(): Promise<void> {
    await this.io.exec(this.exePath, ['start'])
  }

  async stop(): Promise<void> {
    await this.io.exec(this.exePath, ['stop'])
  }

  async status(): Promise<ServiceStatus> {
    const { code, out } = await this.io.exec(this.exePath, ['status'])
    return parseWinswStatus(code, out)
  }
}
