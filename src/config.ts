import { resolve } from 'node:path'
import { readEnvFile, PROJECT_ROOT } from './env.js'
import { getSecret } from './vault/index.js'

// Re-exported rather than recomputed. Counting '..' from __dirname gives a
// different answer compiled than it does from source, and every module that
// tried it landed on a different wrong answer. env.ts finds the nearest
// package.json instead, which is correct in both. See tests/project-root.test.ts.
export { PROJECT_ROOT }
export const STORE_DIR = process.env.AGENT_STORE_DIR || resolve(PROJECT_ROOT, 'store')

const env = readEnvFile()

// Secrets resolve through the BYOK vault first (encrypted at rest), then .env,
// then process.env. Non-breaking: falls through to .env when nothing is vaulted.
// Non-secret config (chat id, ports, flags, agent id) stays on plain .env.

// Telegram
export const TELEGRAM_BOT_TOKEN = getSecret('TELEGRAM_BOT_TOKEN') ?? ''
export const PRIMARY_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? env['PRIMARY_CHAT_ID'] ?? ''

// Voice - OpenAI (Whisper STT + TTS)
export const OPENAI_API_KEY = getSecret('OPENAI_API_KEY') ?? ''

// Video analysis - Gemini
export const GOOGLE_API_KEY = getSecret('GOOGLE_API_KEY') ?? ''

// Scheduler
export const SCHEDULER_ENABLED = (env['SCHEDULER_ENABLED'] ?? 'true') === 'true'

// HTTP server (for ElevenLabs Conversational AI custom LLM + voice UI)
export const HTTP_PORT = parseInt(env['HTTP_PORT'] ?? '3030', 10)
export const HTTP_BEARER_TOKEN = getSecret('HTTP_BEARER_TOKEN') ?? ''
export const ELEVENLABS_API_KEY = getSecret('ELEVENLABS_API_KEY') ?? ''
export const ELEVENLABS_AGENT_ID = env['ELEVENLABS_AGENT_ID'] ?? ''

// Public hostname of the edge (Caddy), written by scripts/hosted/enable-teams.ts.
// Empty on a box with no public edge: /voice ui then explains how to enable one
// rather than handing out a URL that resolves to nothing.
export const PUBLIC_HOSTNAME = env['PUBLIC_HOSTNAME']?.trim() ?? ''
// Voice UI links double as the API credential, so the TTL is a session length,
// not a click window.
export const VOICE_LINK_TTL_HOURS = parseInt(env['VOICE_LINK_TTL_HOURS'] ?? '12', 10) || 12

// Support requests (/support). Destination inbox for drafted support emails.
// Non-secret, so plain .env like other addresses.
export const SUPPORT_EMAIL = env['SUPPORT_EMAIL']?.trim() || 'support@els-partners.com'

// Limits
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
