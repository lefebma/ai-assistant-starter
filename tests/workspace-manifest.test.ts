import { describe, it, expect } from 'vitest'
import { parseWorkspaceManifest } from '../src/workspace/manifest.js'

const raw = `---
name: havn
shared-with: partner
members: [Marc Lefebvre + Umi (owner), Marina Alex + Joy (partner)]
boards: [kanbanzone:pW2nxIua, kanbanzone:6n2RsmK1]
---
# Havn workspace
`

describe('parseWorkspaceManifest', () => {
  it('reads name, classification, members and boards', () => {
    const m = parseWorkspaceManifest(raw, 'x')
    expect(m.name).toBe('havn')
    expect(m.sharedWith).toBe('partner')
    expect(m.members).toEqual([
      { human: 'Marc Lefebvre', assistant: 'Umi', role: 'owner' },
      { human: 'Marina Alex', assistant: 'Joy', role: 'partner' },
    ])
    expect(m.boards).toEqual(['kanbanzone:pW2nxIua', 'kanbanzone:6n2RsmK1'])
  })

  it('treats a missing manifest as unknown with the fallback name', () => {
    const m = parseWorkspaceManifest('', 'els')
    expect(m).toEqual({ name: 'els', sharedWith: 'unknown', members: [], boards: [] })
  })

  it('treats an unrecognised classification as unknown', () => {
    const m = parseWorkspaceManifest('---\nname: a\nshared-with: public\n---', 'a')
    expect(m.sharedWith).toBe('unknown')
  })

  it('tolerates a member without a role or assistant', () => {
    const m = parseWorkspaceManifest('---\nname: a\nshared-with: internal\nmembers: [Walid Esefan]\n---', 'a')
    expect(m.members).toEqual([{ human: 'Walid Esefan', assistant: '', role: 'member' }])
  })

  it('parses frontmatter saved with CRLF line endings', () => {
    const raw = '---\r\nname: havn\r\nshared-with: partner\r\nmembers: [Marc + Umi (owner)]\r\n---\r\nbody'
    const m = parseWorkspaceManifest(raw, 'fallback')
    expect(m.sharedWith).toBe('partner')
    expect(m.name).toBe('havn')
    expect(m.members[0]).toMatchObject({ human: 'Marc', assistant: 'Umi', role: 'owner' })
  })
})
