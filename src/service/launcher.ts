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
 * On macOS and Windows it opens the web setup in the browser (card #215):
 * `setup-web --background` starts the setup page detached and exits, so no
 * terminal stays open. macOS gets a small script-backed .app, which Finder
 * runs without Terminal at all; it never scripts Terminal, so there is no
 * "wants to control Terminal" consent prompt. Windows gets a .cmd whose
 * console closes as soon as the page is up, and stays open with a message
 * only when something went wrong. The terminal wizard is still there for
 * anyone who wants it (`dist/scripts/setup.js`), and is what Linux gets.
 *
 * Paths resolve relative to the launcher's own location: the installer
 * chooses where this lands, and the customer may move the folder later.
 */
export function setupLauncherFiles(platform: string, o: SetupLauncherOptions): LauncherFile[] {
  if (platform === 'darwin') {
    const app = `Setup ${o.appName}.app`
    return [
      { path: `${app}/Contents/Info.plist`, content: setupPlist(o), executable: false },
      { path: `${app}/Contents/MacOS/setup`, content: macSetupScript(o), executable: true },
    ]
  }

  if (platform === 'win32') {
    return [
      {
        path: `Setup ${o.appName}.cmd`,
        content: `@echo off
title Set up ${o.appName}
cd /d "%~dp0"
echo Opening ${o.appName} setup in your web browser...
"%~dp0runtime\\node.exe" "%~dp0dist\\scripts\\setup-web.js" --background
if errorlevel 4 (
  echo.
  echo Something else is using the setup port. If ${o.appName} is already running, setup is done.
  pause
  exit /b
)
if errorlevel 3 (
  echo.
  echo ${o.appName} is already set up. To change settings, ask your assistant in chat.
  pause
  exit /b
)
if errorlevel 1 (
  echo.
  echo Setup could not start. Details are in logs\\setup-web.log in this folder.
  pause
)
`,
        executable: false,
      },
    ]
  }

  return [
    {
      path: `setup-${slug(o.appName)}.sh`,
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

function setupPlist(o: SetupLauncherOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Setup ${o.appName}</string>
  <key>CFBundleIdentifier</key>
  <string>com.${slug(o.appName)}.setup</string>
  <key>CFBundleExecutable</key>
  <string>setup</string>
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

function macSetupScript(o: SetupLauncherOptions): string {
  // Fixed messages per exit code, passed to osascript as an argument rather
  // than spliced into the AppleScript, so no output ever needs quoting.
  return `#!/bin/sh
# Opens ${o.appName} setup in the web browser. Double-click this app to run it.
# The install folder is three levels up: <folder>/Setup ${o.appName}.app/Contents/MacOS.
DIR=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$DIR" || exit 1
"$DIR/runtime/bin/node" "$DIR/dist/scripts/setup-web.js" --background >/dev/null 2>&1
case $? in
  0) exit 0 ;;
  3) MSG="${o.appName} is already set up. To change settings, ask your assistant in chat." ;;
  4) MSG="Something else is using the setup port. If ${o.appName} is already running, setup is done." ;;
  *) MSG="Setup could not start. Details are in logs/setup-web.log inside the ${o.appName} folder." ;;
esac
osascript -e 'on run argv' -e 'display dialog (item 1 of argv) with title "${o.appName}" buttons {"OK"} default button "OK"' -e 'end run' "$MSG"
`
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
