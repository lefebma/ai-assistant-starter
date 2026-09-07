import { describe, it, expect } from 'vitest'
import {
  parsePrivatePatterns, findPrivatePatternHits, findDisallowedTypes, buildCommitSummary,
} from '../src/workspace/guards.js'

describe('parsePrivatePatterns', () => {
  it('drops blanks and comments, keeps order', () => {
    expect(parsePrivatePatterns('# wholesale\n$649.35\n\n  $64.50/mo  \n#x\n')).toEqual(['$649.35', '$64.50/mo'])
  })
})

describe('findPrivatePatternHits', () => {
  it('names files containing any pattern, case-insensitively', () => {
    const files = [
      { path: 'projects/gtm/STATE.md', content: 'Wholesale is $649.35 per install' },
      { path: 'decisions/a.md', content: 'nothing here' },
      { path: 'inbox/bin.png', content: null },
    ]
    expect(findPrivatePatternHits(files, ['$649.35'])).toEqual(['projects/gtm/STATE.md'])
    expect(findPrivatePatternHits(files, ['WHOLESALE IS'])).toEqual(['projects/gtm/STATE.md'])
  })

  it('returns nothing with no patterns', () => {
    expect(findPrivatePatternHits([{ path: 'a.md', content: 'x' }], [])).toEqual([])
  })
})

describe('findDisallowedTypes', () => {
  it('allows markdown, text and images anywhere, anything under inbox/', () => {
    const paths = ['README.md', 'notes.txt', 'brand/logo.png', 'inbox/deck.pptx', 'projects/plan.docx', 'a.PDF']
    expect(findDisallowedTypes(paths)).toEqual(['projects/plan.docx', 'a.PDF'])
  })
})

describe('buildCommitSummary', () => {
  it('lists up to three paths, then counts the rest', () => {
    expect(buildCommitSummary('Joy', ['a.md'])).toBe('joy: update a.md')
    expect(buildCommitSummary('Joy', ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])).toBe('joy: update a.md, b.md, c.md and 2 more')
  })
})
