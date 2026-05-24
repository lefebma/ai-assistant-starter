/**
 * ContextProvider interface - the building block of the ContextEngine.
 * Each provider is responsible for retrieving relevant context fragments
 * from a specific source (memories, projects, calendar, etc.)
 */

export interface ContextFragment {
  /** Which provider generated this fragment */
  source: string
  /** The actual content to inject */
  content: string
  /** Relevance score 0-1, used for ranking when merging */
  relevance: number
  /** Optional TTL in seconds (for caching) */
  maxAge?: number
}

export interface ContextProvider {
  /** Human-readable name */
  name: string
  /** Higher priority providers appear first in context */
  priority: number
  /** Whether this provider is active */
  enabled: boolean
  /** Retrieve context fragments for a given message */
  retrieve(chatId: string, message: string): Promise<ContextFragment[]>
}
