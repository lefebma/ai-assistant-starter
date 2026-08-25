/**
 * Platform factory. Reads PLATFORM env var and returns the right adapter.
 */

import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { PlatformAdapter, PlatformName } from './types.js'

export type { PlatformAdapter, PlatformName, IncomingMessage, SendOptions } from './types.js'

export function detectPlatform(): PlatformName {
  const env = readEnvFile()
  const explicit = env['PLATFORM']?.toLowerCase()
  if (explicit === 'slack' || explicit === 'discord' || explicit === 'teams') {
    return explicit as PlatformName
  }
  if (explicit === 'telegram') return 'telegram'

  // Auto-detect from available tokens
  if (env['SLACK_BOT_TOKEN'] && env['SLACK_APP_TOKEN']) return 'slack'
  if (env['TEAMS_APP_ID'] && env['TEAMS_APP_SECRET']) return 'teams'
  if (env['TELEGRAM_BOT_TOKEN']) return 'telegram'

  return 'telegram' // default
}

export async function createAdapter(): Promise<PlatformAdapter> {
  const env = readEnvFile()
  const platform = detectPlatform()

  logger.info({ platform }, 'Creating platform adapter')

  switch (platform) {
    case 'telegram': {
      const token = env['TELEGRAM_BOT_TOKEN']
      if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set in .env')
      const { TelegramAdapter } = await import('./telegram.js')
      return new TelegramAdapter(token)
    }

    case 'slack': {
      const botToken = env['SLACK_BOT_TOKEN']
      const appToken = env['SLACK_APP_TOKEN']
      if (!botToken || !appToken) {
        throw new Error('SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set in .env')
      }
      const { SlackAdapter } = await import('./slack.js')
      return new SlackAdapter(botToken, appToken, env['SLACK_ALLOWED_USERS'])
    }

    case 'discord':
      throw new Error('Discord adapter not yet implemented. Use PLATFORM=telegram or PLATFORM=slack.')

    case 'teams': {
      const appId = env['TEAMS_APP_ID']
      const appSecret = env['TEAMS_APP_SECRET']
      if (!appId || !appSecret) {
        throw new Error('TEAMS_APP_ID and TEAMS_APP_SECRET must both be set in .env')
      }
      const { TeamsAdapter } = await import('./teams/adapter.js')
      const { isAuthorizedSender } = await import('../access.js')
      const { PRIMARY_CHAT_ID } = await import('../config.js')
      const { isAuthorizedChat } = await import('../db.js')
      return new TeamsAdapter({
        appId,
        appSecret,
        tenantId: env['TEAMS_TENANT_ID'] || undefined,
        isAuthorizedChat: (chatId) => isAuthorizedSender({ chatId, primaryChatId: PRIMARY_CHAT_ID, isExtraChat: isAuthorizedChat }),
      })
    }

    default:
      throw new Error(`Unknown platform: ${platform}`)
  }
}
