/**
 * The profile command the assistant runs in chat (card #210). Parsing and
 * copy live here so the command is testable in-process; scripts/profile.ts
 * only routes logs and prints. InputError messages are relayed word for word.
 */
import { homedir } from 'node:os'
import { PROJECT_ROOT } from '../env.js'
import { isProfilePending, loadSetupAnswers } from '../setup/saved.js'
import { InputError } from '../setup/web/answers.js'
import { applyProfile, skipProfile, type ProfileInput } from './profile.js'

const FLAGS: Record<string, keyof ProfileInput> = {
  '--owner-name': 'ownerName',
  '--assistant-name': 'assistantName',
  '--city': 'city',
  '--vibe': 'vibe',
  '--bio': 'bio',
}

function parseSet(args: string[]): ProfileInput {
  const input: ProfileInput = {}
  for (let i = 0; i < args.length; i++) {
    const key = FLAGS[args[i]!]
    if (!key) throw new InputError(`I do not know ${args[i]}. Use --owner-name, --assistant-name, --city, --vibe or --bio.`)
    const value = args[++i]
    if (value === undefined) throw new InputError(`${args[i - 1]} needs a value.`)
    input[key] = value
  }
  if (Object.keys(input).length === 0) throw new InputError('Tell me what to change: --owner-name, --assistant-name, --city, --vibe or --bio.')
  return input
}

function status(root: string): string {
  const saved = loadSetupAnswers(root)
  if (!saved) return 'Profile: set. Owner: unknown. Assistant: unknown. City: none. Time zone: unknown.'
  return `Profile: ${isProfilePending(root) ? 'pending' : 'set'}. Owner: ${saved.ownerName}. Assistant: ${saved.assistantName}. City: ${saved.city || 'none'}. Time zone: ${saved.timezone}.`
}

/** Returns the stdout text; throws InputError for input the owner can fix. */
export async function main(argv: string[], root: string = process.env.AGENT_PROJECT_ROOT || PROJECT_ROOT): Promise<string> {
  const [command, ...rest] = argv
  if (command === 'status') return status(root)
  if (command === 'skip') {
    skipProfile(root)
    return 'Skipped. You can still tell me your name, city or how to talk any time.'
  }
  if (command !== 'set') throw new InputError('Use set, skip or status.')

  const input = parseSet(rest)
  const res = await applyProfile(root, homedir(), input, { fetch: globalThis.fetch })
  const lines = ['Saved.']
  if (input.city?.trim()) {
    lines.push(
      res.placeNotFound
        ? `I could not find "${input.city.trim()}", so the weather location and time zone stay as they were.`
        : `Weather and time zone: ${res.place} (${res.timezone}).`
    )
  }
  for (const file of res.kept) lines.push(`Kept your edited ${file}.`)
  if (res.timezoneChanged) lines.push('Restarting after this reply so the new time zone takes effect.')
  return lines.join('\n')
}
