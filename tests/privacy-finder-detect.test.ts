/**
 * The name finder's tag merging and filtering (card #275). Tags are the real
 * model's output for these sentences, recorded on 2026-11-16.
 */
import { describe, expect, it } from 'vitest'
import { filterFinds, isAddress, KNOWN_BRANDS, mergeTags, type TokenTag } from '../src/privacy/finder/detect.js'

const t = (entity: string, word: string, score: number, index: number): TokenTag => ({ entity, word, score, index })

describe('mergeTags', () => {
  it('widens a partly tagged word to the whole word', () => {
    const text = 'Can you draft a follow-up to Marcus Ruddy at Norwin about the invoice?'
    const out = mergeTags(text, [t('B-PER', 'Marcus', 0.999, 9), t('I-PER', 'R', 0.999, 10), t('I-PER', '##udd', 0.998, 11)])
    expect(out).toEqual([{ kind: 'person', value: 'Marcus Ruddy', score: expect.closeTo(0.9985, 3) }])
  })

  it('splits a person and a company and trims trailing punctuation', () => {
    const text = 'Remind me to call Devon Spencer at Southtel Communications Inc. tomorrow.'
    const out = mergeTags(text, [
      t('B-PER', 'Devon', 0.999, 6),
      t('I-PER', 'Spencer', 0.998, 7),
      t('B-ORG', 'South', 0.999, 9),
      t('I-ORG', '##tel', 0.999, 10),
      t('I-ORG', 'Communications', 0.999, 11),
      t('I-ORG', 'Inc', 0.999, 12),
    ])
    expect(out.map((f) => [f.kind, f.value])).toEqual([
      ['person', 'Devon Spencer'],
      ['company', 'Southtel Communications Inc'],
    ])
  })

  it('types a word by its first piece, so a LOC-led word is dropped', () => {
    const out = mergeTags('Send it to Norwin today', [t('B-LOC', 'Nor', 0.67, 4), t('I-ORG', '##win', 0.62, 5)])
    expect(out).toEqual([])
  })

  it('drops a possessive', () => {
    const out = mergeTags("Check Acme Corp's invoice", [t('B-ORG', 'Acme', 0.99, 2), t('I-ORG', 'Corp', 0.99, 3)])
    expect(out.map((f) => f.value)).toEqual(['Acme Corp'])
  })

  it('skips a piece it cannot place and does not join words a comma separates', () => {
    const out = mergeTags('Bright Path, Jane Doe', [t('B-ORG', 'Bright', 0.99, 1), t('I-ORG', 'Path', 0.99, 2), t('I-ORG', '[UNK]', 0.99, 3), t('B-PER', 'Jane', 0.99, 4), t('I-PER', 'Doe', 0.99, 5)])
    expect(out.map((f) => [f.kind, f.value])).toEqual([
      ['company', 'Bright Path'],
      ['person', 'Jane Doe'],
    ])
  })
})

describe('mergeTags with typed punctuation', () => {
  it('leaves smart quotes, dashes and slashes out of the name', () => {
    const quoted = mergeTags('Ask \u201cAcme Corp\u201d today', [t('B-ORG', 'Acme', 0.99, 2), t('I-ORG', 'Corp', 0.99, 3)])
    expect(quoted.map((f) => f.value)).toEqual(['Acme Corp'])
    const dashed = mergeTags('Hi\u2014Devon Spencer here', [t('B-PER', 'Devon', 0.99, 3), t('I-PER', 'Spencer', 0.99, 4)])
    expect(dashed.map((f) => f.value)).toEqual(['Devon Spencer'])
    const slashed = mergeTags('Acme/Norwin merger', [t('B-ORG', 'Acme', 0.99, 1), t('B-ORG', 'Nor', 0.99, 3), t('I-ORG', '##win', 0.99, 4)])
    expect(slashed.map((f) => f.value)).toEqual(['Acme', 'Norwin'])
    const single = mergeTags('Call \u2018Bright Path\u2019 now', [t('B-ORG', 'Bright', 0.99, 2), t('I-ORG', 'Path', 0.99, 3)])
    expect(single.map((f) => f.value)).toEqual(['Bright Path'])
  })
})

describe('word pieces land on the right word', () => {
  it('never puts the start of a name inside an earlier word ("there" on havn-test)', () => {
    // bert-base-NER splits reuters.com into re ##uters . com; "re" was found inside "there".
    const text = 'Is there news on reuters.com today'
    const out = mergeTags(text, [t('B-ORG', 're', 0.95, 5), t('I-ORG', '##uters', 0.95, 6)])
    expect(out.map((f) => f.value)).toEqual(['reuters.com'])
    expect(filterFinds(out, new Set())).toEqual([])
  })

  it('still finds a name after an ordinary word with the same letters', () => {
    const out = mergeTags('Where is Ann Smith', [t('B-PER', 'Ann', 0.99, 3), t('I-PER', 'Smith', 0.99, 4)])
    expect(out.map((f) => f.value)).toEqual(['Ann Smith'])
  })
})

describe('filterFinds', () => {
  const f = (kind: 'person' | 'company', value: string, score = 0.99) => ({ kind, value, score })

  it('keeps a confident company name', () => {
    expect(filterFinds([f('company', 'Bright Path Dental')], new Set())).toEqual([f('company', 'Bright Path Dental')])
  })

  it('drops low scores, first names alone, short names, brands and skipped names', () => {
    const out = filterFinds(
      [f('company', 'Lowscore Ltd', 0.79), f('person', 'Jill'), f('company', 'Ab'), f('company', 'Google'), f('person', 'Marc Lefebvre')],
      new Set(['marc lefebvre'])
    )
    expect(out).toEqual([])
    expect(KNOWN_BRANDS).toContain('Telegram')
  })

  it('never offers a web or email address (reuters.com was offered on havn-test)', () => {
    expect(filterFinds([f('company', 'reuters.com'), f('company', 'www.bbc.co.uk'), f('company', 'https://acme.io/x'), f('company', 'sam@acme.io'), f('company', 'Acme.io')], new Set())).toEqual([])
    for (const name of ['Bright Path Dental', 'J.P. Morgan', 'St. Jacobs Farms', 'Acme Inc.', 'Dr. Smith']) expect(isAddress(name)).toBe(false)
  })

  it('drops an all-lowercase find: a name has a capital', () => {
    expect(filterFinds([f('company', 'there'), f('company', 'bright path dental'), f('company', 'Élan Café')], new Set())).toEqual([f('company', 'Élan Café')])
  })
})
