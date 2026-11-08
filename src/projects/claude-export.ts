/**
 * Claude export parser (card #280). Reads the `projects-000.zip` a customer
 * downloads from Claude and uploads here. The file may be hostile, so:
 *
 * - only entries named `projects/<name>.json`, or that one folder down, are
 *   read, into memory; an entry's name is matched and then dropped, never
 *   used as a path;
 * - sizes are checked against what the zip declares and again against the
 *   bytes that really come out of the inflater, and the first limit passed
 *   stops the read and refuses the file;
 * - the zip is closed on every path out.
 *
 * Nothing here logs: names and content are the customer's.
 */
import { open as openFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import yauzl from 'yauzl'

export interface ExportDoc { filename: string; content: string }

export interface ExportProject {
  uuid: string
  name: string
  description: string
  template: string
  starter: boolean
  docs: ExportDoc[]
}

export type ParseError = 'manifest' | 'not_projects' | 'too_large' | 'corrupt'

export type ParseResult =
  | { ok: true; projects: ExportProject[]; unreadable: number }
  | { ok: false; code: ParseError }

export const ZIP_LIMITS = { entries: 2000, entryBytes: 50 * 1024 * 1024, totalBytes: 500 * 1024 * 1024 }

let limits = { ...ZIP_LIMITS }

/** Test hook: lower the limits. Omitted keys keep the real value; null resets all. */
export function setZipLimitsForTest(next: Partial<typeof ZIP_LIMITS> | null): void {
  limits = { ...ZIP_LIMITS, ...(next ?? {}) }
}

/**
 * `projects/<name>.json`, or one folder down: a Mac unzips the download into
 * `projects-000/`, and Compress keeps that folder. Compress also adds
 * `__MACOSX/` and `._<name>` companions, which are not projects.
 */
const PROJECT_ENTRY = /^(?!__MACOSX\/)(?:[^/]+\/)?projects\/(?!\._)[^/]+\.json$/

/** The manifest of download links is small; anything bigger is not one. */
const MANIFEST_MAX_BYTES = 5 * 1024 * 1024
const HEAD_BYTES = 64

const fail = (code: ParseError): ParseResult => ({ ok: false, code })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}

/** The export's manifest: a JSON object with a `data_files` array of download links. */
export function isManifest(buf: Buffer): boolean {
  const v = parseJson(buf)
  return isObject(v) && Array.isArray(v.data_files)
}

/** True when the file starts like JSON (after a BOM and whitespace) rather than a zip. */
function startsLikeJson(head: Buffer): boolean {
  const text = head.toString('utf8').replace(/^﻿/, '').trimStart()
  return text.startsWith('{') || text.startsWith('[')
}

/** One `projects/<uuid>.json`. Null when it cannot be read; non-string fields count as absent. */
function toProject(buf: Buffer): ExportProject | null {
  const v = parseJson(buf)
  if (!isObject(v) || typeof v.uuid !== 'string' || v.uuid === '') return null
  const docs: ExportDoc[] = []
  if (Array.isArray(v.docs)) {
    for (const d of v.docs) {
      if (isObject(d) && typeof d.content === 'string') docs.push({ filename: str(d.filename), content: d.content })
    }
  }
  return {
    uuid: v.uuid,
    name: str(v.name),
    description: str(v.description),
    template: str(v.prompt_template),
    starter: v.is_starter_project === true,
    docs,
  }
}

/** Parse a Claude projects export. A manifest JSON passed by mistake answers `manifest`. */
export async function parseClaudeExport(zipPath: string): Promise<ParseResult> {
  let head: Buffer
  let size: number
  try {
    const fh = await openFile(zipPath, 'r')
    try {
      size = (await fh.stat()).size
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0)
      head = buffer.subarray(0, bytesRead)
      if (startsLikeJson(head)) {
        if (size > MANIFEST_MAX_BYTES) return fail('corrupt')
        const whole = Buffer.alloc(size)
        const { bytesRead: n } = await fh.read(whole, 0, size, 0)
        return isManifest(whole.subarray(0, n)) ? fail('manifest') : fail('corrupt')
      }
    } finally {
      await fh.close()
    }
  } catch {
    return fail('corrupt')
  }
  return readZip(zipPath)
}

function readZip(zipPath: string): Promise<ParseResult> {
  return new Promise(resolve => {
    // decodeStrings off: yauzl would otherwise refuse the whole zip over one
    // `../x` name. We match the raw name ourselves and never use it as a path.
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true, decodeStrings: false, autoClose: false }, (openErr, zip) => {
      if (openErr || !zip) return resolve(fail('corrupt'))

      let settled = false
      let stream: Readable | null = null
      let seen = 0
      let matched = 0
      let total = 0
      let unreadable = 0
      const projects: ExportProject[] = []

      const finish = (result: ParseResult) => {
        if (settled) return
        settled = true
        if (stream) stream.destroy()
        stream = null
        zip.close()
        resolve(result)
      }

      zip.on('error', () => finish(fail('corrupt')))
      zip.on('end', () => finish(matched === 0 ? fail('not_projects') : { ok: true, projects, unreadable }))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (settled) return
        seen += 1
        if (seen > limits.entries) return finish(fail('too_large'))

        if (!PROJECT_ENTRY.test(entry.fileNameRaw.toString('utf8'))) return zip.readEntry()
        matched += 1
        if (entry.uncompressedSize > limits.entryBytes || total + entry.uncompressedSize > limits.totalBytes) {
          return finish(fail('too_large'))
        }
        if (!entry.canDecodeFileData()) {
          unreadable += 1
          return zip.readEntry()
        }

        zip.openReadStream(entry, (streamErr, s) => {
          if (settled) { s?.destroy(); return }
          if (streamErr || !s) return finish(fail('corrupt'))
          stream = s
          const chunks: Buffer[] = []
          let bytes = 0
          s.on('data', (chunk: Buffer) => {
            if (settled) return
            bytes += chunk.length
            total += chunk.length
            if (bytes > limits.entryBytes || total > limits.totalBytes) return finish(fail('too_large'))
            chunks.push(chunk)
          })
          s.on('error', () => finish(fail('corrupt')))
          s.on('end', () => {
            if (settled) return
            stream = null
            const project = toProject(Buffer.concat(chunks))
            if (project) projects.push(project)
            else unreadable += 1
            zip.readEntry()
          })
        })
      })

      if (zip.entryCount > limits.entries) return finish(fail('too_large'))
      zip.readEntry()
    })
  })
}
