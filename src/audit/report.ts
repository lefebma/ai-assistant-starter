/**
 * Turning the digest into something an owner reads.
 *
 * Two steps, deliberately separate. renderDigest() is the facts, formatted and
 * nothing more: every number in it came out of the box's own records and none
 * of it is written by a model. buildAuditPrompt() wraps those facts in the
 * instruction that asks the assistant to interpret them.
 *
 * The split exists because the failure mode of an audit is confident fiction.
 * A model handed "tell the owner how they used you last month" will produce a
 * fluent report about conversations it cannot see. Handed a fixed block of
 * counts and told the block is the only ground truth, it does the part it is
 * actually good at: reading the shape, noticing what is missing, and saying
 * what to do about it.
 *
 * That is also why the caveats are in the rendered block rather than in the
 * instructions. They travel with the numbers they qualify, so a count can
 * never be quoted as a total by something that skimmed the preamble.
 */
import type { AuditDigest } from './digest.js'

export const DIGEST_HEADING = 'Assistant usage digest'

function isoDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'never'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function line(label: string, value: string): string {
  return `  ${label}: ${value}`
}

/**
 * Wrap a list of short items into indented lines.
 *
 * A month of activity is 30 day-count pairs, which on one line is a horizontal
 * scroll bar in a chat client and a wall in a terminal.
 */
function wrapItems(items: string[], width = 88, indent = '  '): string[] {
  const lines: string[] = []
  let current = ''
  for (const item of items) {
    const next = current ? `${current}, ${item}` : item
    if (`${indent}${next}`.length > width && current) {
      lines.push(`${indent}${current},`)
      current = item
    } else {
      current = next
    }
  }
  if (current) lines.push(`${indent}${current}`)
  return lines
}

function activitySection(d: AuditDigest): string[] {
  if (d.recordedTurns === 0) {
    return ['Conversations', '  No recorded turns in the window.']
  }
  const busiest = d.byHour
    .slice(0, 3)
    .map((h) => `${pad2(h.hour)}:00 (${h.turns})`)
    .join(', ')
  return [
    'Conversations',
    line('Volume', `${d.recordedTurns} recorded turns across ${d.activeDays} of ${d.windowDays} days`),
    line('First and last', `${isoDay(d.firstTurn)} to ${isoDay(d.lastTurn)}`),
    line('Longest quiet stretch since the first one', `${d.longestQuietRunDays} days`),
    line('Busiest hours', busiest || 'none'),
    line('By weekday', d.byWeekday.map((w) => `${w.weekday} ${w.turns}`).join('  ')),
    '  Day by day:',
    ...wrapItems(d.perDay.map((p) => `${p.day} (${p.turns})`), 88, '    '),
  ]
}

function skillsSection(d: AuditDigest): string[] {
  const out = ['What this assistant is wired to']
  if (d.skillsUsed.length === 0 && d.skillsUnused.length === 0) {
    out.push('  No skills are enabled on this install.')
    return out
  }
  out.push('  Used in the window:')
  out.push(
    ...(d.skillsUsed.length > 0
      ? wrapItems(d.skillsUsed.map((s) => `${s.name} (${s.turns})`), 88, '    ')
      : ['    none'])
  )
  out.push('  Never triggered:')
  out.push(
    ...(d.skillsUnused.length > 0
      ? wrapItems(d.skillsUnused.map((s) => s.name), 88, '    ')
      : ['    none'])
  )
  return out
}

function tasksSection(d: AuditDigest): string[] {
  const out = ['Scheduled work']
  if (d.tasks.length === 0) {
    out.push('  Nothing scheduled.')
    return out
  }
  for (const t of d.tasks) {
    const last = t.lastRun ? `last run ${new Date(t.lastRun * 1000).toISOString().slice(0, 10)}` : 'never run'
    out.push(`  ${t.name} [${t.schedule}] ${t.status}, ${last}`)
  }
  return out
}

function tokensSection(d: AuditDigest): string[] {
  if (!d.tokens.available) {
    return [
      'Model usage',
      '  Not recorded on this install. The claude runtime bills through the',
      '  subscription and writes no usage log, so this is unknown rather than zero.',
    ]
  }
  return [
    'Model usage',
    line('Runs', `${d.tokens.runs} runs, ${d.tokens.totalTokens.toLocaleString('en-US')} tokens`),
    line('Models', d.tokens.models.join(', ') || 'unknown'),
  ]
}

function goalsSection(d: AuditDigest): string[] {
  if (!d.goals.profileWritten) {
    return ['What the assistant knows about the owner', '  No PROFILE.md. The discovery interview has never run.']
  }
  return [
    'What the assistant knows about the owner',
    line(
      'PROFILE.md',
      d.goals.prioritiesRecorded ? 'written, with priorities recorded' : 'written, but no priorities recorded'
    ),
  ]
}

function samplesSection(d: AuditDigest): string[] {
  if (d.samples.length === 0) return []
  const header = d.samplesTruncated
    ? `What was asked (${d.samples.length} of ${d.recordedTurns}, spread across the window)`
    : `What was asked (all ${d.samples.length})`
  return [header, ...d.samples.map((s) => `  - ${s}`)]
}

/**
 * The caveats. These are not decoration: the turn count is a floor, and a
 * report that quotes it as a total is wrong in a way the owner cannot check.
 */
function caveatsSection(): string[] {
  return [
    'How to read these numbers',
    '  Only messages longer than 20 characters are recorded, slash commands are',
    '  never recorded, and the same question repeated inside one stretch of',
    '  conversation is recorded once. The real number of exchanges is higher than',
    '  the count above. Treat it as a floor and a shape, not a total.',
    '  Voice turns, file uploads and button taps leave no separate record here.',
  ]
}

/** The facts block. Deterministic: same digest in, same text out. */
export function renderDigest(d: AuditDigest): string {
  const sections: string[][] = [
    [`${DIGEST_HEADING}: last ${d.windowDays} days through ${isoDay(d.generatedAt)} (${d.timeZone})`],
    activitySection(d),
    skillsSection(d),
    tasksSection(d),
    tokensSection(d),
    goalsSection(d),
    samplesSection(d),
    caveatsSection(),
  ]
  return sections
    .filter((s) => s.length > 0)
    .map((s) => s.join('\n'))
    .join('\n\n')
}

/** The goal branch, which is the whole of acceptance criterion 4. */
function goalInstruction(d: AuditDigest): string {
  if (!d.goals.profileWritten) {
    return [
      '4. Goals. No discovery interview has run here, so you are auditing how they',
      '   use you without knowing what they are trying to achieve, and you should say',
      '   that rather than guess. Offer the 15 to 20 minute interview once, in one',
      '   sentence, and drop it if they do not take it up.',
    ].join('\n')
  }
  if (!d.goals.prioritiesRecorded) {
    return [
      '4. Goals. Their profile is written but has no priorities recorded, so you have',
      '   nothing to aim the suggestions at. Close by asking for the top three things',
      '   they are pushing on for the next 90 days, and offer to write them into',
      '   PROFILE.md so this is the last time you have to ask.',
    ].join('\n')
  }
  return [
    '4. Goals. Aim every suggestion at the priorities recorded in PROFILE.md. If a',
    '   suggestion does not move one of them, either cut it or say plainly that it is',
    '   housekeeping rather than padding the list to three.',
  ].join('\n')
}

/**
 * The instruction that goes to the assistant with the facts attached.
 *
 * Written to the assistant rather than to the owner, and deliberately specific
 * about what a bad version looks like: generic AI-productivity advice, invented
 * counts, and a trend read into a quiet month are the three ways this feature
 * turns into noise the owner learns to ignore.
 */
export function buildAuditPrompt(d: AuditDigest): string {
  const empty = d.recordedTurns === 0
  const parts = [
    renderDigest(d),
    '',
    '[Monthly audit of this assistant, requested by its owner.',
    '',
    'The block above was computed from this install\'s own records. Every number in',
    'it is real. Nothing outside it is: do not invent counts, dates, trends, or',
    'conversations you cannot see, and do not describe what was said beyond the',
    'sample quoted above.',
    '',
  ]

  if (empty) {
    parts.push(
      'Nothing was recorded in this window. Do not write a usage report and do not',
      'apologise for the lack of one. Say the window is empty, say in two or three',
      'lines what you could be doing for them with what is already wired up, and ask',
      'which one they want to start with.',
      '',
      goalInstruction(d),
      '',
      'Keep it under 200 words.]'
    )
    return parts.join('\n')
  }

  parts.push(
    'Write them a short report in your own voice, covering:',
    '',
    '1. How they actually use you. Cadence, time of day, and the kinds of things',
    '   they bring you, grounded in the counts and the sample. If the month is thin,',
    '   say it was a quiet month rather than reading a trend into a handful of turns.',
    '',
    '2. What is going unused. Skills enabled and never triggered, scheduled work that',
    '   is paused or has never run, integrations set up and then abandoned. This is',
    '   usually the most useful part of the report, because it is the part they',
    '   cannot see for themselves. Name the thing, say what it would actually do for',
    '   them, and tie it to something they already ask you for.',
    '',
    '3. What to change. At most three suggestions, each one a specific thing they can',
    '   say to you or ask you to set up. A repeated manual ask that should be a',
    '   scheduled task is the best kind of suggestion. Generic advice about using AI',
    '   more is the worst kind, and is worse than saying nothing.',
    '',
    goalInstruction(d),
    '',
    'Under 400 words. No preamble about running an audit. Open with the single thing',
    'that matters most, and if that thing is that they barely used you this month,',
    'open with that.]'
  )
  return parts.join('\n')
}
