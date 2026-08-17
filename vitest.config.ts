import { configDefaults, defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  test: {
    // Agent sessions check out git worktrees under .claude/worktrees/, i.e.
    // inside this repo, so the default glob picks up a full second and third
    // copy of the suite. That is not merely slow: every copy carries this same
    // config, so all of them point AGENT_STORE_DIR at the one fixed path below
    // and then race on a single SQLite file. One suite's teardown removes the
    // store dir while another is opening it, which surfaces as intermittent
    // "UNIQUE constraint failed" and "directory does not exist" in the
    // scheduler tests, in whichever copy loses.
    exclude: [...configDefaults.exclude, '**/.claude/**'],

    // AGENT_VAULT_DIR points the default vault at a nonexistent tmp path so a
    // real migrated vault can never leak a secret into a test run; tests that
    // exercise the vault pass an explicit dir.
    env: {
      AGENT_VAULT_DIR: join(tmpdir(), 'assistant-vitest-nonexistent-vault'),
      // Isolate the SQLite store and the dashboard-jobs sync target so tests
      // that exercise the scheduler can never touch a live install's data.
      AGENT_STORE_DIR: join(tmpdir(), 'assistant-vitest-store'),
      DASHBOARD_JOBS_FILE: join(tmpdir(), 'assistant-vitest-dashboard.json'),
    },
  },
})
