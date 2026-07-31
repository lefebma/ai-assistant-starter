/**
 * macOS signing decisions. Pure rules, no I/O, so they can be argued with.
 *
 * Apple's notary service refuses a package if any Mach-O inside it is
 * unsigned, ad-hoc signed, missing the hardened runtime, or carrying
 * `com.apple.security.get-task-allow` (a debug entitlement). A bundle picks up
 * binaries from three places and each needs different treatment:
 *
 *   - native addons (better-sqlite3, @napi-rs/keyring) arrive ad-hoc
 *     "linker-signed" from npm. They must be signed.
 *   - the pinned Node runtime arrives properly Developer ID signed by the
 *     Node.js Foundation, but with get-task-allow set. It must be re-signed
 *     with our own entitlements, minus that one.
 *   - the vendored Claude binary arrives Developer ID signed by Anthropic,
 *     hardened, and clean. Re-signing it would be pointless churn, and
 *     notarisation is happy with another team's valid Developer ID signature.
 *
 * Deciding per binary from what is actually on disk beats a hardcoded list:
 * the dependency tree changes, and a new ad-hoc addon should be caught rather
 * than silently shipped.
 */

export const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/

export interface CodesignInfo {
  /** Ad-hoc or linker-signed, i.e. no real identity. */
  adHoc: boolean
  /** Team identifier, or null when unsigned/ad-hoc. */
  teamId: string | null
  /** Hardened runtime enabled (CodeDirectory flag 0x10000). */
  hardened: boolean
  /** Carries the debug entitlement Apple's notary rejects. */
  hasGetTaskAllow: boolean
}

/**
 * Parse `codesign -dvv` output plus the entitlement keys read separately.
 * Unsigned binaries make codesign exit non-zero; callers pass empty output,
 * which lands here as ad-hoc-equivalent (no identity, needs signing).
 */
export function parseCodesign(output: string, entitlementKeys: string[]): CodesignInfo {
  const adHoc = /Signature\s*=\s*adhoc/.test(output) || /\badhoc\b/.test(output) || output.trim() === ''

  const teamMatch = output.match(/TeamIdentifier\s*=\s*(\S+)/)
  const rawTeam = teamMatch?.[1] ?? null
  const teamId = rawTeam && TEAM_ID_PATTERN.test(rawTeam) ? rawTeam : null

  return {
    adHoc,
    teamId,
    hardened: /flags=0x[0-9a-f]*\(.*\bruntime\b.*\)/.test(output),
    hasGetTaskAllow: entitlementKeys.includes('com.apple.security.get-task-allow'),
  }
}

export type SignAction = 'sign' | 're-sign' | 'skip'

export interface SignDecision {
  action: SignAction
  reason: string
}

export function planBinary(info: CodesignInfo, ourTeamId: string): SignDecision {
  if (info.adHoc || !info.teamId) {
    return { action: 'sign', reason: 'ad-hoc or unsigned — notarisation requires a real Developer ID signature' }
  }

  if (info.hasGetTaskAllow) {
    return {
      action: 're-sign',
      reason: 'carries com.apple.security.get-task-allow, which notarisation rejects',
    }
  }

  if (!info.hardened) {
    return { action: 're-sign', reason: 'hardened runtime is not enabled' }
  }

  return {
    action: 'skip',
    reason:
      info.teamId === ourTeamId
        ? 'already signed by us, hardened, no debug entitlement'
        : `already Developer ID signed by ${info.teamId}, hardened, no debug entitlement`,
  }
}

/**
 * Entitlements for the bundled Node binary. Same set the Node.js Foundation
 * ships minus get-task-allow: V8 needs JIT and writable-executable memory, and
 * library validation must stay off so node can load .node addons that are
 * signed by us rather than by whoever signed node itself.
 */
export function nodeEntitlements(): string {
  const keys = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
    'com.apple.security.cs.disable-executable-page-protection',
    'com.apple.security.cs.allow-dyld-environment-variables',
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${keys.map((k) => `  <key>${k}</key>\n  <true/>`).join('\n')}
</dict>
</plist>
`
}

export interface DistributionOptions {
  title: string
  componentPkg: string
  identifier: string
  version: string
}

/**
 * Installer distribution definition. Home-directory only: the app writes .env,
 * store/ and projects/ inside its own folder, so it belongs to one user, and a
 * home install means the customer is never asked for an admin password.
 */
export function distributionXml(o: DistributionOptions): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>${o.title}</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <choices-outline>
    <line choice="default"/>
  </choices-outline>
  <choice id="default" title="${o.title}">
    <pkg-ref id="${o.identifier}"/>
  </choice>
  <pkg-ref id="${o.identifier}" version="${o.version}">${o.componentPkg}</pkg-ref>
</installer-gui-script>
`
}

/**
 * The last screen of the installer. This is the only instruction the customer
 * is guaranteed to read, and the .pkg deliberately does not launch anything
 * itself, so it has to name exactly one thing to double-click and nothing
 * else. No terminal, no commands.
 */
export function conclusionHtml(o: { appName: string }): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font: 13px -apple-system, sans-serif; margin: 20px; color: #222; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .step { margin: 10px 0; }
  code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
</style></head>
<body>
  <h2>${o.appName} is installed. One more step.</h2>
  <div class="step">1. Open your <b>Applications/${o.appName}</b> folder.</div>
  <div class="step">2. Double-click <b>Setup ${o.appName}.command</b>.</div>
  <div class="step">3. Answer the questions. It will tell you when it is done.</div>
  <p>Setup asks for a few accounts and keys. Have them handy, or leave them blank
  and add them later.</p>
</body>
</html>
`
}
