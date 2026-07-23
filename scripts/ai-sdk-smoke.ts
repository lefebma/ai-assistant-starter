/**
 * Live smoke test for the AI SDK runtime (Phase 2).
 *
 * Runs real turns against the API (costs a few cents):
 *   npx tsx scripts/ai-sdk-smoke.ts
 *
 * Exercises: system prompt assembly, the tool loop (bash + read_file),
 * streaming callbacks, session persistence + resume, and runOnce.
 */
import { AiSdkAgentRuntime } from '../src/runtime/ai-sdk/index.js'

async function main() {
  const runtime = new AiSdkAgentRuntime()
  let toolCalls = 0
  let partials = 0

  console.log('--- Turn 1: tool use + streaming ---')
  const t1 = await runtime.run({
    message:
      'Two quick checks: 1) run `ls src/runtime` and tell me what files are there. '
      + '2) My favorite number is 47; just acknowledge it. Keep the reply under 80 words.',
    onPartial: () => { partials++ },
    onToolProgress: (name, status) => {
      toolCalls++
      console.log(`  [tool] ${name}: ${status}`)
    },
  })
  console.log(`\n${t1.text}\n`)
  console.log(`sessionId=${t1.newSessionId} toolCalls=${toolCalls} partialCallbacks=${partials}`)

  if (!t1.newSessionId) throw new Error('SMOKE FAIL: no session id returned')
  if (toolCalls === 0) throw new Error('SMOKE FAIL: expected at least one tool call')
  if (partials === 0) throw new Error('SMOKE FAIL: expected streaming partials')

  console.log('\n--- Turn 2: session resume (memory of turn 1) ---')
  const t2 = await runtime.run({
    message: 'What did I say my favorite number was? Answer with just the number.',
    sessionId: t1.newSessionId,
  })
  console.log(`\n${t2.text}\n`)
  if (!t2.text?.includes('47')) throw new Error(`SMOKE FAIL: session resume lost context (got: ${t2.text})`)

  console.log('--- runOnce: bare one-shot ---')
  const once = await runtime.runOnce('Reply with exactly the word: pong')
  console.log(`runOnce -> ${once}`)
  if (!/pong/i.test(once)) throw new Error(`SMOKE FAIL: runOnce unexpected reply: ${once}`)

  console.log('\nSMOKE PASS: tool loop, streaming, session resume, runOnce all working.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
