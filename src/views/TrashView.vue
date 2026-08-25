<script setup lang="ts">
import { ref } from 'vue'
import { warehouse, restoreContainer, purgeContainer, emptyTrash, containerTypeById } from '../store/warehouse'
import { readableTextColor } from '../lib/color'

const error = ref('')

function formatTime(at?: number): string {
  if (!at) return ''
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

async function restore(id: string) {
  error.value = ''
  try {
    await restoreContainer(id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function purge(id: string, label: string) {
  if (!confirm(`Permanently delete "${label || id}"? This can't be undone.`)) return
  error.value = ''
  try {
    await purgeContainer(id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function empty() {
  const count = warehouse.trash.length
  if (!confirm(`Permanently delete all ${count} container${count === 1 ? '' : 's'} in the trash? This can't be undone.`)) return
  error.value = ''
  try {
    await emptyTrash()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div class="trash-view">
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div class="panel-toolbar">
      <p class="intro">
        Containers removed by hand or by a shelf scan land here. Restoring one puts it back at its old position with
        its contents intact.
      </p>
      <button class="btn btn-danger" :disabled="warehouse.trash.length === 0" @click="empty">Empty trash</button>
    </div>

    <p v-if="warehouse.trash.length === 0" class="hint">Deleted Containers is empty.</p>

    <div v-else class="panel-list">
      <div v-for="c in warehouse.trash" :key="c.id" class="panel-row trash-row">
        <span class="row-main">
          <span class="location">{{ c.location }}</span>
          <span class="label">{{ c.label || '(no label)' }}</span>
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
        <span class="meta">
          {{ c.deletedBy }}{{ c.deletedAt ? ` · ${formatTime(c.deletedAt)}` : '' }}
        </span>
        <span class="actions">
          <button class="btn small" @click="restore(c.id)">Restore</button>
          <button class="btn small btn-danger" @click="purge(c.id, c.label)">Delete forever</button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash-view {
  max-width: 1000px;
}

.panel-toolbar {
  align-items: center;
}

.intro {
  flex: 1;
  color: var(--text-muted);
  font-size: 13px;
  margin: 0;
}

.hint {
  color: var(--text-muted);
  font-size: 13px;
  margin-top: 20px;
}

.trash-row {
  cursor: default;
}
.trash-row:hover {
  background: var(--bg-elevated);
}

.row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.location {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
  min-width: 80px;
}

.label {
  font-weight: 600;
}

.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-bg);
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.35);
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
  margin-right: 12px;
}

.actions {
  display: flex;
  gap: 6px;
}

.btn.small {
  padding: 5px 10px;
  font-size: 12px;
}

@media (max-width: 860px) {
  .panel-toolbar {
    flex-wrap: wrap;
  }
  .intro {
    flex: 1 1 100%;
  }
  .row-main {
    flex: 1 1 100%;
    flex-wrap: wrap;
    gap: 6px;
  }
  .location {
    min-width: 0;
  }
  .meta {
    margin-right: 0;
  }
  .actions {
    margin-left: auto;
  }
}
</style>
