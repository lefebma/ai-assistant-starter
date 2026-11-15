/**
 * Where a mailbox's IMAP and SMTP servers are, worked out from its address.
 *
 * Everything here signs in with an app password, not the account password:
 * Yahoo, AOL and iCloud all refuse a plain password over IMAP once two-step
 * sign-in is on, and an app password is revocable on its own without touching
 * the account. Outlook.com is deliberately not a preset: it has a better path
 * in this product (the Microsoft sign-in) and has switched basic IMAP sign-in
 * off entirely. Gmail is a preset only when asked for (card #204): its normal
 * path is /connect gmail, which also covers the calendar, and an app password
 * is the mail-only backup for when that path can't be used.
 */

export interface ServerEndpoint {
  host: string
  port: number
  /**
   * TLS from the first byte (993/465). False means STARTTLS on a submission
   * port, and the client then refuses to continue without the upgrade.
   */
  secure: boolean
}

export interface ImapPreset {
  provider: string
  imap: ServerEndpoint
  smtp: ServerEndpoint
  /**
   * Whether the provider files a copy in Sent by itself when mail goes out
   * over its SMTP server. When it does not, the send command appends one, so
   * the owner's Sent folder shows what their assistant sent.
   */
  savesSent: boolean
  /** Where the owner makes an app password, in words they can follow. */
  appPasswordHelp: string
}

/** An address that belongs on another connector, with the reason to give. */
export interface Redirect {
  redirect: 'gmail' | 'outlook'
  message: string
}

const YAHOO: ImapPreset = {
  provider: 'Yahoo Mail',
  imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
  savesSent: false,
  appPasswordHelp:
    'Yahoo: open login.yahoo.com, go to Account Info > Account security, choose "Generate app password", name it after the assistant, and copy the password it shows.',
}

const AOL: ImapPreset = {
  provider: 'AOL Mail',
  imap: { host: 'imap.aol.com', port: 993, secure: true },
  smtp: { host: 'smtp.aol.com', port: 465, secure: true },
  savesSent: false,
  appPasswordHelp:
    'AOL: open login.aol.com, go to Account Info > Account security, choose "Generate app password", and copy the password it shows.',
}

const ICLOUD: ImapPreset = {
  provider: 'iCloud Mail',
  imap: { host: 'imap.mail.me.com', port: 993, secure: true },
  smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
  savesSent: false,
  appPasswordHelp:
    'iCloud: open account.apple.com, go to Sign-In and Security > App-Specific Passwords, create one named after the assistant, and copy it.',
}

const FASTMAIL: ImapPreset = {
  provider: 'Fastmail',
  imap: { host: 'imap.fastmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
  savesSent: false,
  appPasswordHelp:
    'Fastmail: Settings > Privacy & Security > Integrations > New app password, with IMAP and SMTP access.',
}

const GMX: ImapPreset = {
  provider: 'GMX',
  imap: { host: 'imap.gmx.com', port: 993, secure: true },
  smtp: { host: 'mail.gmx.com', port: 465, secure: true },
  savesSent: false,
  appPasswordHelp: 'GMX: Settings > POP3 & IMAP, switch IMAP access on, then use an application-specific password.',
}

const ZOHO: ImapPreset = {
  provider: 'Zoho Mail',
  imap: { host: 'imap.zoho.com', port: 993, secure: true },
  smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
  savesSent: false,
  appPasswordHelp: 'Zoho: My Account > Security > App Passwords > Generate New Password.',
}

const GMAIL: ImapPreset = {
  provider: 'Gmail',
  imap: { host: 'imap.gmail.com', port: 993, secure: true },
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  // Gmail files its own Sent copy for mail sent through smtp.gmail.com.
  savesSent: true,
  appPasswordHelp:
    'Gmail (mail only, no calendar): two-step sign-in must be on. Open myaccount.google.com/apppasswords, name it after the assistant, and copy the 16-letter password. ' +
    'Google does not offer app passwords on work or school accounts, with Advanced Protection, or when two-step sign-in uses only security keys. For those, use /connect gmail.',
}

function domainOf(address: string): string {
  const at = address.lastIndexOf('@')
  return at === -1 ? '' : address.slice(at + 1).trim().toLowerCase()
}

export function isGmailAddress(address: string): boolean {
  const d = domainOf(address)
  return d === 'gmail.com' || d === 'googlemail.com'
}

/**
 * The preset for an address, a redirect to the connector that should own it,
 * or null when the domain is unknown and the servers have to be given.
 * `gmailAppPassword` is the owner choosing mail only by app password.
 */
export function presetFor(address: string, opts: { gmailAppPassword?: boolean } = {}): ImapPreset | Redirect | null {
  const d = domainOf(address)
  if (!d) return null
  if (isGmailAddress(address)) {
    if (opts.gmailAppPassword) return GMAIL
    return {
      redirect: 'gmail',
      message:
        `${address} is a Gmail address. Connect it with /connect gmail: one sign-in with Google, covering mail and calendar, with no app password. ` +
        `Only if the owner asks for mail only by app password (or /connect gmail can't be used), run add again with --app-password.`,
    }
  }
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(d)) {
    return {
      redirect: 'outlook',
      message: `${address} is a Microsoft address, and Microsoft has switched off app-password sign-in for it. Connect it with the Outlook skill instead (ms-auth start --account ${address}).`,
    }
  }
  if (/^(yahoo|ymail|rocketmail)\.[a-z.]+$/.test(d)) return YAHOO
  if (d === 'aol.com' || d === 'aim.com' || d === 'verizon.net') return AOL
  if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return ICLOUD
  if (d === 'fastmail.com' || d === 'fastmail.fm') return FASTMAIL
  if (d === 'gmx.com' || d === 'gmx.net' || d === 'gmx.us') return GMX
  if (d === 'zoho.com' || d === 'zohomail.com') return ZOHO
  return null
}

export function isRedirect(p: ImapPreset | Redirect | null): p is Redirect {
  return p !== null && 'redirect' in p
}

/** Names for the help text, in the order an owner is likely to ask. */
export const PRESET_PROVIDERS = ['Yahoo', 'AOL', 'iCloud', 'Fastmail', 'GMX', 'Zoho']
