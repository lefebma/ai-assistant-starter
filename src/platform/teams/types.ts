/**
 * The slice of the Bot Framework Activity schema this adapter reads and
 * writes. Kept deliberately small: anything not listed here is ignored.
 */

export interface ActivityAccount {
  id: string
  name?: string
  aadObjectId?: string
}

export interface ActivityAttachment {
  contentType: string
  contentUrl?: string
  name?: string
  content?: unknown
}

export interface Activity {
  type: string
  id?: string
  replyToId?: string
  text?: string
  value?: unknown
  serviceUrl?: string
  channelId?: string
  from?: ActivityAccount
  recipient?: ActivityAccount
  conversation?: { id: string; tenantId?: string; conversationType?: string }
  channelData?: { tenant?: { id: string } }
  attachments?: ActivityAttachment[]
  membersAdded?: ActivityAccount[]
}

export interface OutboundActivity {
  type: 'message' | 'typing'
  text?: string
  textFormat?: 'markdown' | 'plain'
  attachments?: ActivityAttachment[]
}

/** Everything a proactive send needs, persisted per conversation. */
export interface ConversationReference {
  conversationId: string
  serviceUrl: string
  botId: string
  userId: string
  tenantId?: string
}

export interface TeamsCredentials {
  appId: string
  appSecret: string
  tenantId?: string
}
