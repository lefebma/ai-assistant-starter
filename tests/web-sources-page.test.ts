import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain ES module shipped to the browser, no type declarations
import * as s from '../public/app/sources.js'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app')
const html = readFileSync(join(APP, 'index.html'), 'utf-8')
const js = readFileSync(join(APP, 'app.js'), 'utf-8')

const LOCAL = { id: 'local', name: 'Havn files' }
const drive = (account: string, state = 'ok') => ({ id: 'drive:' + account, name: 'Google Drive', account, state })
const oneDrive = { sources: [LOCAL, drive('a@x.com')], canConnectDrive: true, connect: 'relay' }
const twoDrives = { sources: [LOCAL, drive('a@x.com'), drive('b@x.com')], canConnectDrive: true, connect: 'relay' }
const CODES = ['unavailable', 'too_large', 'not_found', 'reconnect', 'not_connected']

describe('source picker', () => {
  it('no picker when there is only Havn files and Drive cannot be connected', () =>
    expect(s.showPicker({ sources: [LOCAL], canConnectDrive: false, connect: null })).toBe(false))

  it('shows the picker when Drive can be connected or is connected', () => {
    expect(s.showPicker({ sources: [LOCAL], canConnectDrive: true, connect: 'gog' })).toBe(true)
    expect(s.showPicker({ ...oneDrive, canConnectDrive: false })).toBe(true)
  })

  it('offers Google Drive to connect when none is connected', () =>
    expect(s.pickerOptions({ sources: [LOCAL], canConnectDrive: true, connect: 'relay' })).toEqual([
      { id: 'local', label: 'Havn files' },
      { id: 'drive:', label: 'Google Drive' },
    ]))

  it('leaves the account out with one Drive and names each with several', () => {
    expect(s.pickerOptions(oneDrive)).toEqual([
      { id: 'local', label: 'Havn files' },
      { id: 'drive:a@x.com', label: 'Google Drive' },
    ])
    expect(s.pickerOptions(twoDrives)).toEqual([
      { id: 'local', label: 'Havn files' },
      { id: 'drive:a@x.com', label: 'Google Drive (a@x.com)' },
      { id: 'drive:b@x.com', label: 'Google Drive (b@x.com)' },
    ])
  })

  it('copes with a missing or broken answer', () => {
    expect(s.pickerOptions(null)).toEqual([{ id: 'local', label: 'Havn files' }])
    expect(s.showPicker(undefined)).toBe(false)
  })
})

describe('remembered source', () => {
  it('uses the remembered source while it is still offered', () => {
    expect(s.STORAGE_KEY).toBe('havn.files.source')
    expect(s.resolveSource('drive:a@x.com', oneDrive)).toBe('drive:a@x.com')
    expect(s.resolveSource('drive:', { sources: [LOCAL], canConnectDrive: true, connect: 'relay' })).toBe('drive:')
  })
  it('a remembered source that is gone falls back to Havn files', () =>
    expect(s.resolveSource('drive:gone@x.com', oneDrive)).toBe('local'))
  it('garbage in storage falls back to Havn files', () => {
    expect(s.resolveSource('}{', oneDrive)).toBe('local')
    expect(s.resolveSource(null, oneDrive)).toBe('local')
  })
})

describe('views', () => {
  it('an unconnected Drive shows the connect view and a revoked one the reconnect view', () => {
    expect(s.viewFor('drive:', { sources: [LOCAL], canConnectDrive: true, connect: 'relay' })).toBe('connect')
    expect(s.viewFor('drive:a@x.com', { ...oneDrive, sources: [LOCAL, drive('a@x.com', 'reconnect')] })).toBe('reconnect')
    expect(s.viewFor('drive:a@x.com', oneDrive)).toBe('tree')
    expect(s.viewFor('local', oneDrive)).toBe('tree')
  })
  it('Show more appears only with a next page', () => {
    expect(s.needsMore({ nextPage: null })).toBe(false)
    expect(s.needsMore({ nextPage: 'P2' })).toBe(true)
  })
})

describe('urls and names', () => {
  it('builds encoded URLs', () => {
    expect(s.driveListUrl('a+b@x.com', 'F 1', 'P/2')).toBe('/api/web/sources/drive/list?account=a%2Bb%40x.com&folder=F%201&page=P%2F2')
    expect(s.driveListUrl('a@x.com', '', null)).toBe('/api/web/sources/drive/list?account=a%40x.com')
    expect(s.driveRawUrl('a+b@x.com', 'id&1')).toBe('/api/web/sources/drive/raw?account=a%2Bb%40x.com&id=id%261')
    expect(s.driveOpenUrl('a_b-1')).toBe('https://drive.google.com/open?id=a_b-1')
  })
  it('a Google Doc downloads as a PDF', () => {
    expect(s.downloadName({ name: 'Plan', mimeType: 'application/vnd.google-apps.document' })).toBe('Plan.pdf')
    expect(s.downloadName({ name: 'Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' })).toBe('Sheet.pdf')
    expect(s.downloadName({ name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' })).toBe('Deck.pdf')
    expect(s.downloadName({ name: 'a.pdf', mimeType: 'application/pdf' })).toBe('a.pdf')
  })
  it('every error code has plain text with no em dash', () => {
    for (const c of CODES) {
      expect(s.errorText(c)).toBeTruthy()
      expect(s.errorText(c)).not.toContain('—')
    }
    expect(s.errorText('unavailable')).toBe('Google Drive is not available right now. Try again in a minute.')
    expect(s.errorText('too_large')).toBe('This file is too large to preview here. Open it in Google Drive.')
    expect(s.errorText('not_found')).toBe('This file is no longer in Google Drive.')
    expect(s.errorText('reconnect')).toBe('Google Drive needs to be connected again.')
    expect(s.errorText('not_connected')).toBe('Google Drive needs to be connected again.')
  })
})

describe('the page', () => {
  it('the page has the picker, the connect copy and a noopener link', () => {
    expect(html).toContain('id="source-picker"')
    expect(html.indexOf('id="source-picker"')).toBeLessThan(html.indexOf('id="tree"'))
    expect(js).toContain("from './sources.js'")
    expect(js).toContain('See your Google Drive files here, read only. Havn asks Google for permission to view them.')
    expect(js).toContain('Connect Google Drive')
    expect(html).toMatch(/id="preview-open"[^>]*rel="noopener"[^>]*>Open in Google Drive</)
    expect(js).toContain('Show more')
    expect(js).toMatch(/noopener/)
  })
})
