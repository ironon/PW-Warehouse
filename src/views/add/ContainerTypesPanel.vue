<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import {
  warehouse,
  addContainerType,
  updateContainerType,
  deleteContainerType,
  containersMatchingLocationPrefix,
  bulkSetContainerType,
} from '../../store/warehouse'

const query = ref('')
const filtered = computed(() =>
  warehouse.containerTypes.filter((t) => t.name.toLowerCase().includes(query.value.trim().toLowerCase()))
)

const showNewForm = ref(false)
const newName = ref('')
const newColor = ref('#2f6fed')
const error = ref('')
// Same as the other Add panels: the form stays open for a run of entries, so
// this is what confirms each one landed.
const createdNote = ref('')
const newNameInput = useTemplateRef<HTMLInputElement>('newNameInput')

function toggleNewForm() {
  showNewForm.value = !showNewForm.value
  createdNote.value = ''
}

const expandedId = ref<string | null>(null)
const editName = ref('')
const editColor = ref('#2f6fed')

async function create() {
  const name = newName.value.trim()
  if (!name || warehouse.saving) return
  error.value = ''
  try {
    await addContainerType({ name, color: newColor.value })
    // Only the name clears — the colour is usually nudged from the picker for
    // each new type, and resetting it would undo that every time.
    newName.value = ''
    createdNote.value = `Created “${name}”.`
    await nextTick()
    newNameInput.value?.focus()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function expand(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  const t = warehouse.containerTypes.find((c) => c.id === id)
  if (!t) return
  expandedId.value = id
  editName.value = t.name
  editColor.value = t.color || '#2f6fed'
}

async function saveEdit(id: string) {
  error.value = ''
  try {
    await updateContainerType(id, { name: editName.value.trim(), color: editColor.value })
    expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function remove(id: string) {
  if (!confirm('Delete this container type? Containers using it will become uncategorized.')) return
  error.value = ''
  try {
    await deleteContainerType(id)
    expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

// --- Bulk assign by shelf prefix ---------------------------------------
const bulkPrefix = ref('')
const bulkTypeId = ref('')
const bulkStatus = ref('')
const bulkMatches = computed(() => containersMatchingLocationPrefix(bulkPrefix.value))

async function applyBulk() {
  if (!bulkPrefix.value.trim() || !bulkTypeId.value) return
  const typeName = warehouse.containerTypes.find((t) => t.id === bulkTypeId.value)?.name ?? bulkTypeId.value
  if (!confirm(`Set ${bulkMatches.value.length} container(s) at "${bulkPrefix.value.trim()}" to "${typeName}"?`)) return
  error.value = ''
  bulkStatus.value = ''
  try {
    const count = await bulkSetContainerType(bulkPrefix.value.trim(), bulkTypeId.value)
    bulkStatus.value = `Updated ${count} container${count === 1 ? '' : 's'} to "${typeName}".`
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div>
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div class="form-card bulk-card">
      <h3 class="bulk-heading">Bulk assign by shelf</h3>
      <p class="bulk-hint">Set every container at a shelf (e.g. "SL1-M" or "SL2-L") to one container type at once.</p>
      <div class="form-grid">
        <div class="field">
          <label>Shelf prefix</label>
          <input v-model="bulkPrefix" type="text" placeholder="e.g. SL1-M" />
        </div>
        <div class="field">
          <label>Container Type</label>
          <select v-model="bulkTypeId">
            <option value="" disabled>Select a type…</option>
            <option v-for="t in warehouse.containerTypes" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
      </div>
      <div class="form-actions bulk-actions">
        <span class="muted">
          <template v-if="bulkPrefix.trim()">{{ bulkMatches.length }} container{{ bulkMatches.length === 1 ? '' : 's' }} match</template>
        </span>
        <button class="btn btn-primary" :disabled="!bulkPrefix.trim() || !bulkTypeId || bulkMatches.length === 0" @click="applyBulk">
          Apply
        </button>
      </div>
      <p v-if="bulkStatus" class="bulk-status">{{ bulkStatus }}</p>
    </div>

    <div class="panel-toolbar">
      <input v-model="query" type="search" placeholder="Search container types…" />
      <button class="btn btn-primary" @click="toggleNewForm">
        {{ showNewForm ? 'Done' : '+ New Container Type' }}
      </button>
    </div>

    <div v-if="showNewForm" class="form-card">
      <div class="form-grid">
        <div class="field">
          <label>Name</label>
          <input
            ref="newNameInput"
            v-model="newName"
            type="text"
            placeholder="e.g. Small Tote"
            @keydown.enter.prevent="create"
          />
        </div>
        <div class="field">
          <label>Color</label>
          <input v-model="newColor" type="color" />
        </div>
      </div>
      <div class="form-actions">
        <span v-if="createdNote" class="created-note">{{ createdNote }}</span>
        <button class="btn btn-primary" :disabled="!newName.trim() || warehouse.saving" @click="create">
          Create type
        </button>
      </div>
    </div>

    <div class="panel-list">
      <template v-for="t in filtered" :key="t.id">
        <div class="panel-row" :class="{ expanded: expandedId === t.id }" @click="expand(t.id)">
          <span class="swatch-row">
            <span class="swatch" :style="{ background: t.color || 'transparent' }" />
            {{ t.name }}
          </span>
          <span class="muted">{{ t.id }}</span>
        </div>
        <div v-if="expandedId === t.id" class="form-card" @click.stop>
          <div class="form-grid">
            <div class="field">
              <label>Name</label>
              <input v-model="editName" type="text" />
            </div>
            <div class="field">
              <label>Color</label>
              <input v-model="editColor" type="color" />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-danger" @click="remove(t.id)">Delete</button>
            <button class="btn btn-primary" @click="saveEdit(t.id)">Save</button>
          </div>
        </div>
      </template>
      <p v-if="filtered.length === 0" class="muted empty">No container types yet.</p>
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

.muted {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
}
.empty {
  padding: 12px 0;
}
.swatch-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.swatch {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--border);
  display: inline-block;
}
.bulk-card {
  background: var(--accent-bg);
  border-color: var(--accent);
}
.bulk-heading {
  font-size: 14px;
  margin-bottom: 4px;
}
.bulk-hint {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0 0 12px;
}
.bulk-actions {
  align-items: center;
  justify-content: space-between;
}
.bulk-status {
  color: var(--success);
  font-size: 13px;
  margin: 10px 0 0;
}

@media (max-width: 860px) {
  /* The match-count span is empty until a prefix is typed, which otherwise
     leaves the Apply button oddly indented. */
  .bulk-actions {
    flex-wrap: wrap;
    gap: 8px;
  }
  .bulk-actions .muted:empty {
    display: none;
  }
  .bulk-actions .btn {
    flex: 1 1 100%;
  }
}
</style>
