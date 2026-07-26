import { execFile } from 'node:child_process'
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { LaunchdManager } from './launchd.js'
import { SystemdManager } from './systemd.js'
import { SchtasksManager } from './schtasks.js'
import { WinswManager } from './winsw.js'
import type { ServiceIO, ServiceManager, ServiceOptions } from './types.js'

/** Real system I/O: execFile with an argv array (never a shell string). */
export function realServiceIO(): ServiceIO {
  return {
    exec: (cmd, args) =>
      new Promise((resolve) => {
        execFile(cmd, args, (error, stdout, stderr) => {
          const raw: unknown = error ? (error as NodeJS.ErrnoException).code ?? 1 : 0
          resolve({ code: typeof raw === 'number' ? raw : 1, out: `${stdout}${stderr}` })
        })
      }),
    writeFile: (path, content) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    },
    removeFile: (path) => rmSync(path, { force: true }),
    exists: (path) => existsSync(path),
  }
}

export function resolveServiceManager(
  platform: NodeJS.Platform,
  opts: ServiceOptions,
  io: ServiceIO = realServiceIO(),
  home: string = homedir()
): ServiceManager {
  switch (platform) {
    case 'darwin':
      return new LaunchdManager(opts, io, home)
    case 'win32':
      // Real SCM service when the installer bundled winsw; logon task otherwise.
      if (opts.winswExe && io.exists(opts.winswExe)) return new WinswManager(opts, io, opts.winswExe)
      return new SchtasksManager(opts, io)
    default:
      return new SystemdManager(opts, io, home)
  }
}
