/**
 * Is something going to start us again if we exit?
 *
 * `/update apply` swaps the engine files under a running process and then says
 * "Restart the service to activate". On a laptop that is a shortcut click. On a
 * hosted box there is no terminal, so for the client the instruction is not
 * actionable at all: havn-test sat on 1.18.0 code for two days with 1.19.0 on
 * disk, and the only symptom was that the update appeared not to have worked.
 *
 * The fix is for the app to exit and let its supervisor bring it back, which is
 * the same trick the polling watchdog already uses. It is only safe when a
 * supervisor is actually there. Exiting without one does not restart anything;
 * it just ends the assistant, with no terminal around to start it again. So the
 * detection below is deliberately conservative: an unrecognised environment
 * reports 'none' and the client keeps the old, honest instruction.
 *
 * What the signals are:
 *
 * - systemd sets INVOCATION_ID for every unit it starts (since v232), system
 *   and user alike. A user unit's parent is `systemd --user`, not PID 1, so the
 *   parent check below would miss it; this catches both.
 * - launchd sets XPC_SERVICE_NAME to the job label and parents the job to PID 1.
 *   An interactive shell has XPC_SERVICE_NAME=0 and a real parent. Verified on
 *   macOS 15 against a running LaunchAgent and a Terminal session.
 * - Windows gets 'none' on purpose. The Task Scheduler logon task the installer
 *   falls back to has no crash supervision at all, and treating it as if it did
 *   would take a client's assistant down for good.
 */

export type Supervisor = 'systemd' | 'launchd' | 'none'

export interface SupervisorProbe {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  ppid?: number
}

/**
 * Exit code that asks the supervisor for a restart.
 *
 * Non-zero on purpose. The hosted unit uses Restart=always and launchd uses
 * KeepAlive, both of which restart on any exit, but the user unit this app
 * installs itself uses Restart=on-failure, where a clean exit is final. The
 * polling watchdog has used this code for the same reason since it was added.
 */
export const RESTART_EXIT_CODE = 43

export function detectSupervisor(probe: SupervisorProbe = {}): Supervisor {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const ppid = probe.ppid ?? process.ppid

  if (env.INVOCATION_ID) return 'systemd'

  if (platform === 'darwin') {
    const xpc = env.XPC_SERVICE_NAME
    if (xpc && xpc !== '0') return 'launchd'
    if (ppid === 1) return 'launchd'
  }

  return 'none'
}

/** True when exiting will bring the assistant back rather than end it. */
export function canSelfRestart(probe: SupervisorProbe = {}): boolean {
  return detectSupervisor(probe) !== 'none'
}
