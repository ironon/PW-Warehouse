<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import {
  warehouse,
  addContainer,
  updateContainer,
  deleteContainer,
  addItem,
  addItemStack,
  updateItemStack,
  removeItemStack,
  itemById,
  itemStackById,
  containerTypeById,
} from '../../store/warehouse'
import { readableTextColor } from '../../lib/color'
import { printLabel, DEFAULT_COPIES } from '../../lib/labelPrinter'
import PrintLabelDialog from '../../components/PrintLabelDialog.vue'
import PendingMoveBadge from '../../components/PendingMoveBadge.vue'
import { matchNames } from '../../lib/similar'
import NameMatches from '../../components/NameMatches.vue'
import {
  recentContainerIds,
  markContainerViewed,
  clearRecentContainers,
} from '../../store/recentContainers'

// --- Label printing ---------------------------------------------------
// A prompt appears after a manual create or rename. Scan-applied changes
// deliberately do not prompt, so a shelf scan can't kick off a bulk print.
const printPromptText = ref('')
const printPromptReason = ref<'created' | 'renamed'>('created')
const printingId = ref<string | null>(null)
const printStatus = ref('')

function promptPrint(text: string, reason: 'created' | 'renamed') {
  if (!text.trim()) return
  printPromptReason.value = reason
  printPromptText.value = text.trim()
}

/** The per-container button: always prints both copies, no prompt. */
async function printNow(id: string, text: string) {
  if (!text.trim()) {
    error.value = 'This container has no label to print.'
    return
  }
  printingId.value = id
  printStatus.value = ''
  error.value = ''
  try {
    const n = await printLabel(text.trim(), DEFAULT_COPIES)
    printStatus.value = `Sent ${n} label${n === 1 ? '' : 's'} to the printer.`
    setTimeout(() => (printStatus.value = ''), 4000)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    printingId.value = null
  }
}

const query = ref('')
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return warehouse.containers
  return warehouse.containers.filter(
    (c) => c.label.toLowerCase().includes(q) || c.location.toLowerCase().includes(q) || c.id.toLowerCase() === q
  )
})

const error = ref('')

// --- New container ---------------------------------------------------
const showNewForm = ref(false)
const newLocation = ref('')
const newLabel = ref('')
const newContainerType = ref('')
const newNotes = ref('')
// The form stays open after a create, so this is the only thing confirming
// the click landed.
const createdNote = ref('')
const newLabelInput = useTemplateRef<HTMLInputElement>('newLabelInput')

// A container is identified by its label, and two containers sharing one is a
// real problem, not a cosmetic one: a shelf scan can't tell them apart and
// skips both. So a duplicate label blocks creation.
const labelMatches = computed(() =>
  matchNames(
    newLabel.value,
    warehouse.containers.map((c) => ({ id: c.id, name: c.label, detail: c.location }))
  )
)
const isDuplicateLabel = computed(() => labelMatches.value.exact.length > 0)

// A trashed container with the same label doesn't block anything - it isn't in
// the scanner's index - but it usually means the box should be restored rather
// than recreated from scratch.
const trashedMatches = computed(() =>
  matchNames(
    newLabel.value,
    warehouse.trash.map((c) => ({ id: c.id, name: c.label, detail: 'in Deleted' }))
  )
)

function toggleNewForm() {
  showNewForm.value = !showNewForm.value
  createdNote.value = ''
}

async function createContainer() {
  if (!newLocation.value.trim() || warehouse.saving || isDuplicateLabel.value) return
  error.value = ''
  try {
    const c = await addContainer({
      location: newLocation.value.trim(),
      label: newLabel.value.trim(),
      containerType: newContainerType.value,
      notes: newNotes.value.trim(),
    })
    const createdLabel = newLabel.value.trim()

    // Location and type carry over — a run of new boxes is usually the same
    // shelf and the same kind of box. Label and notes identify one specific
    // box, so they always clear.
    newLabel.value = ''
    newNotes.value = ''
    createdNote.value = `Created “${createdLabel || c.id}” at ${c.location}.`

    // Open the new container so its contents can be filled in straight away,
    // seeded from what was actually created. (Leaving the edit fields holding
    // whatever was last edited would let Save overwrite the new container with
    // another one's details.)
    expandedId.value = c.id
    editLocation.value = c.location
    editLabel.value = c.label
    editContainerType.value = c.containerType
    editNotes.value = c.notes
    newStackItemName.value = ''
    newStackQuantity.value = ''

    if (createdLabel) {
      // The print prompt is the thing that wants attention now; stealing focus
      // back to the form behind it would just fight the dialog.
      promptPrint(createdLabel, 'created')
    } else {
      await nextTick()
      newLabelInput.value?.focus()
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

// --- Edit existing container -------------------------------------------
const expandedId = ref<string | null>(null)
const editLocation = ref('')
const editLabel = ref('')
const editContainerType = ref('')
const editNotes = ref('')
const newStackItemName = ref('')
const newStackQuantity = ref('')

// Resolved against live data so trashed or deleted containers drop out of
// the list rather than lingering as dead entries.
const recentContainers = computed(() =>
  recentContainerIds.value
    .map((id) => warehouse.containers.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
)

/** Jumps straight to a container: filters the list to it and opens it. */
function openRecent(id: string) {
  query.value = id
  const c = warehouse.containers.find((x) => x.id === id)
  if (!c) return
  expandedId.value = id
  editLocation.value = c.location
  editLabel.value = c.label
  editContainerType.value = c.containerType
  editNotes.value = c.notes
  newStackItemName.value = ''
  newStackQuantity.value = ''
  markContainerViewed(id)
}

function expand(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  const c = warehouse.containers.find((x) => x.id === id)
  if (!c) return
  markContainerViewed(id)
  expandedId.value = id
  editLocation.value = c.location
  editLabel.value = c.label
  editContainerType.value = c.containerType
  editNotes.value = c.notes
  newStackItemName.value = ''
  newStackQuantity.value = ''
}

async function saveEdit(id: string) {
  error.value = ''
  const previousLabel = warehouse.containers.find((c) => c.id === id)?.label ?? ''
  const nextLabel = editLabel.value.trim()
  try {
    await updateContainer(id, {
      location: editLocation.value.trim(),
      label: nextLabel,
      containerType: editContainerType.value,
      notes: editNotes.value.trim(),
    })
    // Only the name appears on a label, so only a rename invalidates it.
    if (nextLabel && nextLabel !== previousLabel) promptPrint(nextLabel, 'renamed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function remove(id: string) {
  if (!confirm('Delete this container and everything inside it?')) return
  error.value = ''
  try {
    await deleteContainer(id)
    expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function contentsOf(containerId: string) {
  const c = warehouse.containers.find((x) => x.id === containerId)
  if (!c) return []
  return c.contents
    .map((id) => itemStackById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((stack) => ({ stack, item: itemById(stack.itemRef) }))
}

async function addContentToContainer(containerId: string) {
  const name = newStackItemName.value.trim()
  if (!name) return
  error.value = ''
  try {
    let item = warehouse.items.find((i) => i.name.toLowerCase() === name.toLowerCase())
    if (!item) {
      item = await addItem({ name })
    }
    await addItemStack({ containerId, itemRef: item.id, quantity: newStackQuantity.value.trim() })
    newStackItemName.value = ''
    newStackQuantity.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function changeQuantity(stackId: string, quantity: string) {
  error.value = ''
  try {
    await updateItemStack(stackId, { quantity })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function removeContent(stackId: string) {
  error.value = ''
  try {
    await removeItemStack(stackId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div>
    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-if="printStatus" class="ok-banner">{{ printStatus }}</p>

    <PrintLabelDialog
      v-if="printPromptText"
      :text="printPromptText"
      :reason="printPromptReason"
      @close="printPromptText = ''"
    />

    <div class="panel-toolbar">
      <input v-model="query" type="search" placeholder="Search containers by label, location, or id…" />
      <button class="btn btn-primary" @click="toggleNewForm">
        {{ showNewForm ? 'Done' : '+ New Container' }}
      </button>
    </div>

    <div v-if="recentContainers.length" class="recent">
      <div class="recent-head">
        <span class="recent-title">Recently viewed</span>
        <button class="recent-clear" @click="clearRecentContainers">Clear</button>
      </div>
      <div class="recent-chips">
        <button
          v-for="c in recentContainers"
          :key="c.id"
          class="chip"
          :class="{ active: expandedId === c.id }"
          :title="`${c.label || '(no label)'} — ${c.location}`"
          @click="openRecent(c.id)"
        >
          <span class="chip-loc">{{ c.location }}</span>
          <span class="chip-label">{{ c.label || '(no label)' }}</span>
        </button>
      </div>
    </div>

    <div v-if="showNewForm" class="form-card">
      <div class="form-grid">
        <div class="field">
          <label>Location</label>
          <input v-model="newLocation" type="text" placeholder="e.g. SL1-M-A" />
        </div>
        <div class="field">
          <label>Label</label>
          <input
            ref="newLabelInput"
            v-model="newLabel"
            type="text"
            placeholder="What's in/on this container"
            @keydown.enter.prevent="createContainer"
          />
        </div>
        <div class="field">
          <label>Container Type</label>
          <select v-model="newContainerType">
            <option value="">Unknown</option>
            <option v-for="t in warehouse.containerTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
        <div class="field">
          <label>Notes</label>
          <input v-model="newNotes" type="text" />
        </div>
      </div>
      <NameMatches :result="labelMatches" noun="container" />
      <NameMatches
        v-if="trashedMatches.exact.length"
        :result="{ exact: trashedMatches.exact, similar: [] }"
        noun="deleted container"
        :blocking="false"
      />

      <div class="form-actions">
        <span v-if="createdNote" class="created-note">{{ createdNote }}</span>
        <button
          class="btn btn-primary"
          :disabled="!newLocation.trim() || warehouse.saving || isDuplicateLabel"
          @click="createContainer"
        >
          Create container
        </button>
      </div>
    </div>

    <div class="panel-list">
      <template v-for="c in filtered" :key="c.id">
        <div class="panel-row" :class="{ expanded: expandedId === c.id }" @click="expand(c.id)">
          <span class="row-main">
            <span class="location">{{ c.location }}</span>
            <span>{{ c.label || '(no label)' }}</span>
            <span
              v-if="c.containerType"
              class="type-badge"
              :style="{
                background: containerTypeById(c.containerType)?.color || undefined,
                color: readableTextColor(containerTypeById(c.containerType)?.color || ''),
              }"
            >
              {{ containerTypeById(c.containerType)?.name }}
            </span>
          </span>
          <span class="muted">{{ c.id }}</span>
        </div>

        <PendingMoveBadge v-if="c.pendingMove" :container-id="c.id" class="row-pending" @click.stop />

        <div v-if="expandedId === c.id" class="form-card" @click.stop>
          <div class="form-grid">
            <div class="field">
              <label>Location</label>
              <input v-model="editLocation" type="text" />
            </div>
            <div class="field">
              <label>Label</label>
              <input v-model="editLabel" type="text" />
            </div>
            <div class="field">
              <label>Container Type</label>
              <select v-model="editContainerType">
                <option value="">Unknown</option>
                <option v-for="t in warehouse.containerTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Notes</label>
              <input v-model="editNotes" type="text" />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-danger" @click="remove(c.id)">Delete container</button>
            <button
              class="btn"
              :disabled="printingId === c.id || !c.label"
              :title="c.label ? `Print ${DEFAULT_COPIES} labels for this container` : 'This container has no label'"
              @click="printNow(c.id, c.label)"
            >
              {{ printingId === c.id ? 'Printing…' : 'Print label' }}
            </button>
            <button class="btn btn-primary" @click="saveEdit(c.id)">Save</button>
          </div>

          <hr class="divider" />

          <h3 class="contents-heading">Contents</h3>
          <div class="contents-list">
            <div v-for="{ stack, item } in contentsOf(c.id)" :key="stack.id" class="content-row">
              <span class="content-name">{{ item?.name || stack.itemRef }}</span>
              <input
                class="qty-input"
                type="text"
                placeholder="1"
                :value="stack.quantity"
                @change="changeQuantity(stack.id, ($event.target as HTMLInputElement).value)"
              />
              <button class="btn btn-danger small" @click="removeContent(stack.id)">Remove</button>
            </div>
            <p v-if="contentsOf(c.id).length === 0" class="muted empty">Nothing recorded in this container yet.</p>
          </div>

          <div class="add-content-row">
            <input
              v-model="newStackItemName"
              type="text"
              list="item-names"
              placeholder="Item name (existing or new)"
            />
            <datalist id="item-names">
              <option v-for="i in warehouse.items" :key="i.id" :value="i.name" />
            </datalist>
            <input v-model="newStackQuantity" type="text" placeholder="1" class="qty-input" />
            <button class="btn" :disabled="!newStackItemName.trim()" @click="addContentToContainer(c.id)">Add item</button>
          </div>
        </div>
      </template>
      <p v-if="filtered.length === 0" class="muted empty">No containers found.</p>
    </div>
  </div>
</template>

<style scoped>
.created-note {
  margin-right: auto;
  align-self: center;
  font-size: 13px;
  color: var(--success);
}

/* Pulled up under its row so it reads as part of it, not as a separate item. */
.row-pending {
  margin: -2px 0 8px;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
}
.empty {
  padding: 12px 0;
}
.recent {
  margin-bottom: 16px;
}

.recent-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}

.recent-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.recent-clear {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px 4px;
  border-radius: 4px;
}
.recent-clear:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.recent-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  max-width: 100%;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: 13px;
  color: var(--text);
}
.chip:hover {
  background: var(--bg-hover);
}
.chip.active {
  border-color: var(--accent);
  background: var(--accent-bg);
  color: var(--accent);
}

.chip-loc {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  flex: 0 0 auto;
}
.chip.active .chip-loc {
  color: inherit;
}

.chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.location {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
  min-width: 80px;
}
.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-bg);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.35);
}
.divider {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}
.contents-heading {
  font-size: 13px;
  margin-bottom: 10px;
}
.contents-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}
.content-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.content-name {
  flex: 1;
}
.qty-input {
  width: 64px;
  padding: 6px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
}
.btn.small {
  padding: 5px 10px;
  font-size: 12px;
}
.add-content-row {
  display: flex;
  gap: 8px;
}
.add-content-row input[type='text']:not(.qty-input) {
  flex: 1;
  padding: 8px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
}

@media (max-width: 860px) {
  .row-main {
    flex: 1 1 100%;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .location {
    min-width: 0;
  }
  /* Item name takes the full width; quantity and Add sit beneath it. */
  .add-content-row {
    flex-wrap: wrap;
  }
  .add-content-row input[type='text']:not(.qty-input) {
    flex: 1 1 100%;
  }
  .add-content-row .btn {
    flex: 1;
  }
}
</style>
