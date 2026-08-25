<script setup lang="ts">
import { computed, ref } from 'vue'
import { warehouse } from '../store/warehouse'

const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return warehouse.logs
  return warehouse.logs.filter(
    (l) => l.summary.toLowerCase().includes(q) || l.user.toLowerCase().includes(q)
  )
})

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Groups the action into a coarse category for the colour of the dot. */
function tone(action: string): string {
  if (action.includes('trash') || action.includes('delete') || action.includes('purge')) return 'danger'
  if (action.includes('create') || action.includes('restore')) return 'success'
  return 'neutral'
}
</script>

<template>
  <div class="logs-view">
    <div class="panel-toolbar">
      <input v-model="query" type="search" placeholder="Search the change log…" />
    </div>

    <p v-if="warehouse.logs.length === 0" class="hint">
      No changes recorded yet. Every edit, scan, and deletion from here on will show up in this list.
    </p>
    <p v-else-if="filtered.length === 0" class="hint">Nothing matches “{{ query }}”.</p>

    <div v-else class="log-list">
      <div v-for="entry in filtered" :key="entry.id" class="log-row">
        <span class="dot" :class="tone(entry.action)" />
        <span class="summary">{{ entry.summary }}</span>
        <span class="user">{{ entry.user }}</span>
        <span class="time">{{ formatTime(entry.at) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.logs-view {
  max-width: 1000px;
}

.hint {
  color: var(--text-muted);
  margin-top: 20px;
  font-size: 13px;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  font-size: 13px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 8px;
}
.dot.danger {
  background: var(--danger);
}
.dot.success {
  background: var(--success);
}
.dot.neutral {
  background: var(--accent);
}

.summary {
  flex: 1;
  min-width: 0;
}

.user {
  color: var(--text);
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  white-space: nowrap;
}

.time {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
  white-space: nowrap;
}

@media (max-width: 860px) {
  /* Summary on its own line, then user + time beneath it. */
  .log-row {
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 10px 12px;
  }
  .dot {
    order: 1;
  }
  .summary {
    order: 2;
    flex: 1 1 calc(100% - 20px);
  }
  .user {
    order: 3;
  }
  .time {
    order: 4;
  }
}
</style>
