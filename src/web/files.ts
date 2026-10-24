/**
 * File tree containment for the web app. Everything the browser can list or
 * read goes through `resolveVisible`, which answers null for anything hidden,
 * outside the root, or malformed. Callers turn null into a plain 404 so a
 * hidden file and a missing file look the same.
 *
 * Rules (spec section 12): no absolute paths, NUL, backslashes or `..`
 * segments (checked again after one more decode, for `%2e%2e` that survived
 * the first); no hidden segment, either in the path as written or in the
 * realpath relative to the root (which catches a symlink inside root that
 * points at `store/`); and the realpath must stay inside the realpath of root.
 */
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { NEVER_SEND } from '../outbound-files.js'
import { UPLOADS_DIR } from '../media.js'

export const HIDDEN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'store',
  'src',
  'scripts',
  'tests',
  'templates',
  'deploy',
  'coverage',
  'public',
  '.claude',
  // Operational data. Logs and support bundles cover every chat on the box,
  // and a shared workspace clone holds its git deploy key.
  'logs',
  'support-requests',
  'certification',
  'workspaces',
  'dist-installer',
])

/** Single files hidden by name: gitignored at the root, and not caught by NEVER_SEND. */
const HIDDEN_NAMES = /^(roles\.json|key_pair\.txt(\..*)?)$/i

export const MAX_LIST_ENTRIES = 500

interface FileRoots {
  root: string
  uploadsDir: string
}
let roots: FileRoots = { root: PROJECT_ROOT, uploadsDir: UPLOADS_DIR }

/** Test hook: point the file routes at a fixture. Pass null to restore. */
export function setFileRootsForTest(next: FileRoots | null): void {
  roots = next ?? { root: PROJECT_ROOT, uploadsDir: UPLOADS_DIR }
}
export function getFileRoots(): FileRoots {
  return roots
}

export function isHiddenSegment(seg: string): boolean {
  if (seg.startsWith('.')) return true
  if (HIDDEN_DIRS.has(seg.toLowerCase())) return true
  if (HIDDEN_NAMES.test(seg)) return true
  return NEVER_SEND.some((re) => re.test(seg))
}

function contains(parent: string, child: string): boolean {
  const base = parent.endsWith(sep) ? parent : parent + sep
  return child === parent || child.startsWith(base)
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s)
  } catch {
    return null
  }
}

export interface Visible {
  abs: string
  rel: string
  isDir: boolean
}

export function resolveVisible(relPath: string, root: string = roots.root): Visible | null {
  if (typeof relPath !== 'string' || relPath.length > 1024) return null
  if (relPath.includes('\0') || relPath.includes('\\')) return null
  if (isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('~')) return null

  const trimmed = relPath.replace(/\/+$/, '')
  const segments = trimmed === '' ? [] : trimmed.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null
    // The query is decoded once already. A segment that decodes again to
    // something dangerous was an attempt to smuggle it past that decode.
    const again = safeDecode(seg)
    if (again === null) return null
    if (again === '.' || again === '..' || again.includes('\0') || again.includes('\\') || again.includes('/')) return null
    if (isHiddenSegment(seg)) return null
  }

  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  const target = resolve(realRoot, ...segments)
  if (!contains(realRoot, target)) return null

  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return null
  }
  if (!contains(realRoot, real)) return null
  const realRel = relative(realRoot, real)
  if (realRel !== '' && realRel.split(sep).some(isHiddenSegment)) return null

  let isDir: boolean
  try {
    const st = statSync(real)
    if (!st.isDirectory() && !st.isFile()) return null
    isDir = st.isDirectory()
  } catch {
    return null
  }
  return { abs: real, rel: segments.join('/'), isDir }
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedAt: number
}

/** List a visible directory. Null when the path is hidden, missing or not a directory. */
export function listDir(relPath: string, root: string = roots.root): { entries: DirEntry[] } | null {
  const dir = resolveVisible(relPath, root)
  if (!dir || !dir.isDir) return null
  let names: string[]
  try {
    names = readdirSync(dir.abs)
  } catch {
    return null
  }
  const entries: DirEntry[] = []
  for (const name of names) {
    if (isHiddenSegment(name)) continue
    const childRel = dir.rel ? `${dir.rel}/${name}` : name
    const child = resolveVisible(childRel, root)
    if (!child) continue
    try {
      const st = statSync(child.abs)
      entries.push({ name, path: childRel, isDir: child.isDir, size: child.isDir ? 0 : st.size, modifiedAt: Math.floor(st.mtimeMs) })
    } catch {
      // vanished while listing
    }
  }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return { entries: entries.slice(0, MAX_LIST_ENTRIES) }
}

/** Upload name: replace anything outside [\w.\- ], never start with a dot, at most 120 chars. */
export function sanitizeUploadName(raw: string): string {
  let name = raw.replace(/\0/g, '').replace(/[^\w.\- ]/g, '_').trim()
  if (name.startsWith('.')) name = '_' + name
  name = name.slice(0, 120)
  return name === '' ? '' : name
}
