/**
 * Model resolution for the AI SDK runtime.
 *
 * Reads provider + model from .env (AI_PROVIDER / AI_MODEL). Phase 3 opens
 * the runtime past Anthropic: anthropic, openai, google, and azure are wired
 * here, with the openai case accepting an optional AI_BASE_URL so any
 * OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, an OpenAI-compatible
 * gateway) rides the same adapter without a separate package. For azure,
 * AI_MODEL is the customer's *deployment name*, the endpoint comes from
 * AZURE_RESOURCE_NAME (or AI_BASE_URL for sovereign clouds / custom domains),
 * and AZURE_API_VERSION passes through when a tenant needs to pin one.
 * Bedrock lands in a later slice, on demand.
 *
 * Design rules (from the LLM-agnostic design doc, Layer 1):
 *   - Only anthropic carries a default model id. For every other provider the
 *     caller must set AI_MODEL explicitly; we never guess a model id that
 *     could silently rot as vendors rename models.
 *   - Keys are read from .env/process.env and passed straight to the provider
 *     factory. They are never logged or echoed (index.ts logs provider +
 *     modelId only, never the key or baseURL).
 *   - Precedence matches the claude runtime: .env value, then process.env,
 *     then the default.
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createAzure } from '@ai-sdk/azure'
import type { LanguageModel } from 'ai'
import { readEnvFile } from '../../env.js'
import { getSecret } from '../../vault/index.js'

const DEFAULT_PROVIDER = 'anthropic'
/** Only anthropic gets a default model; other providers must set AI_MODEL. */
const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5'
/** Env var holding each provider's API key. Also gates the known-provider set. */
const KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_API_KEY',
}

export type ResolvedModel = {
  provider: string
  modelId: string
  model: LanguageModel
}

/**
 * Construct a LanguageModel from an explicit provider + model + credentials.
 * Single source of truth for provider->model wiring, shared by resolveModel()
 * (the env-driven runtime path) and the eval/probe scripts (explicit args, no
 * .env). Throws on an unknown provider.
 */
export function buildModel(
  provider: string,
  modelId: string,
  opts: { apiKey: string; baseURL?: string; resourceName?: string; apiVersion?: string }
): LanguageModel {
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey: opts.apiKey })(modelId)
    case 'openai':
      // baseURL lets one adapter cover every OpenAI-compatible endpoint
      // (self-hosted Ollama/vLLM/LM Studio, or an OpenAI-compatible gateway).
      return createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL })(modelId)
    case 'google':
      return createGoogleGenerativeAI({ apiKey: opts.apiKey })(modelId)
    case 'azure': {
      // modelId is the customer's Azure *deployment name*, not a vendor model
      // id. The endpoint needs resourceName OR an explicit baseURL (sovereign
      // clouds / custom domains); baseURL wins when both are set.
      if (!opts.resourceName && !opts.baseURL) {
        throw new Error(
          `Azure provider needs AZURE_RESOURCE_NAME (or AI_BASE_URL / resourceName) to locate the tenant's Azure OpenAI endpoint.`
        )
      }
      // .chat() pins Azure to the stateless Chat Completions surface. The
      // default (Responses API) stores response items server-side and session
      // resumes then reference item ids Azure can't find ("Item with id
      // 'msg_...' not found"), which broke the session-resume cert task.
      // Chat Completions is also Azure's mature GA surface (sovereign clouds,
      // older api-versions), so it's the safer tenant-compat default.
      return createAzure({
        apiKey: opts.apiKey,
        resourceName: opts.baseURL ? undefined : opts.resourceName,
        baseURL: opts.baseURL,
        apiVersion: opts.apiVersion,
      }).chat(modelId)
    }
    default:
      throw new Error(
        `Unknown AI_PROVIDER '${provider}'. Available: anthropic, openai, google, azure. (Bedrock lands in a later slice.)`
      )
  }
}

/**
 * The provider name the env currently selects, without building a model.
 * Used by the session-store provider stamp (history sanitizer).
 */
export function configuredProvider(): string {
  const env = readEnvFile()
  return env['AI_PROVIDER']?.trim() || process.env.AI_PROVIDER?.trim() || DEFAULT_PROVIDER
}

export function resolveModel(): ResolvedModel {
  const env = readEnvFile()
  const read = (key: string): string | undefined =>
    env[key]?.trim() || process.env[key]?.trim() || undefined

  const provider = read('AI_PROVIDER') || DEFAULT_PROVIDER
  const modelId = read('AI_MODEL') || (provider === 'anthropic' ? ANTHROPIC_DEFAULT_MODEL : '')
  if (!modelId) {
    throw new Error(
      `AI SDK runtime: provider '${provider}' needs AI_MODEL set in .env (only 'anthropic' has a default model id).`
    )
  }

  const keyEnv = KEY_ENV[provider]
  if (!keyEnv) {
    throw new Error(
      `Unknown AI_PROVIDER '${provider}'. Available: anthropic, openai, google, azure. (Bedrock lands in a later slice.)`
    )
  }
  // BYOK: the key resolves through the vault first (encrypted at rest), then
  // .env, then process.env. Non-breaking — falls through to .env when nothing
  // is vaulted. Only the key goes through the vault; provider/model are config.
  const apiKey = getSecret(keyEnv)
  if (!apiKey) {
    throw new Error(
      `AI SDK runtime: provider '${provider}' needs ${keyEnv} in the vault or .env (the 'ai-sdk' runtime bills the API directly).`
    )
  }

  const baseURL = provider === 'openai' || provider === 'azure' ? read('AI_BASE_URL') : undefined
  const resourceName = provider === 'azure' ? read('AZURE_RESOURCE_NAME') : undefined
  const apiVersion = provider === 'azure' ? read('AZURE_API_VERSION') : undefined
  return {
    provider,
    modelId,
    model: buildModel(provider, modelId, { apiKey, baseURL, resourceName, apiVersion }),
  }
}
