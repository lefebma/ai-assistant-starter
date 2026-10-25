/**
 * What a tool call would send over the network (card #233): the requests a
 * shell command or browser script makes that change something (POST, PUT,
 * PATCH, DELETE, a form submit), with the host when it can be read.
 *
 * The gate uses this to hold a read-only role to reading and chat to its
 * approved hosts. It reads the method from the command, which the egress
 * proxy cannot do over HTTPS. Reads are not reported: where a tool may read
 * is the egress allowlist's job (#231).
 *
 * Lexical, like the evasion monitor: a URL built at run time or a binary
 * that posts on its own is invisible here. A write whose host cannot be read
 * is reported with host null; a read-only role refuses it, chat lets it pass.
 */

export type NetWrite = {
  method: string
  /** null when the destination is not written out literally. */
  host: string | null
  port: number | null
  /** What carries it: curl, wget, httpie, node, python, browser. */
  via: string
}

const WRITE_METHODS = /^(?:POST|PUT|PATCH|DELETE)$/

/** Shell words, per simple command. Quotes group, backslash escapes, ; && || | and newlines split. */
export function shellCommands(cmd: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false
  const word = () => { if (has) words.push(cur); cur = ''; has = false }
  const end = () => { word(); if (words.length) out.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'" || c === '"') {
      const j = cmd.indexOf(c, i + 1)
      cur += cmd.slice(i + 1, j < 0 ? cmd.length : j)
      has = true
      i = j < 0 ? cmd.length : j
    } else if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true }
    else if (c === ' ' || c === '\t') word()
    else if (c === ';' || c === '\n' || c === '|' || c === '&') { if (cmd[i + 1] === c) i++; end() }
    else { cur += c; has = true }
  }
  end()
  return out
}

export type FetchCall = { url: string; method: string; body?: string; follow: boolean }

/** fetch('url', {method, body}) calls written out literally in JS source. */
export function fetchCalls(src: string): FetchCall[] {
  const out: FetchCall[] = []
  for (const m of src.matchAll(/fetch\(\s*(['"`])([^'"`]+)\1\s*(?:,\s*\{([^}]*)\})?\s*\)/g)) {
    const opts = m[3] ?? ''
    const method = /method\s*:\s*['"`](\w+)['"`]/.exec(opts)?.[1]?.toUpperCase() ?? 'GET'
    const body = /body\s*:\s*(['"`])([^'"`]*)\1/.exec(opts)?.[2]
    out.push({ url: m[2], method, body, follow: true })
  }
  return out
}

/** Host and port of a URL or bare host[:port][/path]; nulls when it does not parse. */
export function hostOf(target: string): { host: string | null; port: number | null } {
  const withScheme = /^[a-z][\w+.-]*:\/\//i.test(target) ? target : `http://${target}`
  try {
    const u = new URL(withScheme)
    if (!u.hostname) return { host: null, port: null }
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null
    return { host: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port }
  } catch {
    return { host: null, port: null }
  }
}

const URLISH = /^[a-z][\w+.-]*:\/\//i
const BARE_HOST = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i

// curl short options that take a value (so the next word is not the URL).
const CURL_SHORT_VALUE = new Set(['X', 'd', 'F', 'T', 'H', 'o', 'u', 'A', 'e', 'b', 'c', 'K', 'w', 'x', 'y', 'z', 'm', 'E', 'C', 'r', 'U', 'Y', 'D', 'Q', 't', 'P'])
const CURL_LONG_VALUE = new Set(['--request', '--data', '--data-binary', '--data-raw', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string', '--upload-file',
  '--header', '--output', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar', '--config', '--write-out', '--proxy', '--max-time', '--connect-timeout',
  '--cert', '--key', '--cacert', '--resolve', '--connect-to', '--url', '--retry', '--range', '--limit-rate', '--max-filesize', '--interface'])
const CURL_DATA_LONG = new Set(['--data', '--data-binary', '--data-raw', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string'])

function curlWrites(w: string[]): NetWrite[] {
  let method: string | undefined
  let data = false
  let upload = false
  let get = false
  const targets: string[] = []
  for (let i = 1; i < w.length; i++) {
    const a = w[i]
    if (a.startsWith('--')) {
      const [name, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
      const value = () => inline ?? w[++i]
      if (name === '--request') method = value()?.toUpperCase()
      else if (CURL_DATA_LONG.has(name)) { data = true; value() }
      else if (name === '--upload-file') { upload = true; value() }
      else if (name === '--get') get = true
      else if (name === '--head') method = 'HEAD'
      else if (name === '--url') { const v = value(); if (v) targets.push(v) }
      else if (CURL_LONG_VALUE.has(name) && inline === undefined) i++
    } else if (/^-[a-zA-Z0-9]+/.test(a)) {
      // A cluster like -sSL or -XPOST or -d@file: walk it, a value-taking letter ends it.
      for (let k = 1; k < a.length; k++) {
        const f = a[k]
        if (f === 'G') get = true
        if (f === 'I') method = 'HEAD'
        if (!CURL_SHORT_VALUE.has(f)) continue
        const rest = a.slice(k + 1)
        const v = rest || w[++i]
        if (f === 'X') method = v?.toUpperCase()
        else if (f === 'd' || f === 'F') data = true
        else if (f === 'T') upload = true
        break
      }
    } else if (URLISH.test(a) || BARE_HOST.test(a)) targets.push(a)
  }
  const m = method ?? (get ? 'GET' : upload ? 'PUT' : data ? 'POST' : 'GET')
  if (!WRITE_METHODS.test(m)) return []
  return (targets.length ? targets : ['']).map((t) => ({ method: m, ...(t ? hostOf(t) : { host: null, port: null }), via: 'curl' }))
}

function wgetWrites(w: string[]): NetWrite[] {
  let method: string | undefined
  let body = false
  const targets: string[] = []
  for (let i = 1; i < w.length; i++) {
    const a = w[i]
    const [name, inline] = a.includes('=') && a.startsWith('--') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    if (name === '--post-data' || name === '--post-file' || name === '--body-data' || name === '--body-file') { body = true; if (inline === undefined) i++ }
    else if (name === '--method') method = (inline ?? w[++i])?.toUpperCase()
    else if (URLISH.test(a) || BARE_HOST.test(a)) targets.push(a)
  }
  const m = method ?? (body ? 'POST' : 'GET')
  if (!WRITE_METHODS.test(m)) return []
  return (targets.length ? targets : ['']).map((t) => ({ method: m, ...(t ? hostOf(t) : { host: null, port: null }), via: 'wget' }))
}

/** httpie / xh: `http POST host/path a=1`, or data items alone imply POST. */
function httpieWrites(w: string[]): NetWrite[] {
  const args = w.slice(1).filter((a) => !a.startsWith('-'))
  let method: string | undefined
  if (args[0] && /^[A-Z]+$/.test(args[0])) method = args.shift()
  const target = args.shift()
  const items = args.some((a) => /^[^=:@]+(?::=|==|=|@)/.test(a) && !/^[^=]+==/.test(a))
  const m = method ?? (items ? 'POST' : 'GET')
  if (!WRITE_METHODS.test(m) || !target) return []
  return [{ method: m, ...hostOf(target.startsWith(':') ? `localhost${target}` : target), via: 'httpie' }]
}

/** Writes in JavaScript source: fetch, XMLHttpRequest, sendBeacon, axios, form submits. */
export function scriptWrites(src: string, via: string): NetWrite[] {
  const out: NetWrite[] = []
  for (const f of fetchCalls(src)) if (WRITE_METHODS.test(f.method)) out.push({ method: f.method, ...hostOf(f.url), via })
  // fetch(someVariable, { method: 'POST' }): a write, destination unknown.
  for (const m of src.matchAll(/fetch\(\s*[^'"`\s][^,)]*,\s*\{[^}]*method\s*:\s*['"`](\w+)['"`]/g)) {
    if (WRITE_METHODS.test(m[1].toUpperCase())) out.push({ method: m[1].toUpperCase(), host: null, port: null, via })
  }
  for (const m of src.matchAll(/\.open\(\s*['"`](\w+)['"`]\s*,\s*(?:(['"`])([^'"`]+)\2)?/g)) {
    if (WRITE_METHODS.test(m[1].toUpperCase())) out.push({ method: m[1].toUpperCase(), ...(m[3] ? hostOf(m[3]) : { host: null, port: null }), via })
  }
  for (const m of src.matchAll(/sendBeacon\(\s*(?:(['"`])([^'"`]+)\1)?/g)) out.push({ method: 'POST', ...(m[2] ? hostOf(m[2]) : { host: null, port: null }), via })
  for (const m of src.matchAll(/axios\.(post|put|patch|delete)\(\s*(?:(['"`])([^'"`]+)\2)?/gi)) out.push({ method: m[1].toUpperCase(), ...(m[3] ? hostOf(m[3]) : { host: null, port: null }), via })
  if (/\.(?:submit|requestSubmit)\(\s*\)/.test(src)) out.push({ method: 'POST', host: null, port: null, via })
  return out
}

/** Writes in Python source: requests / httpx calls, urllib with data. */
function pythonWrites(src: string): NetWrite[] {
  const out: NetWrite[] = []
  for (const m of src.matchAll(/\b(?:requests|httpx|session|client)\.(post|put|patch|delete)\(\s*(?:(['"])([^'"]+)\2)?/gi)) {
    out.push({ method: m[1].toUpperCase(), ...(m[3] ? hostOf(m[3]) : { host: null, port: null }), via: 'python' })
  }
  for (const m of src.matchAll(/\b(?:requests|httpx)\.request\(\s*(['"])(\w+)\1\s*,\s*(?:(['"])([^'"]+)\3)?/gi)) {
    if (WRITE_METHODS.test(m[2].toUpperCase())) out.push({ method: m[2].toUpperCase(), ...(m[4] ? hostOf(m[4]) : { host: null, port: null }), via: 'python' })
  }
  return out
}

/** Writes a shell command makes: curl, wget, httpie, and inline node / python. */
export function shellWrites(command: string): NetWrite[] {
  const out: NetWrite[] = []
  for (const raw of shellCommands(command)) {
    // Leading VAR=value assignments and wrappers like env, sudo, timeout.
    let w = raw
    while (w.length && (/^[A-Za-z_]\w*=/.test(w[0]) || w[0] === 'env' || w[0] === 'sudo' || w[0] === 'command' || w[0] === 'exec')) w = w.slice(1)
    if (w[0] === 'timeout' && w.length > 2) w = w.slice(2)
    const prog = w[0]?.split('/').pop() ?? ''
    if (prog === 'curl') out.push(...curlWrites(w))
    else if (prog === 'wget') out.push(...wgetWrites(w))
    else if (prog === 'http' || prog === 'https' || prog === 'xh' || prog === 'xhs') out.push(...httpieWrites(w))
    else if ((prog === 'node' || prog === 'bun' || prog === 'deno') && (w[1] === '-e' || w[1] === '--eval' || w[1] === '-p')) out.push(...scriptWrites(w[2] ?? '', 'node'))
    else if (/^python[\d.]*$/.test(prog) && w[1] === '-c') out.push(...pythonWrites(w[2] ?? ''))
  }
  return out
}

/** Browser tools whose arguments can send something. */
function browserTool(tool: string): string | null {
  const m = /^mcp__.*playwright.*__(browser_\w+)$/.exec(tool)
  return m ? m[1] : null
}

/**
 * Network writes a tool call would make. Bash (either runtime's name), and the
 * Playwright browser tools: scripts are read for requests and form submits,
 * and filling a form or uploading a file count as a submit to the page.
 */
export function netWrites(tool: string, input: unknown): NetWrite[] {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (tool === 'Bash' || tool === 'bash') return typeof o.command === 'string' ? shellWrites(o.command) : []
  const b = browserTool(tool)
  if (!b) return []
  if (b === 'browser_evaluate' || b === 'browser_run_code' || b === 'browser_run_code_unsafe') {
    const src = [o.function, o.code].find((v): v is string => typeof v === 'string') ?? ''
    return scriptWrites(src, 'browser')
  }
  if (b === 'browser_fill_form' || b === 'browser_file_upload') return [{ method: 'POST', host: null, port: null, via: 'browser' }]
  return []
}
