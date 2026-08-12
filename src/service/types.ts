/**
 * Service abstraction (Phase 5): one interface over launchd (macOS),
 * systemd user units (Linux), and a Task Scheduler logon task (Windows
 * baseline — a full SCM service via winsw ships with the installer).
 */

export interface ServiceOptions {
  /** launchd label, e.g. com.ai-assistant.service */
  label: string
  /** short name for systemd/schtasks, e.g. ai-assistant */
  name: string
  nodePath: string
  entry: string
  cwd: string
  logFile: string
  /** Bundled winsw executable (Windows); when present, a real SCM service
   * replaces the schtasks logon-task baseline. */
  winswExe?: string
}

export type ServiceStatus = 'running' | 'stopped' | 'not-installed'

/** Injected so managers are testable without touching the real system. */
export interface ServiceIO {
  exec(cmd: string, args: string[]): Promise<{ code: number; out: string }>
  writeFile(path: string, content: string): void
  removeFile(path: string): void
  exists(path: string): boolean
  /** Create a directory and its parents. Used for the log directory. */
  ensureDir(path: string): void
}

export interface ServiceManager {
  readonly kind: 'launchd' | 'systemd' | 'schtasks' | 'winsw'
  /** Path of the artifact install writes, or null (schtasks registers via command). */
  artifactPath(): string | null
  /** Rendered artifact content for --dry-run display, or null. */
  renderArtifact(): string | null
  install(): Promise<void>
  uninstall(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<ServiceStatus>
}
