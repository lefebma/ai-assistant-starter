import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  test: {
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
