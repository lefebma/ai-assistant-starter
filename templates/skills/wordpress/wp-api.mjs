#!/usr/bin/env node
// WordPress REST helper — cross-platform, zero dependencies (global fetch).
// Auth: Application Password via HTTP Basic Auth.
// Creds: ~/.config/wordpress/app_password
// All write verbs force status=draft. No publish, no delete.
//
// Usage: node wp-api.mjs <verb> [args]   (run with no args for the verb list)
import { readFileSync, existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homedir } from 'node:os'

const SITE = '{{WP_SITE_URL}}'
const USER = '{{WP_USERNAME}}'
const PW_FILE = join(homedir(), '.config', 'wordpress', 'app_password')

if (!existsSync(PW_FILE)) {
  console.error(`error: password file not found at ${PW_FILE}`)
  console.error(`Generate an Application Password at ${SITE}/wp-admin/profile.php and save it there`)
  process.exit(2)
}
const PW = readFileSync(PW_FILE, 'utf-8').trim()
const AUTH = `Basic ${Buffer.from(`${USER}:${PW}`).toString('base64')}`

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${SITE}/wp-json${path}`, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body } : {}),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

const out = (o) => console.log(JSON.stringify(o, null, 2))
const die = (msg, code = 2) => {
  console.error(msg)
  process.exit(code)
}

function flags(args) {
  const map = {}
  for (const arg of args) {
    const m = /^--([a-z]+)=(.*)$/s.exec(arg)
    if (!m) die(`unknown arg: ${arg}`)
    map[m[1]] = m[2]
  }
  return map
}

function readContent(src) {
  if (src === '-') return readFileSync(0, 'utf-8')
  if (existsSync(src)) return readFileSync(src, 'utf-8')
  die(`content source not found: ${src}`)
}

const summary = (p) => ({
  id: p.id,
  status: p.status,
  link: p.link,
  edit_link: `${SITE}/wp-admin/post.php?post=${p.id}&action=edit`,
  title: p.title?.rendered,
})
const fullDoc = (type, p) => ({
  type,
  id: p.id,
  slug: p.slug,
  status: p.status,
  link: p.link,
  title: p.title?.rendered,
  excerpt: p.excerpt?.raw,
  content_raw: p.content?.raw,
  content_rendered: p.content?.rendered,
  modified: p.modified,
})
const listLine = (p) => `${p.id}\t${p.status}\t${p.slug}\t${p.title?.rendered ?? ''}`

const USAGE = `wp-api.mjs <verb> [args]

Read verbs:
  test                         Auth check (GET /users/me)
  list-pages [N]               List up to N pages (default 50)
  list-posts [N] [status]      List up to N posts (default 20, status=any)
  get <id>                     Full page/post content (tries page, falls back to post)
  get-by-slug <slug>           Find page or post by slug, return full content
  seo <id>                     Yoast meta (title, description, robots, schema)

Write verbs (all produce drafts):
  draft-post --title=<t> --content=<file_or_-> [--excerpt=<e>] [--tags=id,id] [--categories=id,id]
  update-draft <id> [--title=<t>] [--content=<file_or_->] [--excerpt=<e>]
  upload-media <file> [--alt=<text>] [--title=<title>]`

const [verb, ...rest] = process.argv.slice(2)

switch (verb) {
  case 'test': {
    const { json } = await api('GET', '/wp/v2/users/me?context=edit')
    out({ id: json?.id, username: json?.username, name: json?.name, roles: json?.roles })
    break
  }
  case 'list-pages': {
    const n = rest[0] ?? '50'
    const { json } = await api('GET', `/wp/v2/pages?per_page=${n}&status=any&_fields=id,slug,status,title,link,modified`)
    for (const p of json ?? []) console.log(listLine(p))
    break
  }
  case 'list-posts': {
    const n = rest[0] ?? '20'
    const status = rest[1] ?? 'any'
    const { json } = await api('GET', `/wp/v2/posts?per_page=${n}&status=${status}&_fields=id,slug,status,title,link,modified`)
    for (const p of json ?? []) console.log(listLine(p))
    break
  }
  case 'get': {
    const id = rest[0] ?? die('need id')
    let res = await api('GET', `/wp/v2/pages/${id}?context=edit`)
    let type = 'page'
    if (!res.json?.id) {
      res = await api('GET', `/wp/v2/posts/${id}?context=edit`)
      type = 'post'
    }
    out(fullDoc(type, res.json ?? {}))
    break
  }
  case 'get-by-slug': {
    const slug = rest[0] ?? die('need slug')
    const fields = '_fields=id,slug,status,title,link,content,excerpt,modified'
    const page = await api('GET', `/wp/v2/pages?slug=${slug}&context=edit&${fields}`)
    if ((page.json ?? []).length > 0) out(fullDoc('page', page.json[0]))
    else {
      const post = await api('GET', `/wp/v2/posts?slug=${slug}&context=edit&${fields}`)
      out(fullDoc('post', (post.json ?? [])[0] ?? {}))
    }
    break
  }
  case 'seo': {
    const id = rest[0] ?? die('need id')
    let res = await api('GET', `/wp/v2/pages/${id}?_fields=yoast_head_json,title`)
    if (!res.json?.yoast_head_json) res = await api('GET', `/wp/v2/posts/${id}?_fields=yoast_head_json,title`)
    out({ title: res.json?.title?.rendered, seo: res.json?.yoast_head_json })
    break
  }
  case 'draft-post': {
    const f = flags(rest)
    if (!f.title) die('--title required')
    if (!f.content) die('--content required (path or -)')
    const payload = {
      status: 'draft',
      title: f.title,
      content: readContent(f.content),
      ...(f.excerpt ? { excerpt: f.excerpt } : {}),
      ...(f.tags ? { tags: f.tags.split(',').map(Number) } : {}),
      ...(f.categories ? { categories: f.categories.split(',').map(Number) } : {}),
    }
    const { json } = await api('POST', '/wp/v2/posts', JSON.stringify(payload))
    out(summary(json ?? {}))
    break
  }
  case 'update-draft': {
    const id = rest[0] ?? die('need id')
    const cur = await api('GET', `/wp/v2/posts/${id}?_fields=status,type`)
    if (!cur.json?.status) die(`error: post ${id} not found (this verb only edits posts, not pages)`, 3)
    if (cur.json.status !== 'draft') {
      die(`error: post ${id} has status=${cur.json.status}. Only drafts can be updated via this skill.`, 3)
    }
    const f = flags(rest.slice(1))
    const payload = {
      status: 'draft',
      ...(f.title ? { title: f.title } : {}),
      ...(f.content ? { content: readContent(f.content) } : {}),
      ...(f.excerpt ? { excerpt: f.excerpt } : {}),
    }
    const { json } = await api('POST', `/wp/v2/posts/${id}`, JSON.stringify(payload))
    out(summary(json ?? {}))
    break
  }
  case 'upload-media': {
    const file = rest[0] ?? die('need file')
    if (!existsSync(file)) die(`file not found: ${file}`)
    const f = flags(rest.slice(1))
    const MIME = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
    }
    const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
    let res = await api('POST', '/wp/v2/media', readFileSync(file), {
      'Content-Disposition': `attachment; filename="${basename(file)}"`,
      'Content-Type': mime,
    })
    const mediaId = res.json?.id
    if (!mediaId) {
      out(res.json)
      process.exit(4)
    }
    if (f.alt || f.title) {
      const meta = { ...(f.alt ? { alt_text: f.alt } : {}), ...(f.title ? { title: f.title } : {}) }
      res = await api('POST', `/wp/v2/media/${mediaId}`, JSON.stringify(meta))
    }
    const m = res.json ?? {}
    out({ id: m.id, source_url: m.source_url, mime_type: m.mime_type, alt_text: m.alt_text, title: m.title?.rendered })
    break
  }
  case undefined:
  case '-h':
  case '--help':
  case 'help':
    console.log(USAGE)
    break
  default:
    console.error(`unknown verb: ${verb}`)
    console.log(USAGE)
    process.exit(2)
}
