<script setup lang="ts">
// Shared record of every AI Work conversation: who asked what, what the agent
// proposed, and which of it was actually applied. Read-only on purpose — the
// history is evidence, and editing it would defeat the point.
import { computed, ref, type DeepReadonly } from 'vue'
import { warehouse, deleteAiConversation } from '../../store/warehouse'
import type { AiConversation } from '../../lib/types'

// The store hands out deeply readonly views; this panel only ever reads, so it
// takes them as they come rather than copying every conversation.
type Conversation = DeepReadonly<AiConversation>

const query = ref('')
const expandedId = ref<string | null>(null)
const error = ref('')

const conversations = computed<readonly Conversation[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return warehouse.aiConversations
  return warehouse.aiConversations.filter(
    (c) =>
      c.title.toLowerCase().includes(q) ||
      c.user.toLowerCase().includes(q) ||
      c.messages.some((m) => m.text.toLowerCase().includes(q))
  )
})

function formatTime(at: number): string {
  if (!at) return ''
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Total changes actually written across a whole conversation. */
function totals(c: Conversation) {
  let applied = 0
  let proposed = 0
  for (const m of c.messages) {
    applied += m.applied ?? 0
    proposed += m.proposed ?? 0
  }
  return { applied, proposed, touched: applied + proposed > 0 }
}

function toggle(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

async function remove(c: Conversation) {
  if (!confirm(`Forget the conversation “${c.title}”? Any changes it made stay in the Logs tab.`)) return
  error.value = ''
  try {
    await deleteAiConversation(c.id)
    if (expandedId.value === c.id) expandedId.value = null
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <div>
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div class="panel-toolbar">
      <input v-model="query" type="search" placeholder="Search conversations by text, title, or person…" />
    </div>

    <p v-if="warehouse.aiConversations.length === 0" class="hint">
      No conversations yet. Everything asked of the agent in the Chat tab is recorded here, so anyone can see what
      was requested and what it changed.
    </p>
    <p v-else-if="conversations.length === 0" class="hint">Nothing matches “{{ query.trim() }}”.</p>

    <div v-else class="conv-list">
      <template v-for="c in conversations" :key="c.id">
        <div class="panel-row" :class="{ expanded: expandedId === c.id }" @click="toggle(c.id)">
          <span class="row-main">
            <span class="conv-title">{{ c.title }}</span>
            <span v-if="totals(c).touched" class="badge-applied">
              {{ totals(c).applied }} written<template v-if="totals(c).proposed">
                · {{ totals(c).proposed }} proposed</template
              >
            </span>
            <span v-else class="badge-idle">nothing applied</span>
          </span>
          <span class="meta">{{ c.user }} · {{ formatTime(c.updatedAt) }}</span>
        </div>

        <div v-if="expandedId === c.id" class="thread" @click.stop>
          <div v-for="m in c.messages" :key="m.id" class="turn" :class="m.role">
            <div class="bubble">{{ m.text }}</div>

            <div v-if="m.proposals?.length" class="plan">
              <div class="plan-head">
                <strong>{{ m.planSummary || 'Proposed changes' }}</strong>
                <span
                  class="plan-state"
                  :class="{ done: m.appliedSummaries?.length, skipped: !m.appliedSummaries?.length }"
                >
                  <template v-if="m.appliedSummaries?.length">
                    applied by {{ m.appliedBy || 'unknown' }}
                    <template v-if="m.appliedAt"> · {{ formatTime(m.appliedAt) }}</template>
                  </template>
                  <template v-else>never applied</template>
                </span>
              </div>

              <ul class="ops">
                <li
                  v-for="(line, i) in m.proposals"
                  :key="i"
                  :class="{ done: m.appliedSummaries?.includes(line) }"
                >
                  {{ line }}
                </li>
              </ul>

              <p v-if="m.appliedSummaries?.length" class="applied-note">
                {{ m.applied ?? 0 }} change{{ (m.applied ?? 0) === 1 ? '' : 's' }} written<template
                  v-if="m.proposed"
                >, {{ m.proposed }} move{{ m.proposed === 1 ? '' : 's' }} proposed for confirmation</template
                >.
              </p>
            </div>
          </div>

          <div class="thread-actions">
            <span class="meta">Started {{ formatTime(c.startedAt) }}</span>
            <button class="btn small" @click="remove(c)">Forget this conversation</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.conv-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.conv-title {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.badge-applied,
.badge-idle {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}

.badge-applied {
  background: var(--success-bg);
  color: var(--success);
}

.badge-idle {
  background: var(--bg-hover);
  color: var(--text-muted);
}

.meta {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.thread {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.turn.user {
  align-items: flex-end;
}

.bubble {
  max-width: 85%;
  padding: 9px 12px;
  border-radius: var(--radius);
  background: var(--bg);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.turn.user .bubble {
  background: var(--accent-bg);
  border-color: transparent;
}

.plan {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg);
}

.plan-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.plan-state {
  font-size: 12px;
  white-space: nowrap;
}

.plan-state.done {
  color: var(--success);
}

.plan-state.skipped {
  color: var(--text-muted);
}

.ops {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  color: var(--text-muted);
}

.ops li {
  padding: 2px 0;
}

/* An operation that was actually carried out, as against one that was
   proposed and then unticked. */
.ops li.done {
  color: var(--text);
}

.applied-note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--success);
}

.thread-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}

@media (max-width: 640px) {
  .bubble {
    max-width: 100%;
  }
}
</style>
