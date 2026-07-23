import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { getSecret } from './vault/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..', '..')
export const STORE_DIR = resolve(PROJECT_ROOT, 'store')

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

// Limits
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000
