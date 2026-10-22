/**
 * Pure pieces of web setup on a hosted box. scripts/hosted/enable-setup.ts
 * does the systemctl work.
 *
 * Three units. havn-setup serves the one-time link as the unprivileged havn
 * user. When the client finishes, it writes a marker file and exits; it has no
 * sudo and cannot gain privileges (NoNewPrivileges). The root-owned
 * havn-setup-done.path sees the marker and runs havn-setup-done.service,
 * which retires the setup units and enables and starts the assistant. The
 * internet-facing process never holds the keys to the box.
 */
export const SETUP_UNIT_NAME = 'havn-setup'
export const SETUP_UNIT_PATH = `/etc/systemd/system/${SETUP_UNIT_NAME}.service`
export const HANDOFF_PATH_UNIT = 'havn-setup-done.path'
export const HANDOFF_SERVICE_UNIT = 'havn-setup-done.service'
/** Relative to the install dir; written by setup-web when setup is complete. */
export const SETUP_FINISHED_MARKER = 'store/setup-finished'

/**
 * Logs systemd appends to on a set-up box: web setup's, then the assistant's.
 * systemd opens them as root and creates a missing one root-owned, which log
 * rotation (it runs as havn, see /etc/logrotate.d/havn) cannot empty. So
 * enable-setup creates both as havn before starting anything.
 */
export const UNIT_LOGS = ['logs/setup.log', 'logs/service.log'] as const

function checkDir(installDir: string): void {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(installDir)) throw new Error(`Not a plain absolute path: ${installDir}`)
}

export function buildSetupUnit(installDir: string): string {
  checkDir(installDir)
  return [
    '# Web setup for a hosted Havn box. Written by scripts/hosted/enable-setup.ts.',
    '# Serves the one-time setup link on the port the assistant will use, then',
    '# disables itself and starts havn.service when the client finishes.',
    '[Unit]',
    'Description=Havn web setup',
    'After=network-online.target',
    'Wants=network-online.target',
    // Never alongside the assistant: they share a port.
    'Conflicts=havn.service',
    '',
    '[Service]',
    'Type=simple',
    'User=havn',
    'Group=havn',
    `WorkingDirectory=${installDir}`,
    `ExecStart=/usr/bin/node ${installDir}/dist/scripts/setup-web.js --hosted`,
    // A clean exit means setup finished (or was already done): stay down.
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=HOME=/home/havn',
    `StandardOutput=append:${installDir}/${UNIT_LOGS[0]}`,
    `StandardError=append:${installDir}/${UNIT_LOGS[0]}`,
    // It faces the internet and never needs to escalate: the handoff is root's.
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

export function buildHandoffPath(installDir: string): string {
  checkDir(installDir)
  return [
    '# Written by scripts/hosted/enable-setup.ts. Fires once web setup is done.',
    '[Unit]',
    'Description=Havn web setup finished',
    '',
    '[Path]',
    `PathExists=${installDir}/${SETUP_FINISHED_MARKER}`,
    `Unit=${HANDOFF_SERVICE_UNIT}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n')
}

export function buildHandoffService(): string {
  return [
    '# Written by scripts/hosted/enable-setup.ts. Retires web setup and starts',
    '# the assistant. Runs as root, triggered only by havn-setup-done.path.',
    '[Unit]',
    'Description=Hand a set-up Havn box to the assistant',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=/bin/systemctl disable --now ${SETUP_UNIT_NAME}.service ${HANDOFF_PATH_UNIT}`,
    'ExecStart=/bin/systemctl enable --now havn.service',
    '',
  ].join('\n')
}
