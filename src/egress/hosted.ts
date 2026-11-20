/**
 * The kernel half of egress on a hosted box (card #231).
 *
 * The proxy only sees traffic that asks for it. On a hosted box everything an
 * agent runs (the Claude CLI, its Bash tools, MCP servers, the browser) is
 * started inside one cgroup, EGRESS_CGROUP, and an nftables rule lets that
 * cgroup reach nothing but the proxy ports on 127.0.0.1. No DNS, no direct
 * connection, IPv6 included. The assistant's own connections (Telegram, mail
 * alerts, the AI calls of the ai-sdk runtime) stay outside it.
 *
 * A process joins the cgroup before it execs the real command, so nothing it
 * starts ever runs outside. If joining fails the command does not run: the
 * shell's && stops it. Fail closed.
 *
 * enable-egress (scripts/hosted/enable-egress.ts) sets this up as root:
 * a systemd drop-in with Delegate=yes, an ExecStartPre that makes the cgroup
 * and loads the rule, and EGRESS=enforce with EGRESS_CGROUP in the unit's env.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { EGRESS_CGROUP } from '../config.js'

/** The command and args that run `command` inside the tools cgroup. Unchanged when there is none. */
export function inToolsCgroup(command: string, args: string[], cgroup: string = EGRESS_CGROUP): { command: string; args: string[] } {
  if (!cgroup) return { command, args }
  // $0 is the cgroup, "$@" the real command: no quoting of the command needed.
  return { command: '/bin/sh', args: ['-c', 'echo $$ > "$0/cgroup.procs" && exec "$@"', cgroup, command, ...args] }
}

/** spawnClaudeCodeProcess for the Agent SDK: the CLI starts inside the tools cgroup. */
export function spawnInToolsCgroup(o: SpawnOptions): SpawnedProcess {
  const { command, args } = inToolsCgroup(o.command, o.args)
  // stdin and stdout are pipes here, so never null.
  const child: ChildProcess = spawn(command, args, { cwd: o.cwd, env: o.env as NodeJS.ProcessEnv, signal: o.signal, stdio: ['pipe', 'pipe', 'inherit'] })
  return child as unknown as SpawnedProcess
}

/** Connection marks: a tools connection on loopback, and one whose listener was checked (card #278). */
export const LOOPBACK_MARK = '0x68766e74'
export const CHECKED_MARK = '0x68766e75'

/**
 * The nftables table for a cgroup path relative to the cgroup root, e.g.
 * "system.slice/havn.service/tools". `level` is its depth.
 *
 * The tools cgroup may reach the proxy ports, and (card #278) a loopback port
 * that a process in the same cgroup is listening on: the browser tools talk to
 * the Chromium they start over a local debugging port Playwright picks at
 * random. Nothing else on the box (the assistant's web server, the privacy
 * relay, sshd) is reachable, and nothing outside the cgroup can reach a tools
 * listener. How:
 *   - out: a new tools connection to 127.0.0.1 off the proxy ports is marked,
 *     and only connections carrying this table's marks may send; anything
 *     else from the cgroup (unmarked, untracked, a reply to an outside
 *     client) is dropped
 *   - in: its first packet is let through only if the listening socket it
 *     reaches is in the tools cgroup, and the connection is then marked as
 *     checked; any other packet of a marked, unchecked connection is dropped,
 *     and so is a connection from outside the cgroup to a tools listener.
 * The check has to happen on the first packet: later in the handshake the
 * kernel sees a half-open socket, whose cgroup it cannot read. A retransmitted
 * first packet keeps the checked mark.
 */
export function nftRules(relCgroup: string, ports: [number, number]): string {
  const level = relCgroup.split('/').filter(Boolean).length
  const match = `socket cgroupv2 level ${level} "${relCgroup}"`
  return [
    'table inet havn_egress {',
    '  chain out {',
    '    type filter hook output priority 0; policy accept;',
    `    ${match} ip daddr 127.0.0.1 tcp dport ${ports[0]}-${ports[1]} accept`,
    `    ${match} ip daddr 127.0.0.1 meta l4proto tcp ct state new ct mark != ${CHECKED_MARK} ct mark set ${LOOPBACK_MARK} accept`,
    `    ${match} ip daddr 127.0.0.1 meta l4proto tcp ct mark { ${LOOPBACK_MARK}, ${CHECKED_MARK} } accept`,
    `    ${match} limit rate 10/minute log prefix "havn-egress-drop "`,
    `    ${match} drop`,
    '  }',
    '  chain in {',
    '    type filter hook input priority 0; policy accept;',
    `    iif "lo" ct mark ${LOOPBACK_MARK} ct direction original ${match} ct mark set ${CHECKED_MARK} accept`,
    `    iif "lo" ct mark ${LOOPBACK_MARK} ct direction original limit rate 10/minute log prefix "havn-egress-lo-drop "`,
    `    iif "lo" ct mark ${LOOPBACK_MARK} ct direction original drop`,
    // A client outside the cgroup must not even open a connection to a tools listener.
    `    iif "lo" ct direction original ct mark != { ${LOOPBACK_MARK}, ${CHECKED_MARK} } ${match} drop`,
    '  }',
    '}',
    '',
  ].join('\n')
}
