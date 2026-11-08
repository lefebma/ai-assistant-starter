/**
 * /project (card #281). The same words on every platform. The web chat keeps
 * going in and out to its sidebar: a web chat belongs to its project for life.
 */
import {
  MAX_INSTRUCTIONS,
  MAX_NAME,
  MAX_PROJECTS,
  createProject,
  findProject,
  listChatProjects,
  renameProject,
  setActiveProject,
  setInstructions,
  type NameError,
  type Project,
} from './store.js'
import { listProjectFiles } from './files.js'

export interface ProjectCommandInput {
  chatId: string
  /** The project this chat or web conversation is in. */
  current: Project | null
  web: boolean
  /** Removes a project and all it owns. */
  remove: (id: string) => boolean
}

const nameProblem: Record<NameError, string> = {
  empty: 'Give it a name, for example /project new Acme.',
  too_long: `Keep the name under ${MAX_NAME} characters.`,
  reserved: 'That word is used by the /project command. Pick another name.',
  taken: 'You already have a project with that name.',
  too_many: `You have reached the limit of ${MAX_PROJECTS} projects.`,
}

const WEB_SWITCH = 'In the web app, open a project from the list on the left.'

function overview(input: ProjectCommandInput): string {
  const { current, chatId } = input
  const all = listChatProjects(chatId)
  const here = current ? `You are in ${current.name}.` : 'You are in General, outside any project.'
  if (!all.length) return `${here}\n\nA project keeps its own instructions, chats and memory. Start one with /project new Acme.`
  const list = all.map((p) => `- ${p.name}${p.id === current?.id ? ' (here)' : ''}`).join('\n')
  const how = input.web ? WEB_SWITCH : 'Send /project and a name to go in, /project off to come back to General.'
  return `${here}\n\nYour projects:\n${list}\n\n${how}`
}

function needProject(input: ProjectCommandInput): string {
  return input.web ? 'This chat is not in a project.' : 'You are not in a project. Send /project and a name to go in.'
}

const pick = (chatId: string, name: string): Project | string => {
  const found = findProject(chatId, name)
  if (!found) return `No project called ${name}. /project lists them.`
  if (Array.isArray(found)) return `That could be ${found.map((p) => p.name).join(' or ')}. Which one?`
  return found
}

/** /project. Returns the reply. */
export function projectCommand(input: ProjectCommandInput, arg: string): string {
  const { chatId, current, web } = input
  const [word = ''] = arg.split(/\s+/, 1)
  const sub = word.toLowerCase()
  const rest = arg.slice(word.length).trim()
  if (!arg) return overview(input)

  if (sub === 'new') {
    const r = createProject(chatId, rest)
    if ('error' in r) return nameProblem[r.error]
    if (web) return `Created ${r.project.name}. It is in the list on the left.`
    setActiveProject(chatId, r.project.id)
    return `Created ${r.project.name}, and you are in it. Add standing instructions with /project instructions, then your text.`
  }

  if ((sub === 'off' || sub === 'general') && !rest) {
    if (web) return WEB_SWITCH
    setActiveProject(chatId, null)
    return current ? `Back in General. ${current.name} is kept as it was.` : 'You are already in General.'
  }

  if (sub === 'instructions') {
    if (!current) return needProject(input)
    if (!rest) return current.instructions ? `Instructions for ${current.name}:\n\n${current.instructions}` : `${current.name} has no instructions yet. Send /project instructions, then your text.`
    const r = setInstructions(chatId, current.id, rest)
    if (r === 'too_long') return `That is ${rest.length} characters. The limit is ${MAX_INSTRUCTIONS}.`
    return r === 'ok' ? `Saved. I will follow these in everything in ${current.name}.` : needProject(input)
  }

  if (sub === 'files') {
    if (!current) return input.web ? 'This chat is not in a project.' : 'Go into a project first. Send /project and a name to go in.'
    const files = listProjectFiles(current.id)
    if (!files.length) return 'This project has no files yet. Add them in the web app.'
    const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
    return `Files in ${current.name}:\n${files.map((f) => `- ${f.name} (${kb(f.size)})`).join('\n')}`
  }

  if (sub === 'rename') {
    if (!current) return needProject(input)
    const r = renameProject(chatId, current.id, rest)
    if (!r) return needProject(input)
    return 'error' in r ? nameProblem[r.error] : `Renamed to ${r.project.name}.`
  }

  if (sub === 'delete') {
    const confirmed = / confirm$/i.test(rest)
    const name = confirmed ? rest.replace(/ confirm$/i, '').trim() : rest
    if (!name) return 'Say which one, for example /project delete Acme.'
    const p = pick(chatId, name)
    if (typeof p === 'string') return p
    if (!confirmed) return `This permanently deletes ${p.name}: its instructions, chats, memory, pinned decisions and scheduled tasks. To go ahead, send /project delete ${p.name} confirm`
    return input.remove(p.id) ? `Deleted ${p.name}.` : `No project called ${name}. /project lists them.`
  }

  if (web) return WEB_SWITCH
  const p = pick(chatId, arg)
  if (typeof p === 'string') return p
  setActiveProject(chatId, p.id)
  const note = p.instructions ? '' : ' It has no instructions yet.'
  return `You are in ${p.name}.${note} Send /project off to come back to General.`
}
