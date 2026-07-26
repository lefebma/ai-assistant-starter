/**
 * Applies a setup plan (see plan.ts) to the filesystem. Thin by design:
 * every decision was made in the planner; this walks the actions.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { shouldSkipSecret, substituteTemplate, type PlanAction } from './plan.js'

export interface ExecuteResult {
  written: string[]
  skipped: string[]
  /** "fill this in later" reminders for secrets the user left blank. */
  notes: string[]
}

export function applyPlan(actions: PlanAction[], projectRoot: string): ExecuteResult {
  const result: ExecuteResult = { written: [], skipped: [], notes: [] }
  const abs = (p: string) => resolve(projectRoot, p)

  for (const action of actions) {
    switch (action.type) {
      case 'copy': {
        cpSync(abs(action.from), abs(action.to), { recursive: true })
        result.written.push(action.to)
        break
      }
      case 'edit': {
        const path = abs(action.file)
        if (!existsSync(path)) break
        let text = readFileSync(path, 'utf-8')
        if (action.vars) text = substituteTemplate(text, action.vars)
        for (const { find, replace } of action.literals ?? []) text = text.split(find).join(replace)
        writeFileSync(path, text)
        break
      }
      case 'template': {
        const to = abs(action.to)
        if (action.onlyIfMissing && existsSync(to)) {
          result.skipped.push(action.to)
          break
        }
        mkdirSync(dirname(to), { recursive: true })
        writeFileSync(to, substituteTemplate(readFileSync(abs(action.from), 'utf-8'), action.vars))
        result.written.push(action.to)
        break
      }
      case 'secret': {
        if (!action.value) {
          result.notes.push(action.note)
          break
        }
        if (shouldSkipSecret(action.path)) {
          result.skipped.push(action.path)
          break
        }
        mkdirSync(dirname(action.path), { recursive: true })
        writeFileSync(action.path, action.value, { mode: 0o600 })
        try {
          chmodSync(action.path, 0o600)
        } catch {
          /* windows: no mode bits */
        }
        result.written.push(action.path)
        break
      }
      case 'chmod-exec': {
        if (process.platform === 'win32') break
        const path = abs(action.file)
        if (existsSync(path)) chmodSync(path, 0o755)
        break
      }
    }
  }

  return result
}
