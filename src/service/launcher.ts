/**
 * Double-clickable restart launcher.
 *
 * The service auto-starts at login and relaunches itself on crash, so this is
 * the rare case: a process that is alive but wedged (expired credential, rate
 * limit, stuck poll). Recovery for that used to mean a terminal command, which
 * is not something a non-technical owner will ever run. This generates a thing
 * they can double-click instead.
 *
 * Pure artifact generation, like the rest of src/service. Callers write the
 * files; nothing here touches the filesystem.
 */

export interface LauncherOptions {
  /** Display name, e.g. "AI Assistant". */
  appName: string
  /** Absolute path to the Node binary that should run the CLI. */
  nodePath: string
  /** Install root — where dist/scripts/service.js lives. */
  cwd: string
}

export interface LauncherFile {
  /** Path relative to the directory the launcher is installed into. */
  path: string
  content: string
  executable: boolean
}

/** Where build-installer stamps the product name into the payload. */
export const APP_NAME_FILE = 'app-name.txt'

export const DEFAULT_APP_NAME = 'AI Assistant'

/**
 * The setup launcher is named at build time and the restart launcher at run
 * time, and nothing used to carry the name between them: a Havn bundle
 * shipped "Setup Havn.command" beside "Restart AI Assistant.app". The build
 * now stamps the name into the payload and the runtime reads it, with an
 * explicit APP_NAME in .env still winning so an owner can rename their own.
 */
export function resolveAppName(fromEnv: string | undefined, fromFile: string | undefined): string {
  return fromEnv?.trim() || fromFile?.trim() || DEFAULT_APP_NAME
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function macScript(o: LauncherOptions): string {
  // Output goes to a log rather than into osascript: interpolating arbitrary
  // command output into AppleScript is a quoting bug waiting to happen.
  return `#!/bin/sh
# Restarts the ${o.appName} background service. Double-click this app to run it.
LOG="${o.cwd}/logs/restart.log"
mkdir -p "${o.cwd}/logs"
if "${o.nodePath}" "${o.cwd}/dist/scripts/service.js" restart >"$LOG" 2>&1; then
  osascript -e 'display notification "Restarted." with title "${o.appName}"'
else
  osascript -e 'display dialog "Could not restart. Details are in logs/restart.log inside the ${o.appName} folder." with title "${o.appName}" buttons {"OK"} default button "OK"'
fi
`
}

function macPlist(o: LauncherOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Restart ${o.appName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.${slug(o.appName)}.restart</string>
  <key>CFBundleExecutable</key>
  <string>restart</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`
}

export interface SetupLauncherOptions {
  /** Display name, e.g. "AI Assistant". */
  appName: string
}

/**
 * Double-clickable setup launcher, shipped *inside* the install folder.
 *
 * The signed .pkg lays down files and stops; without this the customer has an
 * installed assistant and no way to configure it that does not begin with
 * opening a terminal.
 *
 * macOS gets a `.command` rather than a `.app` on purpose. The wizard is
 * interactive, so it needs a real terminal; an .app would have to drive
 * Terminal through osascript, which trips the "wants to control Terminal"
 * consent dialog on first run. Finder runs a `.command` in Terminal directly
 * with no such prompt. It must carry the executable bit or Finder opens it in
 * TextEdit instead of running it.
 *
 * Unlike the restart launcher, paths here resolve relative to the script's own
 * location: the installer chooses where this lands, and the customer may move
 * the folder later.
 */
export function setupLauncherFiles(platform: string, o: SetupLauncherOptions): LauncherFile[] {
  if (platform === 'win32') {
    return [
      {
        path: `Setup ${o.appName}.cmd`,
        content: `@echo off
title Set up ${o.appName}
cd /d "%~dp0"
"%~dp0runtime\\node.exe" "%~dp0dist\\scripts\\setup.js"
echo.
pause
`,
        executable: false,
      },
    ]
  }

  const name = platform === 'darwin' ? `Setup ${o.appName}.command` : `setup-${slug(o.appName)}.sh`
  return [
    {
      path: name,
      content: `#!/bin/sh
# Sets up ${o.appName}. Double-click to run.
DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR" || exit 1
"$DIR/runtime/bin/node" "$DIR/dist/scripts/setup.js"
echo ""
printf "Press return to close this window. "
read -r _
`,
      executable: true,
    },
  ]
}

export function launcherFiles(platform: string, o: LauncherOptions): LauncherFile[] {
  if (platform === 'darwin') {
    const app = `Restart ${o.appName}.app`
    return [
      { path: `${app}/Contents/Info.plist`, content: macPlist(o), executable: false },
      { path: `${app}/Contents/MacOS/restart`, content: macScript(o), executable: true },
    ]
  }

  if (platform === 'win32') {
    return [
      {
        path: `Restart ${o.appName}.cmd`,
        content: `@echo off
title Restart ${o.appName}
"${o.nodePath}" "${o.cwd}\\dist\\scripts\\service.js" restart
if errorlevel 1 (
  echo.
  echo Could not restart. The error is shown above.
  pause
)
`,
        executable: false,
      },
    ]
  }

  return [
    {
      path: `restart-${slug(o.appName)}.sh`,
      content: `#!/bin/sh
# Restarts the ${o.appName} background service.
"${o.nodePath}" "${o.cwd}/dist/scripts/service.js" restart
`,
      executable: true,
    },
  ]
}
