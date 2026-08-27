export interface Item {
  id: string
  name: string
  notes: string
}

export interface ItemStack {
  id: string
  itemRef: string
  quantity: string // stored as text; blank means "not counted yet"
}

export interface ContainerType {
  id: string
  name: string
  color: string // hex
}

/**
 * Physical work the AI agent has proposed but nobody has done yet.
 *
 * It lives on the container rather than in a separate collection so every
 * reader that already has a Container has the proposal too, with no join --
 * and so `location` keeps meaning "where the box actually is right now".
 * The proposed destination only becomes the location when someone confirms
 * the box was really carried there.
 */
export interface PendingMove {
  /** 'move' relocates the box; 'merge' empties it into another container. */
  kind: 'move' | 'merge'
  /** Where the box sat when this was proposed, to detect a stale proposal. */
  from: string
  /** Destination address. For a merge, the target container's location. */
  to: string
  /** Why the agent wants it done, shown to whoever has to do the lifting.
   *  Optional because a proposal can be recorded without one. */
  reason?: string
  at: number // epoch ms
  by: string
  /**
   * The other half of a swap. Shelves are full, so the agent mostly trades
   * two boxes rather than moving one into thin air; both halves are accepted
   * or denied together because half a swap leaves two boxes in one slot.
   */
  swapWith?: string // Container id
  /** For kind === 'merge': the container that receives this one's contents. */
  mergeInto?: string // Container id
}

export interface Container {
  id: string
  location: string
  containerType: string // ContainerType id, or '' if unknown
  contents: string[] // ItemStack ids
  label: string
  notes: string
  flags: string[]
  // Set when the container is in the trash. Trashed containers keep their
  // contents so a restore brings the whole box back intact.
  deleted?: boolean
  deletedAt?: number
  deletedBy?: string
  /** Unconfirmed physical work; see PendingMove. */
  pendingMove?: PendingMove
}

export type Tab = 'search' | 'add' | 'scan' | 'ai' | 'print' | 'logs' | 'trash'

export type IconName =
  | 'search'
  | 'plus'
  | 'camera'
  | 'history'
  | 'trash'
  | 'printer'
  | 'pin'
  | 'menu'
  | 'close'
  | 'chevron-left'
  | 'chevron-right'
  | 'sparkles'
  | 'check'
  | 'arrow-right'
  | 'send'

/**
 * One turn of an AI Work conversation, as stored. Shared by everyone — the
 * point is that anybody can see what was asked and what it did, not just
 * whoever was sitting at the keyboard.
 */
export interface AiStoredMessage {
  id: string
  role: 'user' | 'model'
  text: string
  at: number
  /** Present on a model turn that proposed a plan. */
  planSummary?: string
  /** Human-readable description of each proposed operation. */
  proposals?: string[]
  /** Set once somebody applied the plan; absent means it was never run. */
  appliedSummaries?: string[]
  applied?: number
  proposed?: number
  appliedBy?: string
  appliedAt?: number
}

export interface AiConversation {
  id: string
  /** Who was talking. Attribution only — there is no real authentication. */
  user: string
  /** First thing asked, trimmed, used as the row heading in History. */
  title: string
  startedAt: number
  updatedAt: number
  messages: AiStoredMessage[]
}

export interface LogEntry {
  id: string
  at: number // epoch ms
  user: string
  action: string // machine-readable, e.g. 'container.move'
  summary: string // human-readable one-liner shown in the Logs tab
  containerId?: string
}
