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

/**
 * The nftables table for a cgroup path relative to the cgroup root, e.g.
 * "system.slice/havn.service/tools". `level` is its depth.
 */
export function nftRules(relCgroup: string, ports: [number, number]): string {
  const level = relCgroup.split('/').filter(Boolean).length
  const match = `socket cgroupv2 level ${level} "${relCgroup}"`
  return [
    'table inet havn_egress {',
    '  chain out {',
    '    type filter hook output priority 0; policy accept;',
    `    ${match} ip daddr 127.0.0.1 tcp dport ${ports[0]}-${ports[1]} accept`,
    `    ${match} limit rate 10/minute log prefix "havn-egress-drop "`,
    `    ${match} drop`,
    '  }',
    '}',
    '',
  ].join('\n')
}
