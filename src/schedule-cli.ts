import { randomUUID } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import {
  initDatabase,
  createTask,
  getAllTasks,
  deleteTask,
  pauseTask,
  resumeTask,
} from './db.js'
import { computeNextRun } from './scheduler.js'

function usage(): void {
  console.log(`
AI Assistant Scheduler CLI

Usage:
  schedule-cli create "<prompt>" "<cron>" <chat_id> [--name "name"] [--silent] [--tz "America/Toronto"]
  schedule-cli list
  schedule-cli delete <id>
  schedule-cli pause <id>
  schedule-cli resume <id>

Examples:
  schedule-cli create "Summarize my emails" "0 9 * * *" "123456" --name "Email Summary"
  schedule-cli create "Check project status" "0 10 * * *" "123456" --silent
  schedule-cli list
  schedule-cli pause abc-123
`)
}

function parseFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag)
  if (idx === -1) return null
  return args[idx + 1] ?? null
}

function main(): void {
  initDatabase()

  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd) {
    usage()
    process.exit(0)
  }

  switch (cmd) {
    case 'create': {
      const prompt = args[1]
      const cron = args[2]
      const chatId = args[3]
      if (!prompt || !cron || !chatId) {
        console.error('Usage: schedule-cli create "<prompt>" "<cron>" <chat_id>')
        process.exit(1)
      }
      try {
        CronExpressionParser.parse(cron)
      } catch {
        console.error(`Invalid cron expression: ${cron}`)
        process.exit(1)
      }

      const name = parseFlag(args, '--name')
      const isSilent = args.includes('--silent')
      const deliveryMode = isSilent ? 'silent' as const : 'announce' as const
      const timezone = parseFlag(args, '--tz') ?? 'America/Toronto'

      const id = randomUUID().slice(0, 8)
      const nextRun = computeNextRun(cron, timezone)
      createTask(id, chatId, prompt, cron, nextRun, name ?? undefined, deliveryMode, timezone)
      console.log(`Task created: ${id}${name ? ` (${name})` : ''}`)
      console.log(`  Mode: ${deliveryMode}`)
      console.log(`  Schedule: ${cron} (${timezone})`)
      console.log(`  Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      break
    }

    case 'list': {
      const tasks = getAllTasks()
      if (tasks.length === 0) {
        console.log('No scheduled tasks.')
        break
      }
      console.log('\nScheduled Tasks:\n')
      for (const t of tasks) {
        const label = t.name ?? t.prompt.slice(0, 80)
        const mode = t.delivery_mode === 'silent' ? ' [silent]' : ''
        console.log(`  [${t.status === 'active' ? 'ACTIVE' : 'PAUSED'}${mode}] ${t.id}: ${label}`)
        console.log(`    Schedule: ${t.schedule} (${t.timezone})`)
        console.log(`    Next run: ${new Date(t.next_run * 1000).toLocaleString()}`)
        if (t.last_run) {
          console.log(`    Last run: ${new Date(t.last_run * 1000).toLocaleString()}`)
        }
        console.log()
      }
      break
    }

    case 'delete': {
      const id = args[1]
      if (!id) {
        console.error('Usage: schedule-cli delete <id>')
        process.exit(1)
      }
      if (deleteTask(id)) {
        console.log(`Task ${id} deleted.`)
      } else {
        console.error(`Task ${id} not found.`)
        process.exit(1)
      }
      break
    }

    case 'pause': {
      const id = args[1]
      if (!id) {
        console.error('Usage: schedule-cli pause <id>')
        process.exit(1)
      }
      if (pauseTask(id)) {
        console.log(`Task ${id} paused.`)
      } else {
        console.error(`Task ${id} not found.`)
        process.exit(1)
      }
      break
    }

    case 'resume': {
      const id = args[1]
      if (!id) {
        console.error('Usage: schedule-cli resume <id>')
        process.exit(1)
      }
      const tasks = getAllTasks()
      const task = tasks.find((t) => t.id === id)
      if (!task) {
        console.error(`Task ${id} not found.`)
        process.exit(1)
      }
      const nextRun = computeNextRun(task.schedule, task.timezone)
      if (resumeTask(id, nextRun)) {
        console.log(`Task ${id} resumed. Next run: ${new Date(nextRun * 1000).toLocaleString()}`)
      } else {
        console.error(`Failed to resume task ${id}.`)
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown command: ${cmd}`)
      usage()
      process.exit(1)
  }
}

main()
