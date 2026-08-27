<script setup lang="ts">
// Some things in the warehouse ARE their own box — a spool, a case, a machine
// on a pallet. Recording those means the same name typed into two places, so
// this does both at once.
import { computed, nextTick, ref, useTemplateRef } from 'vue'
import { addItemContainer, UNKNOWN_LOCATION, warehouse } from '../../store/warehouse'
import { matchNames } from '../../lib/similar'
import NameMatches from '../../components/NameMatches.vue'

const name = ref('')
const notes = ref('')
const error = ref('')
const nameInput = useTemplateRef<HTMLInputElement>('nameInput')

/** What this session has added, newest first — the form no longer disappears
 *  on success, so this is what tells you the click actually did something. */
const created = ref<{ name: string; itemId: string; containerId: string }[]>([])

// This writes into both collections, so it has to be clear of both. Checking
// only one would let it create an item that duplicates an existing container's
// label, or the other way round.
const itemMatches = computed(() =>
  matchNames(
    name.value,
    warehouse.items.map((i) => ({ id: i.id, name: i.name }))
  )
)
const containerMatches = computed(() =>
  matchNames(
    name.value,
    warehouse.containers.map((c) => ({ id: c.id, name: c.label, detail: c.location }))
  )
)
const isDuplicate = computed(
  () => itemMatches.value.exact.length > 0 || containerMatches.value.exact.length > 0
)

async function create() {
  const trimmed = name.value.trim()
  if (!trimmed || warehouse.saving || isDuplicate.value) return
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

      <NameMatches :result="itemMatches" noun="item" />
      <NameMatches :result="containerMatches" noun="container" />

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
        <button
          class="btn btn-primary"
          :disabled="!name.trim() || warehouse.saving || isDuplicate"
          @click="create"
        >
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
