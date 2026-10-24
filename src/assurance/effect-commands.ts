/**
 * Which shell commands are outward effects the gate can key from the outside
 * (card #229). The built-in send CLIs (ms-mail, imap-mail) check the effect
 * journal themselves, because only they know a draft's real recipients; this
 * covers the commands whose target is on the command line.
 *
 *   gog gmail send --to A,B [--cc C] [--bcc D] --subject S ...
 *   slack.py post --channel C --text T
 *   slack.py dm --user U --text T
 *
 * Anything this does not recognise is not an effect here, and goes through
 * as before.
 */
import { createHash } from 'node:crypto'
import { emailTarget, normaliseRecipients, type EffectSpec } from './effect-journal.js'

/**
 * Shell words with quotes resolved, one list per simple command (split on
 * && || ; | & and newlines outside quotes). Good enough to read flags; not a
 * shell.
 */
export function commandWords(cmd: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let cur: string | null = null
  const end = () => { if (cur !== null) words.push(cur); cur = null }
  const split = () => { end(); if (words.length) out.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '\\' && cmd[i + 1] === '\n') { i++; continue }
    if (c === '\\' && i + 1 < cmd.length) { cur = (cur ?? '') + cmd[++i]; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      let body = ''
      while (j < cmd.length && cmd[j] !== c) {
        if (c === '"' && cmd[j] === '\\' && j + 1 < cmd.length) { body += cmd[j + 1]; j += 2; continue }
        body += cmd[j++]
      }
      cur = (cur ?? '') + body
      i = j
      continue
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      if ((c === '&' || c === '|') && cmd[i + 1] === c) i++
      split()
      continue
    }
    if (/\s/.test(c)) { end(); continue }
    cur = (cur ?? '') + c
  }
  split()
  return out
}

/** `--name value` or `--name=value`, every occurrence. */
function flagValues(words: string[], name: string): string[] {
  const vals: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === `--${name}` && i + 1 < words.length) vals.push(words[++i])
    else if (w.startsWith(`--${name}=`)) vals.push(w.slice(name.length + 3))
  }
  return vals
}

const list = (words: string[], name: string) => flagValues(words, name).flatMap(v => v.split(','))
const digest = (s: string) => createHash('sha256').update(s.trim().replace(/\s+/g, ' ')).digest('hex').slice(0, 16)

function effectOfWords(w: string[]): EffectSpec | null {
  const prog = w[0]?.split('/').pop()
  const at = (i: number) => w[i]
  if (prog === 'gog' && at(1) === 'gmail' && (at(2) === 'send' || (at(2) === 'drafts' && at(3) === 'send'))) {
    const recipients = normaliseRecipients([...list(w, 'to'), ...list(w, 'cc'), ...list(w, 'bcc')])
    // A saved draft sent by id: the id is what identifies it.
    if (at(2) === 'drafts') return { kind: 'email.send', target: `gmail-draft:${at(4) ?? ''}` }
    return { kind: 'email.send', target: emailTarget(recipients, flagValues(w, 'subject')[0] ?? ''), recipients }
  }
  const script = (prog === 'python3' || prog === 'python') ? w[1]?.split('/').pop() : prog
  const off = script === prog ? 0 : 1
  if (script === 'slack.py' && (at(1 + off) === 'post' || at(1 + off) === 'dm')) {
    const verb = at(1 + off)
    const to = verb === 'post' ? flagValues(w, 'channel')[0] ?? '' : flagValues(w, 'user')[0] ?? ''
    const thread = flagValues(w, 'thread')[0]
    const text = flagValues(w, 'text')[0] ?? ''
    return {
      kind: `slack.${verb}`,
      target: `${to.toLowerCase()}${thread ? `#${thread}` : ''}|${digest(text)}`,
      ...(verb === 'dm' ? { recipients: [to] } : {}),
    }
  }
  return null
}

/** The effects a Bash command would cause, in order. Empty for none. */
export function effectsOfCommand(cmd: string): EffectSpec[] {
  return commandWords(cmd).map(effectOfWords).filter((e): e is EffectSpec => e !== null)
}
