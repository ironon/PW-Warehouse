<script setup lang="ts">
// Some things in the warehouse ARE their own box — a spool, a case, a machine
// on a pallet. Recording those means the same name typed into two places, so
// this does both at once.
import { nextTick, ref, useTemplateRef } from 'vue'
import { addItemContainer, UNKNOWN_LOCATION, warehouse } from '../../store/warehouse'

const name = ref('')
const notes = ref('')
const error = ref('')
const nameInput = useTemplateRef<HTMLInputElement>('nameInput')

/** What this session has added, newest first — the form no longer disappears
 *  on success, so this is what tells you the click actually did something. */
const created = ref<{ name: string; itemId: string; containerId: string }[]>([])

async function create() {
  const trimmed = name.value.trim()
  if (!trimmed || warehouse.saving) return
  error.value = ''
  try {
    const result = await addItemContainer({ name: trimmed, notes: notes.value })
    created.value = [
      { name: trimmed, itemId: result.item.id, containerId: result.container.id },
      ...created.value,
    ]
    name.value = ''
    notes.value = ''
    // Straight back to the top field, so a run of these is all typing.
    await nextTick()
    nameInput.value?.focus()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div>
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div class="form-card">
      <h3 class="section-heading">New item container</h3>
      <p class="hint">
        For something that is its own box. Creates an <strong>item</strong> with this name and notes, and a
        <strong>container</strong> labelled the same, at location <code>{{ UNKNOWN_LOCATION }}</code> with no
        container type. Both are written together, so you never end up with one without the other. Set the real
        location afterwards from the Containers tab, or let the AI Work tab find it a home.
      </p>

      <div class="form-grid single">
        <div class="field">
          <label>Item Container Name</label>
          <input
            ref="nameInput"
            v-model="name"
            type="text"
            placeholder="e.g. Yellow cable drum"
            @keydown.enter.prevent="create"
          />
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea v-model="notes" rows="2"></textarea>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn btn-primary" :disabled="!name.trim() || warehouse.saving" @click="create">
          Create item container
        </button>
      </div>
    </div>

    <div v-if="created.length" class="created">
      <span class="created-title">Added just now</span>
      <div v-for="entry in created" :key="entry.containerId" class="created-row">
        <span class="created-name">{{ entry.name }}</span>
        <span class="muted">{{ entry.itemId }} · {{ entry.containerId }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.created {
  margin-top: 20px;
}

.created-title {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.created-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
}

.created-name {
  font-weight: 600;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
}
</style>
