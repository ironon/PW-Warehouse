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
import type { Item, ItemStack, ContainerType, Container, LogEntry, PendingMove } from '../lib/types'

const LOG_LIMIT = 500

/**
 * Where things belong on a shelf. Seeded from how the warehouse is actually
 * run; kept in the database (not in code) because it is a business rule the
 * staff should be able to change without a rebuild, and it must read the same
 * for everyone the agent plans for.
 */
export const DEFAULT_PLACEMENT_RULES = [
  'Middle levels (M, M1, M2...) are the easiest to reach, so they hold tools and',
  'equipment that get used often.',
  '',
  'The top level (T) holds customer spare parts, and anything in a cardboard box.',
  '',
  'The bottom level (L) holds things that matter but are needed less often than',
  'what is on the middle levels.',
  '',
  'Shelves are full. There is almost never an empty slot, so relocating a box',
  'normally means swapping it with another box rather than moving it on its own.',
  '',
  'Every move is manual labour. Do not propose a move unless it clearly fixes',
  'something; leaving a box where it is is always an acceptable answer.',
].join('\n')

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
  /** Shared standing rules the AI agent must respect when placing boxes. */
  placementRules: string
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
  placementRules: '',
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

/** Firebase rejects `undefined`, but unlike compact() this keeps '' as '' —
 *  a proposal with no stated reason must still keep its other fields. */
function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
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

  const pending = new Set(['items', 'itemStacks', 'containerTypes', 'containers', 'logs', 'settings'])

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
      pendingMove?: PendingMove
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
        pendingMove: v.pendingMove ?? undefined,
      }))
      state.containers = all.filter((c) => !c.deleted)
      state.trash = all
        .filter((c) => c.deleted)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
    })

    watch<unknown>('settings', (val) => {
      const rules = (val as { placementRules?: string } | null)?.placementRules
      state.placementRules = typeof rules === 'string' ? rules : DEFAULT_PLACEMENT_RULES
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

/**
 * Where a container sits when nobody has recorded a shelf position for it.
 * A real string rather than '' so it reads as a deliberate "not placed yet"
 * everywhere a location is shown, and so it can be searched for.
 */
export const UNKNOWN_LOCATION = 'Unknown'

/**
 * A thing that is its own box: creates the Item and the Container together,
 * in one atomic write. Two records for one physical object, so they must not
 * be able to exist apart - an item with no box, or a box with no item, would
 * both be wrong.
 */
export async function addItemContainer(input: {
  name: string
  notes?: string
}): Promise<{ item: Item; container: Container }> {
  return withSaving(async () => {
    const name = input.name.trim()
    const notes = (input.notes ?? '').trim()
    const itemId = nextId('I', state.items)
    const containerId = nextId('C', [...state.containers, ...state.trash])

    const updates: Record<string, unknown> = {
      [`items/${itemId}`]: compact({ name, notes }),
      [`containers/${containerId}`]: compact({ location: UNKNOWN_LOCATION, label: name, notes }),
    }
    addLogsToUpdates(updates, [
      {
        action: 'itemContainer.create',
        summary: `Created item container "${name}" (item ${itemId} and container ${containerId} at ${UNKNOWN_LOCATION})`,
        containerId,
      },
    ])
    await update(rootRef(), updates)

    return {
      item: { id: itemId, name, notes },
      container: {
        id: containerId,
        location: UNKNOWN_LOCATION,
        containerType: '',
        contents: [],
        label: name,
        notes,
        flags: [],
      },
    }
  })
}

export async function updateContainer(id: string, patch: Partial<Omit<Container, 'id' | 'contents' | 'flags'>>): Promise<void> {
  return withSaving(async () => {
    const before = state.containers.find((c) => c.id === id)
    const moved = patch.location !== undefined && before && patch.location !== before.location

    const payload = compact(patch)
    // Editing the address by hand answers the same question the proposal was
    // asking — where is this box? — so the proposal is settled either way and
    // must not linger pointing at an address that is now stale.
    if (moved && before?.pendingMove) payload.pendingMove = null

    await update(ref(db, `containers/${id}`), payload)

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
      // A box in the trash isn't going to be carried anywhere, and a restore
      // shouldn't bring a stale proposal back with it.
      [`containers/${id}/pendingMove`]: null,
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
  // 'confirmMove' means the photo found a box at the exact address somebody
  // had proposed moving it to, which settles the proposal without anyone
  // having to tick it off by hand.
  kind: 'move' | 'create' | 'trash' | 'confirmMove'
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
      const pending = container.pendingMove

      if (container.location === toLocation) {
        // Exactly where the database already has it. If a move was proposed,
        // the box simply hasn't been carried yet - the proposal stands.
        unchanged += 1
      } else if (pending?.kind === 'move' && pending.to === toLocation) {
        // Somebody did the work. The photo is the confirmation.
        changes.push({
          kind: 'confirmMove',
          label: container.label,
          containerId: container.id,
          fromLocation: container.location,
          toLocation,
          confidence: box.confidence,
        })
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
    // A box with a proposal against it is *expected* to leave this shelf, so
    // its absence is not evidence it is gone. Say nothing rather than propose
    // trashing a box that somebody has probably just carried elsewhere.
    if (c.pendingMove) continue
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
    // Containers whose pending proposal this batch has already settled.
    const settled = new Set<string>()

    // New containers need ids that don't collide with each other.
    const provisional: { id: string }[] = [...state.containers, ...state.trash]

    for (const change of changes) {
      if (change.kind === 'confirmMove' && change.containerId) {
        // Settling one half of a swap settles the other: box A could not be
        // sitting in box B's slot unless box B had already been moved out.
        // Guarded against a swap whose two halves both appear in one photo.
        const container = state.containers.find((c) => c.id === change.containerId)
        if (container && !settled.has(container.id)) {
          for (const member of pendingGroup(container.id)) {
            settled.add(member.id)
            stageAccept(member, updates, logs, `Scan of ${shelfId}`)
          }
        }
      } else if (change.kind === 'move' && change.containerId) {
        updates[`containers/${change.containerId}/location`] = change.toLocation
        // The photo found it somewhere other than where it was headed, so any
        // outstanding proposal for this box is stale.
        updates[`containers/${change.containerId}/pendingMove`] = null
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

// --- Settings ---------------------------------------------------------------
export async function setPlacementRules(rules: string): Promise<void> {
  return withSaving(async () => {
    await set(ref(db, 'settings/placementRules'), rules)
    await logChange({ action: 'settings.placementRules', summary: 'Updated the AI placement rules' })
  })
}

// --- Pending physical work --------------------------------------------------
//
// The agent never relocates a box on its own. It records a *proposal* on the
// container, the container keeps reporting the address it is actually at, and
// the address only changes when a person (or a shelf scan) confirms the box
// really was carried there.

/** Containers with unconfirmed proposed work, oldest proposal first. */
export function pendingMoveContainers(): Container[] {
  return state.containers
    .filter((c) => c.pendingMove)
    .sort((a, b) => (a.pendingMove!.at ?? 0) - (b.pendingMove!.at ?? 0))
}

export function pendingMoveCount(): number {
  return state.containers.reduce((n, c) => n + (c.pendingMove ? 1 : 0), 0)
}

/**
 * A proposal plus anything that has to be settled with it. Half a swap is not
 * a thing you can do — carrying box A to B's slot without moving B leaves two
 * boxes in one place — so both halves accept and deny together.
 */
function pendingGroup(containerId: string): Container[] {
  const first = state.containers.find((c) => c.id === containerId)
  if (!first?.pendingMove) return []
  const partnerId = first.pendingMove.swapWith
  if (!partnerId) return [first]
  const partner = state.containers.find((c) => c.id === partnerId && c.pendingMove)
  return partner ? [first, partner] : [first]
}

export function pendingPartner(containerId: string): Container | undefined {
  return pendingGroup(containerId).find((c) => c.id !== containerId)
}

/** Writes that settle one proposal, folded into a caller-supplied batch so a
 *  swap's two halves and a scan's confirmations stay atomic. */
function stageAccept(
  container: Container,
  updates: Record<string, unknown>,
  logs: LogInput[],
  via: string
): void {
  const move = container.pendingMove
  if (!move) return
  updates[`containers/${container.id}/pendingMove`] = null

  if (move.kind === 'merge' && move.mergeInto) {
    const target = state.containers.find((c) => c.id === move.mergeInto)
    if (!target) {
      // Target vanished (trashed or purged since the proposal). Dropping the
      // proposal is the safe outcome: never silently discard a box's contents.
      logs.push({
        action: 'container.mergeAbandoned',
        summary: `Could not merge "${container.label || container.id}" — the container it was to merge into no longer exists`,
        containerId: container.id,
      })
      return
    }
    for (const stackId of container.contents) {
      updates[`containers/${container.id}/contents/${stackId}`] = null
      updates[`containers/${target.id}/contents/${stackId}`] = true
    }
    updates[`containers/${container.id}/deleted`] = true
    updates[`containers/${container.id}/deletedAt`] = Date.now()
    updates[`containers/${container.id}/deletedBy`] = currentUser()
    logs.push({
      action: 'container.merge',
      summary: `${via}: merged "${container.label || container.id}" (${container.contents.length} item stack${
        container.contents.length === 1 ? '' : 's'
      }) into "${target.label || target.id}" at ${target.location}`,
      containerId: target.id,
    })
    return
  }

  updates[`containers/${container.id}/location`] = move.to
  logs.push({
    action: 'container.move',
    summary: `${via}: "${container.label || container.id}" moved from ${move.from} to ${move.to}`,
    containerId: container.id,
  })
}

/** Confirms the work was physically done and commits it. */
export async function acceptPendingMove(containerId: string): Promise<void> {
  return withSaving(async () => {
    const group = pendingGroup(containerId)
    if (group.length === 0) return
    const updates: Record<string, unknown> = {}
    const logs: LogInput[] = []
    for (const c of group) stageAccept(c, updates, logs, 'Confirmed')
    addLogsToUpdates(updates, logs)
    await update(rootRef(), updates)
  })
}

/** Rejects the proposal outright. The box stays exactly where it is. */
export async function denyPendingMove(containerId: string): Promise<void> {
  return withSaving(async () => {
    const group = pendingGroup(containerId)
    if (group.length === 0) return
    const updates: Record<string, unknown> = {}
    const logs: LogInput[] = []
    for (const c of group) {
      updates[`containers/${c.id}/pendingMove`] = null
      logs.push({
        action: 'container.moveDenied',
        summary: `Rejected the proposal to move "${c.label || c.id}" from ${c.pendingMove!.from} to ${c.pendingMove!.to}`,
        containerId: c.id,
      })
    }
    addLogsToUpdates(updates, logs)
    await update(rootRef(), updates)
  })
}

/** Clears every outstanding proposal — the "undo the whole reorganisation"
 *  button, for when a plan turns out to be wrong after it was applied. */
export async function denyAllPendingMoves(): Promise<number> {
  return withSaving(async () => {
    const all = pendingMoveContainers()
    if (all.length === 0) return 0
    const updates: Record<string, unknown> = {}
    for (const c of all) updates[`containers/${c.id}/pendingMove`] = null
    addLogsToUpdates(updates, [
      {
        action: 'container.moveDenied',
        summary: `Rejected all ${all.length} outstanding move proposal${all.length === 1 ? '' : 's'}`,
      },
    ])
    await update(rootRef(), updates)
    return all.length
  })
}

// --- AI agent plans ---------------------------------------------------------
//
// The agent proposes; this module decides what a proposal is allowed to do.
// Everything that is purely bookkeeping (naming, typing, item counts) is
// written straight away. Anything that requires somebody to physically pick a
// box up becomes a pending proposal instead - see "Pending physical work".

export const AGENT_OPS = [
  'container.move',
  'container.swap',
  'container.merge',
  'container.create',
  'container.update',
  'container.trash',
  'item.create',
  'itemstack.add',
  'itemstack.update',
  'itemstack.remove',
  'containertype.create',
] as const

export type AgentOpKind = (typeof AGENT_OPS)[number]

/** One proposed change. Flat rather than a discriminated union because
 *  Gemini's structured-output schema has no union support: every field is
 *  optional and `op` says which ones matter. */
export interface AgentOperation {
  op: string
  reason?: string
  containerId?: string
  otherContainerId?: string
  targetContainerId?: string
  location?: string
  label?: string
  containerTypeName?: string
  notes?: string
  itemName?: string
  itemNotes?: string
  quantity?: string
  itemStackId?: string
  color?: string
}

export interface ValidatedOperation {
  index: number
  op: AgentOperation
  /** One-line description for the review row. */
  summary: string
  /** True when applying only records a proposal somebody must confirm. */
  needsConfirmation: boolean
  /** Set when the operation cannot be applied at all. */
  error?: string
}

const LOCATION_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/

function normalizeLocation(raw: string | undefined): string {
  return (raw ?? '').trim().toUpperCase()
}

function findContainer(id: string | undefined): Container | undefined {
  if (!id) return undefined
  return state.containers.find((c) => c.id === id)
}

function quote(c: Container | undefined, fallback = '?'): string {
  if (!c) return fallback
  return `"${c.label || c.id}"`
}

/**
 * Turns a raw plan into rows the review screen can show, each either
 * applicable or carrying the reason it is not. Nothing is written here.
 */
export function validateAgentPlan(operations: AgentOperation[]): ValidatedOperation[] {
  // Names the plan introduces itself, so a later op in the same plan can refer
  // to an item or type an earlier op creates.
  const newItemNames = new Set<string>()
  const newTypeNames = new Set<string>()

  return operations.map((op, index) => {
    const row = (summary: string, extra?: Partial<ValidatedOperation>): ValidatedOperation => ({
      index,
      op,
      summary,
      needsConfirmation: false,
      ...extra,
    })
    const bad = (message: string) => row(message, { error: message })

    switch (op.op) {
      case 'container.move': {
        const c = findContainer(op.containerId)
        if (!c) return bad(`Move: no active container with id ${op.containerId ?? '(none given)'}`)
        const to = normalizeLocation(op.location)
        if (!LOCATION_RE.test(to)) return bad(`Move ${quote(c)}: "${op.location ?? ''}" is not a valid address`)
        if (to === c.location) return bad(`Move ${quote(c)}: it is already at ${to}`)
        return row(`Move ${quote(c)} from ${c.location} to ${to}`, { needsConfirmation: true })
      }
      case 'container.swap': {
        const a = findContainer(op.containerId)
        const b = findContainer(op.otherContainerId)
        if (!a || !b) return bad(`Swap: one of the containers (${op.containerId}, ${op.otherContainerId}) was not found`)
        if (a.id === b.id) return bad('Swap: a container cannot be swapped with itself')
        if (a.location === b.location) return bad(`Swap ${quote(a)} and ${quote(b)}: both are already at ${a.location}`)
        return row(`Swap ${quote(a)} (${a.location}) with ${quote(b)} (${b.location})`, { needsConfirmation: true })
      }
      case 'container.merge': {
        const src = findContainer(op.containerId)
        const dst = findContainer(op.targetContainerId)
        if (!src || !dst) return bad(`Merge: one of the containers (${op.containerId}, ${op.targetContainerId}) was not found`)
        if (src.id === dst.id) return bad('Merge: a container cannot be merged into itself')
        return row(
          `Merge ${quote(src)} (${src.location}, ${src.contents.length} item stack${
            src.contents.length === 1 ? '' : 's'
          }) into ${quote(dst)} (${dst.location}), then trash the empty box`,
          { needsConfirmation: true }
        )
      }
      case 'container.create': {
        const to = normalizeLocation(op.location)
        if (!LOCATION_RE.test(to)) return bad(`New container: "${op.location ?? ''}" is not a valid address`)
        if (!op.label?.trim()) return bad('New container: no label given')
        return row(
          `Create container "${op.label.trim()}" at ${to}${op.containerTypeName ? ` (${op.containerTypeName})` : ''}`
        )
      }
      case 'container.update': {
        const c = findContainer(op.containerId)
        if (!c) return bad(`Edit: no active container with id ${op.containerId ?? '(none given)'}`)
        if (op.location !== undefined) {
          // Relocating is physical work, so it is never smuggled in as an edit.
          return bad(`Edit ${quote(c)}: use a move or swap to change an address, not an edit`)
        }
        const bits: string[] = []
        if (op.label !== undefined && op.label.trim() !== c.label) bits.push(`label to "${op.label.trim()}"`)
        if (op.containerTypeName !== undefined) bits.push(`type to "${op.containerTypeName}"`)
        if (op.notes !== undefined) bits.push('notes')
        if (bits.length === 0) return bad(`Edit ${quote(c)}: nothing would change`)
        return row(`Edit ${quote(c)}: set ${bits.join(', ')}`)
      }
      case 'container.trash': {
        const c = findContainer(op.containerId)
        if (!c) return bad(`Trash: no active container with id ${op.containerId ?? '(none given)'}`)
        return row(`Move ${quote(c)} (${c.location}) to Deleted Containers`)
      }
      case 'item.create': {
        const name = op.itemName?.trim()
        if (!name) return bad('New item: no name given')
        const key = name.toLowerCase()
        if (state.items.some((i) => i.name.trim().toLowerCase() === key) || newItemNames.has(key)) {
          return bad(`New item "${name}": an item with that name already exists`)
        }
        newItemNames.add(key)
        return row(`Create item "${name}"`)
      }
      case 'itemstack.add': {
        const c = findContainer(op.containerId)
        if (!c) return bad(`Add item: no active container with id ${op.containerId ?? '(none given)'}`)
        const name = op.itemName?.trim()
        if (!name) return bad(`Add item to ${quote(c)}: no item name given`)
        newItemNames.add(name.toLowerCase())
        const qty = (op.quantity ?? '').trim() || DEFAULT_QUANTITY
        return row(`Put "${name}" x${qty} in ${quote(c)} (${c.location})`)
      }
      case 'itemstack.update': {
        const stack = state.itemStacks.find((st) => st.id === op.itemStackId)
        if (!stack) return bad(`Change quantity: no item stack with id ${op.itemStackId ?? '(none given)'}`)
        const name = state.items.find((i) => i.id === stack.itemRef)?.name ?? stack.id
        const qty = (op.quantity ?? '').trim() || DEFAULT_QUANTITY
        return row(`Set "${name}" quantity to ${qty} (was ${stack.quantity})`)
      }
      case 'itemstack.remove': {
        const stack = state.itemStacks.find((st) => st.id === op.itemStackId)
        if (!stack) return bad(`Remove item: no item stack with id ${op.itemStackId ?? '(none given)'}`)
        const name = state.items.find((i) => i.id === stack.itemRef)?.name ?? stack.id
        const owner = state.containers.find((c) => c.contents.includes(stack.id))
        return row(`Remove "${name}"${owner ? ` from ${quote(owner)}` : ''}`)
      }
      case 'containertype.create': {
        const name = op.containerTypeName?.trim()
        if (!name) return bad('New container type: no name given')
        const key = name.toLowerCase()
        if (state.containerTypes.some((t) => t.name.trim().toLowerCase() === key) || newTypeNames.has(key)) {
          return bad(`New container type "${name}": one with that name already exists`)
        }
        newTypeNames.add(key)
        return row(`Create container type "${name}"${op.color ? ` (${op.color})` : ''}`)
      }
      default:
        return bad(`Unsupported operation "${op.op}"`)
    }
  })
}

export interface AgentApplyResult {
  /** Changes written to the database immediately. */
  applied: number
  /** Proposals recorded for somebody to confirm physically. */
  proposed: number
}

/**
 * Writes an approved plan in a single atomic update, so a plan either lands
 * whole or not at all - a half-applied reorganisation would be worse than
 * none, since the shelf would then match neither the old nor the new layout.
 */
export async function applyAgentPlan(operations: AgentOperation[]): Promise<AgentApplyResult> {
  return withSaving(async () => {
    if (operations.length === 0) return { applied: 0, proposed: 0 }

    const updates: Record<string, unknown> = {}
    const logs: LogInput[] = []
    const now = Date.now()
    const by = currentUser()

    // Ids handed out during this batch, so ops in the same plan don't collide.
    const provisionalContainers: { id: string }[] = [...state.containers, ...state.trash]
    const provisionalItems: { id: string }[] = [...state.items]
    const provisionalStacks: { id: string }[] = [...state.itemStacks]
    const provisionalTypes: { id: string }[] = [...state.containerTypes]

    const itemIdByName = new Map(state.items.map((i) => [i.name.trim().toLowerCase(), i.id]))
    const typeIdByName = new Map(state.containerTypes.map((t) => [t.name.trim().toLowerCase(), t.id]))

    /** Resolves an item by name, creating it in this same batch if new - so
     *  "add M1 through M9 screws" doesn't need nine separate round trips. */
    function itemIdFor(rawName: string): string {
      const name = rawName.trim()
      const key = name.toLowerCase()
      const existing = itemIdByName.get(key)
      if (existing) return existing
      const id = nextId('I', provisionalItems)
      provisionalItems.push({ id })
      itemIdByName.set(key, id)
      updates[`items/${id}`] = compact({ name })
      logs.push({ action: 'item.create', summary: `AI: created item "${name}"` })
      return id
    }

    function typeIdFor(rawName: string | undefined): string | undefined {
      const name = rawName?.trim()
      if (!name) return undefined
      return typeIdByName.get(name.toLowerCase())
    }

    let applied = 0
    let proposed = 0

    // One box, one proposal. If a plan somehow proposes two things for the
    // same container, the second is dropped rather than overwriting the first
    // — silently replacing half a swap would leave the other half pointing at
    // a partner that is no longer swapping with it.
    const alreadyProposed = new Set<string>()

    /** Records physical work rather than doing it. */
    function propose(container: Container, move: PendingMove): boolean {
      if (alreadyProposed.has(container.id)) return false
      alreadyProposed.add(container.id)
      updates[`containers/${container.id}/pendingMove`] = dropUndefined({ ...move })
      proposed += 1
      return true
    }

    for (const op of operations) {
      switch (op.op) {
        case 'container.move': {
          const c = findContainer(op.containerId)
          if (!c) break
          const to = normalizeLocation(op.location)
          if (!propose(c, { kind: 'move', from: c.location, to, reason: op.reason ?? '', at: now, by })) break
          logs.push({
            action: 'container.moveProposed',
            summary: `AI proposed moving "${c.label || c.id}" from ${c.location} to ${to}`,
            containerId: c.id,
          })
          break
        }
        case 'container.swap': {
          const a = findContainer(op.containerId)
          const b = findContainer(op.otherContainerId)
          if (!a || !b) break
          const reason = op.reason ?? ''
          // Half a swap is not a job anyone can do, so if either box is
          // already spoken for in this plan, skip the pair entirely.
          if (alreadyProposed.has(a.id) || alreadyProposed.has(b.id)) break
          propose(a, { kind: 'move', from: a.location, to: b.location, reason, at: now, by, swapWith: b.id })
          propose(b, { kind: 'move', from: b.location, to: a.location, reason, at: now, by, swapWith: a.id })
          logs.push({
            action: 'container.moveProposed',
            summary: `AI proposed swapping "${a.label || a.id}" (${a.location}) with "${b.label || b.id}" (${b.location})`,
            containerId: a.id,
          })
          break
        }
        case 'container.merge': {
          const src = findContainer(op.containerId)
          const dst = findContainer(op.targetContainerId)
          if (!src || !dst) break
          const recorded = propose(src, {
            kind: 'merge',
            from: src.location,
            to: dst.location,
            reason: op.reason ?? '',
            at: now,
            by,
            mergeInto: dst.id,
          })
          if (!recorded) break
          logs.push({
            action: 'container.mergeProposed',
            summary: `AI proposed merging "${src.label || src.id}" into "${dst.label || dst.id}" at ${dst.location}`,
            containerId: src.id,
          })
          break
        }
        case 'container.create': {
          const id = nextId('C', provisionalContainers)
          provisionalContainers.push({ id })
          const to = normalizeLocation(op.location)
          const label = (op.label ?? '').trim()
          updates[`containers/${id}`] = compact({
            location: to,
            label,
            containerType: typeIdFor(op.containerTypeName),
            notes: op.notes,
          })
          logs.push({
            action: 'container.create',
            summary: `AI: created container "${label}" at ${to}`,
            containerId: id,
          })
          applied += 1
          break
        }
        case 'container.update': {
          const c = findContainer(op.containerId)
          if (!c) break
          if (op.label !== undefined) updates[`containers/${c.id}/label`] = op.label.trim() || null
          if (op.notes !== undefined) updates[`containers/${c.id}/notes`] = op.notes.trim() || null
          if (op.containerTypeName !== undefined) {
            updates[`containers/${c.id}/containerType`] = typeIdFor(op.containerTypeName) ?? null
          }
          logs.push({
            action: 'container.update',
            summary: `AI: edited container "${c.label || c.id}"`,
            containerId: c.id,
          })
          applied += 1
          break
        }
        case 'container.trash': {
          const c = findContainer(op.containerId)
          if (!c) break
          updates[`containers/${c.id}/deleted`] = true
          updates[`containers/${c.id}/deletedAt`] = now
          updates[`containers/${c.id}/deletedBy`] = by
          logs.push({
            action: 'container.trash',
            summary: `AI: moved "${c.label || c.id}" (${c.location}) to Deleted Containers`,
            containerId: c.id,
          })
          applied += 1
          break
        }
        case 'item.create': {
          itemIdFor(op.itemName ?? '')
          applied += 1
          break
        }
        case 'itemstack.add': {
          const c = findContainer(op.containerId)
          if (!c) break
          const itemName = (op.itemName ?? '').trim()
          const itemRef = itemIdFor(itemName)
          const quantity = normalizeQuantity(op.quantity)
          const id = nextId('IS', provisionalStacks)
          provisionalStacks.push({ id })
          updates[`itemStacks/${id}`] = compact({ itemRef, quantity })
          updates[`containers/${c.id}/contents/${id}`] = true
          logs.push({
            action: 'itemstack.add',
            summary: `AI: added "${itemName}" x${quantity} to ${c.label || c.id}`,
            containerId: c.id,
          })
          applied += 1
          break
        }
        case 'itemstack.update': {
          const stack = state.itemStacks.find((st) => st.id === op.itemStackId)
          if (!stack) break
          const quantity = normalizeQuantity(op.quantity)
          updates[`itemStacks/${stack.id}/quantity`] = quantity
          const name = state.items.find((i) => i.id === stack.itemRef)?.name ?? stack.id
          logs.push({ action: 'itemstack.update', summary: `AI: set "${name}" quantity to ${quantity}` })
          applied += 1
          break
        }
        case 'itemstack.remove': {
          const stack = state.itemStacks.find((st) => st.id === op.itemStackId)
          if (!stack) break
          const owner = state.containers.find((c) => c.contents.includes(stack.id))
          updates[`itemStacks/${stack.id}`] = null
          if (owner) updates[`containers/${owner.id}/contents/${stack.id}`] = null
          const name = state.items.find((i) => i.id === stack.itemRef)?.name ?? stack.id
          logs.push({
            action: 'itemstack.remove',
            summary: `AI: removed "${name}"${owner ? ` from ${owner.label || owner.id}` : ''}`,
            containerId: owner?.id,
          })
          applied += 1
          break
        }
        case 'containertype.create': {
          const id = nextId('CT', provisionalTypes)
          provisionalTypes.push({ id })
          const name = (op.containerTypeName ?? '').trim()
          updates[`containerTypes/${id}`] = compact({ name, color: op.color })
          typeIdByName.set(name.toLowerCase(), id)
          logs.push({ action: 'containertype.create', summary: `AI: created container type "${name}"` })
          applied += 1
          break
        }
        default:
          break
      }
    }

    addLogsToUpdates(updates, logs)
    await update(rootRef(), updates)
    return { applied, proposed }
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
    // UNKNOWN_LOCATION is a placeholder, not a shelving unit: there is nothing
    // there to photograph, so it must not reach the Scan Shelf dropdown.
    if (root && root !== UNKNOWN_LOCATION) set.add(root)
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
