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
}

export type Tab = 'search' | 'add' | 'scan' | 'print' | 'logs' | 'trash'

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

export interface LogEntry {
  id: string
  at: number // epoch ms
  user: string
  action: string // machine-readable, e.g. 'container.move'
  summary: string // human-readable one-liner shown in the Logs tab
  containerId?: string
}
