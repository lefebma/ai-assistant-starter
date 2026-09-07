/**
 * Shared workspace: a private git repo of plain markdown that this install
 * clones under workspaces/<name>/, syncs on a timer, and surfaces to the
 * model under a banner naming who else can see it.
 */

export type SharedWith = 'partner' | 'internal' | 'client' | 'unknown'

export interface WorkspaceMember {
  human: string
  assistant: string
  role: string
}

export interface WorkspaceManifest {
  name: string
  sharedWith: SharedWith
  members: WorkspaceMember[]
  /** e.g. "kanbanzone:pW2nxIua" */
  boards: string[]
}

export interface WorkspaceEntry {
  /** Short id, also the folder name under workspaces/. */
  name: string
  /** SSH clone URL. */
  repo: string
  /** Absolute clone path, or '' for the default workspaces/<name>. */
  path: string
  syncMinutes: number
  enabled: boolean
  /** Chats that hint toward this workspace without a keyword hit. */
  chatIds: string[]
  /** Consecutive sync failures, for the notify-once rule. */
  failures: number
  lastSyncAt?: number
  lastSyncOk?: boolean
  lastSyncMessage?: string
  /** Cached from WORKSPACE.md at join time; refreshed on each sync. */
  manifest?: WorkspaceManifest
}
