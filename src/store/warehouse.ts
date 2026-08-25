import { reactive, readonly } from 'vue'
import {
  ref,
  onValue,
  set,
  update,
  remove,
  push,
  query,
  limitToLast,
  type DatabaseReference,
} from 'firebase/database'
import { db } from '../lib/firebase'
import { currentUser } from './user'
import type { Item, ItemStack, ContainerType, Container, LogEntry } from '../lib/types'

const LOG_LIMIT = 500

interface State {
  loading: boolean
  loaded: boolean
  error: string | null
  saving: boolean
  items: Item[]
  itemStacks: ItemStack[]
  containerTypes: ContainerType[]
  containers: Container[] // active only; trashed ones live in `trash`
  trash: Container[]
  logs: LogEntry[] // newest first
}

const state = reactive<State>({
  loading: false,
  loaded: false,
  error: null,
  saving: false,
  items: [],
  itemStacks: [],
  containerTypes: [],
  containers: [],
  trash: [],
  logs: [],
})

function nextId(prefix: string, existing: { id: string }[]): string {
  let max = 0
  for (const { id } of existing) {
    if (!id.startsWith(prefix)) continue
    const n = parseInt(id.slice(prefix.length), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

// Drops `undefined` keys (not provided) and turns '' into `null` (Firebase's
// "delete this field" signal) so set()/update() calls stay clean.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    out[k] = v === '' ? null : v
  }
  return out
}

function keysOf(map: Record<string, true> | undefined | null): string[] {
  return map ? Object.keys(map) : []
}

/** Labels are compared case- and whitespace-insensitively so OCR spacing
 *  differences still match the existing record. */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ')
}

let loadPromise: Promise<void> | null = null

export function load(): Promise<void> {
  if (loadPromise) return loadPromise

  state.loading = true
  state.error = null

  const pending = new Set(['items', 'itemStacks', 'containerTypes', 'containers', 'logs'])

  loadPromise = new Promise((resolve) => {
    function settle(key: string) {
      pending.delete(key)
      if (pending.size === 0) {
        state.loading = false
        state.loaded = true
        resolve()
      }
    }

    function watch<T>(path: string, apply: (val: Record<string, T> | null) => void) {
      onValue(
        ref(db, path),
        (snapshot) => {
          apply(snapshot.val())
          settle(path)
        },
        (err) => {
          state.error = err.message
          state.loading = false
          settle(path)
        }
      )
    }

    watch<{ name?: string; notes?: string }>('items', (val) => {
      state.items = Object.entries(val ?? {}).map(([id, v]) => ({
        id,
        name: v.name ?? '',
        notes: v.notes ?? '',
      }))
    })

    watch<{ itemRef?: string; quantity?: string }>('itemStacks', (val) => {
      state.itemStacks = Object.entries(val ?? {}).map(([id, v]) => ({
        id,
        itemRef: v.itemRef ?? '',
        quantity: v.quantity ?? '',
      }))
    })

    watch<{ name?: string; color?: string }>('containerTypes', (val) => {
      state.containerTypes = Object.entries(val ?? {}).map(([id, v]) => ({
        id,
        name: v.name ?? '',
        color: v.color ?? '',
      }))
    })

    watch<{
      location?: string
      containerType?: string
      contents?: Record<string, true>
      label?: string
      notes?: string
      flags?: Record<string, true>
      deleted?: boolean
      deletedAt?: number
      deletedBy?: string
    }>('containers', (val) => {
      const all = Object.entries(val ?? {}).map(([id, v]) => ({
        id,
        location: v.location ?? '',
        containerType: v.containerType ?? '',
        contents: keysOf(v.contents),
        label: v.label ?? '',
        notes: v.notes ?? '',
        flags: keysOf(v.flags),
        deleted: v.deleted === true,
        deletedAt: v.deletedAt,
        deletedBy: v.deletedBy,
      }))
      state.containers = all.filter((c) => !c.deleted)
      state.trash = all
        .filter((c) => c.deleted)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
    })

    onValue(
      query(ref(db, 'logs'), limitToLast(LOG_LIMIT)),
      (snapshot) => {
        const val = snapshot.val() as Record<string, Omit<LogEntry, 'id'>> | null
        state.logs = Object.entries(val ?? {})
          .map(([id, v]) => ({ id, ...v }))
          .sort((a, b) => b.at - a.at)
        settle('logs')
      },
      (err) => {
        state.error = err.message
        state.loading = false
        settle('logs')
      }
    )
  })

  return loadPromise
}

// --- Change log -----------------------------------------------------------

interface LogInput {
  action: string
  summary: string
  containerId?: string
}

function logPayload(entry: LogInput) {
  return compact({
    at: Date.now(),
    user: currentUser(),
    action: entry.action,
    summary: entry.summary,
    containerId: entry.containerId,
  })
}

async function logChange(entry: LogInput): Promise<void> {
  await push(ref(db, 'logs'), logPayload(entry))
}

/** Adds log entries into a multi-path update so changes and their log
 *  entries land in the same atomic write. */
function addLogsToUpdates(updates: Record<string, unknown>, entries: LogInput[]): void {
  for (const entry of entries) {
    const key = push(ref(db, 'logs')).key
    if (key) updates[`logs/${key}`] = logPayload(entry)
  }
}

async function withSaving<T>(fn: () => Promise<T>): Promise<T> {
  state.saving = true
  state.error = null
  try {
    return await fn()
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    state.saving = false
  }
}

function rootRef(): DatabaseReference {
  return ref(db)
}

function containerLabel(id: string): string {
  const c = state.containers.find((x) => x.id === id) ?? state.trash.find((x) => x.id === id)
  return c?.label || id
}

// --- Item -------------------------------------------------------------
export async function addItem(input: { name: string; notes?: string }): Promise<Item> {
  return withSaving(async () => {
    const id = nextId('I', state.items)
    await set(ref(db, `items/${id}`), compact({ name: input.name, notes: input.notes }))
    await logChange({ action: 'item.create', summary: `Created item "${input.name}"` })
    return { id, name: input.name, notes: input.notes ?? '' }
  })
}

export async function updateItem(id: string, patch: Partial<Omit<Item, 'id'>>): Promise<void> {
  return withSaving(async () => {
    const before = state.items.find((i) => i.id === id)
    await update(ref(db, `items/${id}`), compact(patch))
    const renamed = patch.name !== undefined && before && patch.name !== before.name
    await logChange({
      action: 'item.update',
      summary: renamed
        ? `Renamed item "${before!.name}" to "${patch.name}"`
        : `Edited item "${patch.name ?? before?.name ?? id}"`,
    })
  })
}

export async function deleteItem(id: string): Promise<void> {
  return withSaving(async () => {
    const inUse = state.itemStacks.some((s) => s.itemRef === id)
    if (inUse) throw new Error('Cannot delete an item that is still in a container. Remove those item stacks first.')
    const name = state.items.find((i) => i.id === id)?.name ?? id
    await remove(ref(db, `items/${id}`))
    await logChange({ action: 'item.delete', summary: `Deleted item "${name}"` })
  })
}

// --- ItemStack (adding an item into a container) -----------------------
/** A stack with no stated quantity means one of the thing, not an unknown
 *  amount, so a blank quantity becomes "1". */
const DEFAULT_QUANTITY = '1'

function normalizeQuantity(quantity?: string): string {
  const q = (quantity ?? '').trim()
  return q || DEFAULT_QUANTITY
}

export async function addItemStack(input: { containerId: string; itemRef: string; quantity?: string }): Promise<ItemStack> {
  return withSaving(async () => {
    if (!state.containers.some((c) => c.id === input.containerId)) {
      throw new Error(`Container ${input.containerId} not found`)
    }
    const quantity = normalizeQuantity(input.quantity)
    const id = nextId('IS', state.itemStacks)
    const updates: Record<string, unknown> = {
      [`itemStacks/${id}`]: compact({ itemRef: input.itemRef, quantity }),
      [`containers/${input.containerId}/contents/${id}`]: true,
    }
    const itemName = state.items.find((i) => i.id === input.itemRef)?.name ?? input.itemRef
    addLogsToUpdates(updates, [
      {
        action: 'itemstack.add',
        summary: `Added "${itemName}" x${quantity} to ${containerLabel(input.containerId)}`,
        containerId: input.containerId,
      },
    ])
    await update(rootRef(), updates)
    return { id, itemRef: input.itemRef, quantity }
  })
}

export async function updateItemStack(id: string, patch: Partial<Pick<ItemStack, 'quantity' | 'itemRef'>>): Promise<void> {
  return withSaving(async () => {
    const stack = state.itemStacks.find((s) => s.id === id)
    const itemName = state.items.find((i) => i.id === (patch.itemRef ?? stack?.itemRef))?.name ?? id
    // Clearing the box falls back to 1 rather than leaving a blank quantity.
    const next = patch.quantity !== undefined ? { ...patch, quantity: normalizeQuantity(patch.quantity) } : patch
    await update(ref(db, `itemStacks/${id}`), compact(next))
    await logChange({
      action: 'itemstack.update',
      summary: `Set quantity of "${itemName}" to ${next.quantity ?? stack?.quantity ?? DEFAULT_QUANTITY}`,
    })
  })
}

export async function removeItemStack(id: string): Promise<void> {
  return withSaving(async () => {
    const stack = state.itemStacks.find((s) => s.id === id)
    const itemName = state.items.find((i) => i.id === stack?.itemRef)?.name ?? id
    const owner = state.containers.find((c) => c.contents.includes(id))
    const updates: Record<string, unknown> = { [`itemStacks/${id}`]: null }
    if (owner) updates[`containers/${owner.id}/contents/${id}`] = null
    addLogsToUpdates(updates, [
      {
        action: 'itemstack.remove',
        summary: `Removed "${itemName}"${owner ? ` from ${owner.label || owner.id}` : ''}`,
        containerId: owner?.id,
      },
    ])
    await update(rootRef(), updates)
  })
}

// --- ContainerType -------------------------------------------------------
export async function addContainerType(input: { name: string; color?: string }): Promise<ContainerType> {
  return withSaving(async () => {
    const id = nextId('CT', state.containerTypes)
    await set(ref(db, `containerTypes/${id}`), compact({ name: input.name, color: input.color }))
    await logChange({ action: 'containerType.create', summary: `Created container type "${input.name}"` })
    return { id, name: input.name, color: input.color ?? '' }
  })
}

export async function updateContainerType(id: string, patch: Partial<Omit<ContainerType, 'id'>>): Promise<void> {
  return withSaving(async () => {
    const before = state.containerTypes.find((c) => c.id === id)
    await update(ref(db, `containerTypes/${id}`), compact(patch))
    await logChange({
      action: 'containerType.update',
      summary: `Edited container type "${patch.name ?? before?.name ?? id}"`,
    })
  })
}

export async function deleteContainerType(id: string): Promise<void> {
  return withSaving(async () => {
    const name = state.containerTypes.find((c) => c.id === id)?.name ?? id
    const updates: Record<string, unknown> = { [`containerTypes/${id}`]: null }
    let affected = 0
    for (const c of state.containers) {
      if (c.containerType === id) {
        updates[`containers/${c.id}/containerType`] = null
        affected += 1
      }
    }
    addLogsToUpdates(updates, [
      {
        action: 'containerType.delete',
        summary: `Deleted container type "${name}"${affected ? ` (${affected} container${affected === 1 ? '' : 's'} uncategorized)` : ''}`,
      },
    ])
    await update(rootRef(), updates)
  })
}

// A location "matches" a shelf prefix like "SL1-M" if it's exactly that
// prefix or starts with it followed by a '-' (so "SL1-M" matches
// "SL1-M-A" but not "SL1-MX").
export function containersMatchingLocationPrefix(prefix: string): Container[] {
  const p = prefix.trim()
  if (!p) return []
  return state.containers.filter((c) => c.location === p || c.location.startsWith(`${p}-`))
}

export async function bulkSetContainerType(prefix: string, containerTypeId: string): Promise<number> {
  return withSaving(async () => {
    const matches = containersMatchingLocationPrefix(prefix)
    if (matches.length === 0) return 0
    const typeName = state.containerTypes.find((t) => t.id === containerTypeId)?.name ?? containerTypeId
    const updates: Record<string, unknown> = {}
    for (const c of matches) updates[`containers/${c.id}/containerType`] = containerTypeId
    addLogsToUpdates(updates, [
      {
        action: 'container.bulkSetType',
        summary: `Set ${matches.length} container${matches.length === 1 ? '' : 's'} at "${prefix.trim()}" to type "${typeName}"`,
      },
    ])
    await update(rootRef(), updates)
    return matches.length
  })
}

// --- Container -------------------------------------------------------------
export async function addContainer(input: { location: string; label?: string; containerType?: string; notes?: string }): Promise<Container> {
  return withSaving(async () => {
    const id = nextId('C', [...state.containers, ...state.trash])
    await set(
      ref(db, `containers/${id}`),
      compact({ location: input.location, containerType: input.containerType, label: input.label, notes: input.notes })
    )
    await logChange({
      action: 'container.create',
      summary: `Created container "${input.label || '(no label)'}" at ${input.location}`,
      containerId: id,
    })
    return {
      id,
      location: input.location,
      containerType: input.containerType ?? '',
      contents: [],
      label: input.label ?? '',
      notes: input.notes ?? '',
      flags: [],
    }
  })
}

export async function updateContainer(id: string, patch: Partial<Omit<Container, 'id' | 'contents' | 'flags'>>): Promise<void> {
  return withSaving(async () => {
    const before = state.containers.find((c) => c.id === id)
    await update(ref(db, `containers/${id}`), compact(patch))

    const moved = patch.location !== undefined && before && patch.location !== before.location
    const renamed = patch.label !== undefined && before && patch.label !== before.label
    const name = patch.label ?? before?.label ?? id

    let action = 'container.update'
    let summary = `Edited container "${name}"`
    if (moved && renamed) {
      action = 'container.move'
      summary = `Renamed "${before!.label || id}" to "${patch.label}" and moved it from ${before!.location} to ${patch.location}`
    } else if (moved) {
      action = 'container.move'
      summary = `Moved "${before!.label || id}" from ${before!.location} to ${patch.location}`
    } else if (renamed) {
      action = 'container.rename'
      summary = `Renamed container "${before!.label || '(no label)'}" to "${patch.label}"`
    }

    await logChange({ action, summary, containerId: id })
  })
}

/** Soft-delete: moves the container to the trash, keeping its contents so a
 *  restore brings the whole box back. */
export async function deleteContainer(id: string): Promise<void> {
  return withSaving(async () => {
    const container = state.containers.find((c) => c.id === id)
    if (!container) return
    const updates: Record<string, unknown> = {
      [`containers/${id}/deleted`]: true,
      [`containers/${id}/deletedAt`]: Date.now(),
      [`containers/${id}/deletedBy`]: currentUser(),
    }
    addLogsToUpdates(updates, [
      {
        action: 'container.trash',
        summary: `Moved "${container.label || id}" (${container.location}) to Deleted Containers`,
        containerId: id,
      },
    ])
    await update(rootRef(), updates)
  })
}

export async function restoreContainer(id: string): Promise<void> {
  return withSaving(async () => {
    const container = state.trash.find((c) => c.id === id)
    if (!container) return
    const updates: Record<string, unknown> = {
      [`containers/${id}/deleted`]: null,
      [`containers/${id}/deletedAt`]: null,
      [`containers/${id}/deletedBy`]: null,
    }
    addLogsToUpdates(updates, [
      {
        action: 'container.restore',
        summary: `Restored "${container.label || id}" to ${container.location}`,
        containerId: id,
      },
    ])
    await update(rootRef(), updates)
  })
}

/** Permanent delete — also removes the container's item stacks. */
export async function purgeContainer(id: string): Promise<void> {
  return withSaving(async () => {
    const container = state.trash.find((c) => c.id === id)
    if (!container) return
    const updates: Record<string, unknown> = { [`containers/${id}`]: null }
    for (const stackId of container.contents) updates[`itemStacks/${stackId}`] = null
    addLogsToUpdates(updates, [
      {
        action: 'container.purge',
        summary: `Permanently deleted "${container.label || id}" (was ${container.location})`,
        containerId: id,
      },
    ])
    await update(rootRef(), updates)
  })
}

export async function emptyTrash(): Promise<number> {
  return withSaving(async () => {
    const doomed = [...state.trash]
    if (doomed.length === 0) return 0
    const updates: Record<string, unknown> = {}
    for (const container of doomed) {
      updates[`containers/${container.id}`] = null
      for (const stackId of container.contents) updates[`itemStacks/${stackId}`] = null
    }
    addLogsToUpdates(updates, [
      {
        action: 'container.emptyTrash',
        summary: `Emptied Deleted Containers (${doomed.length} container${doomed.length === 1 ? '' : 's'} permanently deleted)`,
      },
    ])
    await update(rootRef(), updates)
    return doomed.length
  })
}

// --- Shelf scan ------------------------------------------------------------

export interface ScanChange {
  kind: 'move' | 'create' | 'trash'
  label: string
  containerId?: string
  fromLocation?: string
  toLocation?: string
  containerTypeId?: string
  containerTypeName?: string
  confidence?: string
}

export interface ScanDiff {
  changes: ScanChange[]
  unchanged: number
  ambiguous: string[] // labels that match more than one container
}

export interface ScannedBoxInput {
  label: string
  level: string
  column: string
  containerType?: string
  confidence?: string
}

/** Compares what Gemini saw on a shelf against what the database believes. */
export function computeScanDiff(shelfId: string, boxes: ScannedBoxInput[]): ScanDiff {
  const shelf = shelfId.trim()
  const byLabel = new Map<string, Container[]>()
  for (const c of state.containers) {
    const key = normalizeLabel(c.label)
    if (!key) continue
    const list = byLabel.get(key)
    if (list) list.push(c)
    else byLabel.set(key, [c])
  }

  const typeByName = new Map(state.containerTypes.map((t) => [t.name.trim().toLowerCase(), t]))

  const changes: ScanChange[] = []
  const ambiguous: string[] = []
  const seen = new Set<string>()
  let unchanged = 0

  for (const box of boxes) {
    const label = box.label.trim()
    const key = normalizeLabel(label)
    if (!key) continue
    seen.add(key)

    const toLocation = `${shelf}-${box.level.trim()}-${box.column.trim()}`
    const matches = byLabel.get(key) ?? []

    if (matches.length > 1) {
      // Don't guess which duplicate moved — flag it for the user instead.
      ambiguous.push(label)
      continue
    }

    if (matches.length === 1) {
      const container = matches[0]
      if (container.location === toLocation) {
        unchanged += 1
      } else {
        changes.push({
          kind: 'move',
          label: container.label,
          containerId: container.id,
          fromLocation: container.location,
          toLocation,
          confidence: box.confidence,
        })
      }
      continue
    }

    const type = box.containerType ? typeByName.get(box.containerType.trim().toLowerCase()) : undefined
    changes.push({
      kind: 'create',
      label,
      toLocation,
      containerTypeId: type?.id,
      containerTypeName: type?.name,
      confidence: box.confidence,
    })
  }

  // Anything the database puts on this shelf that the photo didn't show.
  for (const c of state.containers) {
    const onThisShelf = c.location === shelf || c.location.startsWith(`${shelf}-`)
    if (!onThisShelf) continue
    if (seen.has(normalizeLabel(c.label))) continue
    changes.push({
      kind: 'trash',
      label: c.label,
      containerId: c.id,
      fromLocation: c.location,
    })
  }

  return { changes, unchanged, ambiguous }
}

/** Applies the selected scan changes in one atomic write, with a log entry
 *  per change. */
export async function applyScanChanges(shelfId: string, changes: ScanChange[]): Promise<number> {
  return withSaving(async () => {
    if (changes.length === 0) return 0
    const updates: Record<string, unknown> = {}
    const logs: LogInput[] = []

    // New containers need ids that don't collide with each other.
    const provisional: { id: string }[] = [...state.containers, ...state.trash]

    for (const change of changes) {
      if (change.kind === 'move' && change.containerId) {
        updates[`containers/${change.containerId}/location`] = change.toLocation
        logs.push({
          action: 'container.move',
          summary: `Scan of ${shelfId}: moved "${change.label}" from ${change.fromLocation} to ${change.toLocation}`,
          containerId: change.containerId,
        })
      } else if (change.kind === 'create') {
        const id = nextId('C', provisional)
        provisional.push({ id })
        updates[`containers/${id}`] = compact({
          location: change.toLocation,
          label: change.label,
          containerType: change.containerTypeId,
        })
        logs.push({
          action: 'container.create',
          summary: `Scan of ${shelfId}: found new container "${change.label}" at ${change.toLocation}${
            change.containerTypeName ? ` (type "${change.containerTypeName}")` : ''
          }`,
          containerId: id,
        })
      } else if (change.kind === 'trash' && change.containerId) {
        updates[`containers/${change.containerId}/deleted`] = true
        updates[`containers/${change.containerId}/deletedAt`] = Date.now()
        updates[`containers/${change.containerId}/deletedBy`] = currentUser()
        logs.push({
          action: 'container.trash',
          summary: `Scan of ${shelfId}: "${change.label}" was not seen at ${change.fromLocation} — moved to Deleted Containers`,
          containerId: change.containerId,
        })
      }
    }

    addLogsToUpdates(updates, logs)
    await update(rootRef(), updates)
    return changes.length
  })
}

// --- Lookups -------------------------------------------------------------
export function itemById(id: string): Item | undefined {
  return state.items.find((i) => i.id === id)
}
export function itemStackById(id: string): ItemStack | undefined {
  return state.itemStacks.find((s) => s.id === id)
}
export function containerTypeById(id: string): ContainerType | undefined {
  return state.containerTypes.find((c) => c.id === id)
}

/** Shelf roots (e.g. SL1, SR3) derived from existing container locations. */
export function knownShelves(): string[] {
  const set = new Set<string>()
  for (const c of state.containers) {
    const root = c.location.split('-')[0]
    if (root) set.add(root)
  }
  return [...set].sort()
}

/** Level codes already recorded on a shelf, e.g. ['L','M','T'] — used to
 *  tell Gemini whether this shelf uses M or M1/M2/M3. */
export function levelsForShelf(shelfId: string): string[] {
  const set = new Set<string>()
  for (const c of state.containers) {
    const [root, level] = c.location.split('-')
    if (root === shelfId && level) set.add(level)
  }
  return [...set].sort()
}

/** Labels that appear on more than one active container — these can't be
 *  matched unambiguously during a scan. */
export function duplicateLabels(): string[] {
  const counts = new Map<string, number>()
  for (const c of state.containers) {
    const key = normalizeLabel(c.label)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return state.containers
    .filter((c) => (counts.get(normalizeLabel(c.label)) ?? 0) > 1)
    .map((c) => c.label)
    .filter((label, i, arr) => arr.indexOf(label) === i)
}

export const warehouse = readonly(state)
