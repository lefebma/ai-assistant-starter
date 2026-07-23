/**
 * One-off live turn on a chosen provider/model (Phase 3 validation).
 *
 * .env's AI_PROVIDER/AI_MODEL intentionally take precedence over process.env
 * (matches the claude runtime), and the live service reads that same .env, so
 * this script does NOT touch .env. Instead it injects the target model through
 * the runtime's documented `model` test seam, built via the shared
 * provider.buildModel() (same construction resolveModel uses). This proves the
 * model works end-to-end through the real ToolLoopAgent loop + built-in tools
 * + CLAUDE.md system prompt.
 *
 * Stateless runOnce(), so no session write and no cross-provider replay hazard.
 *
 *   LIVE_PROVIDER=google LIVE_MODEL=gemini-2.5-pro AI_MCP=off \
 *     /opt/homebrew/Cellar/node/23.11.0/bin/node dist/scripts/provider-live-turn.js
 */
import { AiSdkAgentRuntime } from '../src/runtime/ai-sdk/index.js'
import { resolveModel, buildModel } from '../src/runtime/ai-sdk/provider.js'
import { readEnvFile } from '../src/env.js'

const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-5.4',
  google: 'gemini-2.5-pro',
}
const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
}

async function main() {
  const provider = process.env.LIVE_PROVIDER ?? 'openai'
  const modelId = process.env.LIVE_MODEL ?? DEFAULT_MODEL[provider]
  if (!modelId) throw new Error(`set LIVE_MODEL for provider '${provider}'`)

  const env = readEnvFile()
  const read = (k: string): string | undefined => env[k]?.trim() || process.env[k]?.trim() || undefined
  const keyEnv = KEY_ENV[provider]
  const apiKey = keyEnv ? read(keyEnv) : undefined
  if (!apiKey) throw new Error(`provider '${provider}' needs ${keyEnv ?? 'an API key'} in .env/process.env`)
  const baseURL = provider === 'openai' ? read('AI_BASE_URL') : undefined

  const live = resolveModel()
  console.log(`current .env resolves to: provider=${live.provider} model=${live.modelId} (untouched)`)
  console.log(`=== live turn target: provider=${provider} model=${modelId} mcp=${process.env.AI_MCP ?? 'on'} ===\n`)

  const runtime = new AiSdkAgentRuntime(undefined, buildModel(provider, modelId, { apiKey, baseURL }))

  const identity = await runtime.runOnce('What is your name? Reply with one word only.')
  const personaOk = /umi/i.test(identity)
  console.log(`[persona]   want~=Umi   got: ${JSON.stringify(identity)}   -> ${personaOk ? 'PASS' : 'FAIL'}`)

  const bash = await runtime.runOnce('Run the shell command `echo $((6*7))` and reply with only the number it prints.')
  const toolOk = /\b42\b/.test(bash)
  console.log(`[bash-tool] want~=42    got: ${JSON.stringify(bash)}   -> ${toolOk ? 'PASS' : 'FAIL'}`)

  console.log(`\n${personaOk && toolOk ? 'LIVE TURN PASS' : 'LIVE TURN INCONCLUSIVE'} (${provider}/${modelId})`)
}

main().catch(err => {
  console.error('LIVE TURN ERROR:', err)
  process.exit(1)
})
