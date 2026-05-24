import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, createTask, getAllTasks } from './db.js'
import { computeNextRun } from './scheduler.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(__dirname, '..', '..')

function loadEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const raw = readFileSync(envPath, 'utf-8')
  const result: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

interface SeedJob {
  name: string
  schedule: string
  deliveryMode: 'announce' | 'silent'
  prompt: string
}

function main(): void {
  const env = loadEnv()
  const chatId = env['ALLOWED_CHAT_ID']
  if (!chatId) {
    console.error('ALLOWED_CHAT_ID not set in .env. Send /chatid to the bot first, then add it to .env.')
    process.exit(1)
  }

  const timezone = env['TIMEZONE'] ?? 'America/New_York'

  // Load seed jobs from JSON file
  const seedJobsPath = resolve(PROJECT_ROOT, 'seed-jobs.json')
  if (!existsSync(seedJobsPath)) {
    console.error(`No seed-jobs.json found at ${seedJobsPath}`)
    console.error('Create one from seed-jobs.example.json to get started.')
    process.exit(1)
  }

  const jobs: SeedJob[] = JSON.parse(readFileSync(seedJobsPath, 'utf-8'))

  initDatabase()

  const existing = getAllTasks()
  const existingNames = new Set(existing.map((t) => t.name).filter(Boolean))

  let created = 0
  for (const job of jobs) {
    if (existingNames.has(job.name)) {
      console.log(`  Skipping "${job.name}" (already exists)`)
      continue
    }
    const id = randomUUID().slice(0, 8)
    const nextRun = computeNextRun(job.schedule, timezone)
    createTask(id, chatId, job.prompt, job.schedule, nextRun, job.name, job.deliveryMode, timezone)
    console.log(`  Created: ${job.name} (${id}) -- next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    created++
  }

  console.log(`\nDone. ${created} jobs created, ${jobs.length - created} skipped.`)
  console.log('Send /schedule list in Telegram to verify.')
}

main()
