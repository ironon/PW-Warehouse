<script setup lang="ts">
// The "somebody still has to carry this box" strip. It appears wherever a
// container is shown, because the whole point is that a person looking a box
// up finds out it is supposed to be somewhere else - and that the address
// listed is still where it physically is.
import { computed, ref } from 'vue'
import {
  warehouse,
  acceptPendingMove,
  denyPendingMove,
  pendingPartner,
} from '../store/warehouse'
import Icon from './Icon.vue'

// Takes an id rather than the container itself: every caller already has the
// id, and looking it up here keeps this reading from the live store instead of
// a snapshot that a concurrent edit could have made stale.
const props = defineProps<{ containerId: string }>()

const busy = ref(false)
const error = ref('')

const container = computed(() => warehouse.containers.find((c) => c.id === props.containerId))

const move = computed(() => container.value?.pendingMove)

const partner = computed(() => pendingPartner(props.containerId))

const mergeTarget = computed(() => {
  const id = move.value?.mergeInto
  if (!id) return undefined
  return warehouse.containers.find((c) => c.id === id)
})

async function settle(accept: boolean) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    if (accept) await acceptPendingMove(props.containerId)
    else await denyPendingMove(props.containerId)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="move" class="pending" :class="{ merge: move.kind === 'merge' }">
    <div class="body">
      <span class="tag">{{ move.kind === 'merge' ? 'Merge proposed' : 'Move proposed' }}</span>

      <span class="route">
        <span class="from">{{ move.from }}</span>
        <Icon name="arrow-right" :size="14" class="arrow" />
        <span class="to">
          <template v-if="move.kind === 'merge'">
            {{ mergeTarget ? `“${mergeTarget.label || mergeTarget.id}” at ${move.to}` : move.to }}
          </template>
          <template v-else>{{ move.to }}</template>
        </span>
      </span>

      <span v-if="partner" class="swap-note">swap with “{{ partner.label || partner.id }}”</span>
    </div>

    <p v-if="move.reason" class="reason">{{ move.reason }}</p>
    <p v-if="error" class="reason err">{{ error }}</p>

    <div class="actions">
      <button
        class="act accept"
        :disabled="busy || warehouse.saving"
        :title="
          move.kind === 'merge'
            ? 'The contents have been tipped into the other box — record it'
            : 'The box has actually been moved — record it'
        "
        @click.stop.prevent="settle(true)"
      >
        <Icon name="check" :size="15" />
      </button>
      <button
        class="act deny"
        :disabled="busy || warehouse.saving"
        title="Reject this proposal — leave the box where it is"
        @click.stop.prevent="settle(false)"
      >
        <Icon name="close" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.pending {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px dashed var(--accent);
  border-radius: var(--radius);
  background: var(--accent-bg);
}

.pending.merge {
  border-color: var(--success);
  background: var(--success-bg);
}

.body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  flex: 1 1 200px;
  min-width: 0;
}

.tag {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--accent);
  white-space: nowrap;
}
.pending.merge .tag {
  color: var(--success);
}

.route {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--mono);
  font-size: 12.5px;
  min-width: 0;
}

.from {
  /* The box is still here; struck through so nobody reads it as the answer. */
  text-decoration: line-through;
  color: var(--text-muted);
}

.to {
  font-weight: 600;
}

.arrow {
  flex: 0 0 auto;
  color: var(--text-muted);
}

.swap-note {
  font-size: 12px;
  color: var(--text-muted);
}

.reason {
  flex: 1 1 100%;
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.reason.err {
  color: var(--danger);
}

.actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}

.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  cursor: pointer;
}

.act:disabled {
  opacity: 0.5;
  cursor: default;
}

.act.accept {
  color: var(--success);
}
.act.accept:not(:disabled):hover {
  background: var(--success);
  border-color: var(--success);
  color: #fff;
}

.act.deny {
  color: var(--danger);
}
.act.deny:not(:disabled):hover {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
</style>
