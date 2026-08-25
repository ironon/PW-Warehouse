<script setup lang="ts">
import { computed, ref } from 'vue'
import { warehouse, addItem, updateItem, deleteItem } from '../../store/warehouse'

const query = ref('')
const filtered = computed(() =>
  warehouse.items.filter((i) => i.name.toLowerCase().includes(query.value.trim().toLowerCase()))
)

const showNewForm = ref(false)
const newName = ref('')
const newNotes = ref('')
const error = ref('')

const expandedId = ref<string | null>(null)
const editName = ref('')
const editNotes = ref('')

async function createItem() {
  if (!newName.value.trim()) return
  error.value = ''
  try {
    await addItem({ name: newName.value.trim(), notes: newNotes.value.trim() })
    newName.value = ''
    newNotes.value = ''
    showNewForm.value = false
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function expand(id: string) {
  if (expandedId.value === id) {
    expandedId.value = null
    return
  }
  const item = warehouse.items.find((i) => i.id === id)
  if (!item) return
  expandedId.value = id
  editName.value = item.name
  editNotes.value = item.notes
}

async function saveEdit(id: string) {
  error.value = ''
  try {
    await updateItem(id, { name: editName.value.trim(), notes: editNotes.value.trim() })
    expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function remove(id: string) {
  if (!confirm('Delete this item?')) return
  error.value = ''
  try {
    await deleteItem(id)
    expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div>
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div class="panel-toolbar">
      <input v-model="query" type="search" placeholder="Search items…" />
      <button class="btn btn-primary" @click="showNewForm = !showNewForm">
        {{ showNewForm ? 'Cancel' : '+ New Item' }}
      </button>
    </div>

    <div v-if="showNewForm" class="form-card">
      <div class="form-grid single">
        <div class="field">
          <label>Name</label>
          <input v-model="newName" type="text" placeholder="Item name" />
        </div>
        <div class="field">
          <label>Notes</label>
          <textarea v-model="newNotes" rows="2" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" :disabled="!newName.trim()" @click="createItem">Create item</button>
      </div>
    </div>

    <div class="panel-list">
      <template v-for="item in filtered" :key="item.id">
        <div class="panel-row" :class="{ expanded: expandedId === item.id }" @click="expand(item.id)">
          <span>{{ item.name }}</span>
          <span class="muted">{{ item.id }}</span>
        </div>
        <div v-if="expandedId === item.id" class="form-card" @click.stop>
          <div class="form-grid single">
            <div class="field">
              <label>Name</label>
              <input v-model="editName" type="text" />
            </div>
            <div class="field">
              <label>Notes</label>
              <textarea v-model="editNotes" rows="2" />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-danger" @click="remove(item.id)">Delete</button>
            <button class="btn btn-primary" @click="saveEdit(item.id)">Save</button>
          </div>
        </div>
      </template>
      <p v-if="filtered.length === 0" class="muted empty">No items yet.</p>
    </div>
  </div>
</template>

<style scoped>
.muted {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
}
.empty {
  padding: 12px 0;
}
</style>
