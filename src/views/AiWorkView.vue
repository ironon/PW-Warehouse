<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  warehouse,
  applyAgentPlan,
  denyAllPendingMoves,
  pendingMoveContainers,
  setPlacementRules,
  DEFAULT_PLACEMENT_RULES,
} from '../store/warehouse'
import {
  messages,
  thinking,
  chatError,
  failedDraft,
  sendMessage,
  cancel,
  resetChat,
  type ChatMessage,
} from '../store/aiChat'
import { isAgentConfigured } from '../lib/aiAgent'
import PendingMoveBadge from '../components/PendingMoveBadge.vue'
import Icon from '../components/Icon.vue'

const configured = isAgentConfigured()

const draft = ref('')
const applyError = ref('')
const applyingIndex = ref<number | null>(null)
const scroller = ref<HTMLElement | null>(null)

const showRules = ref(false)
const rulesDraft = ref('')
const rulesSaving = ref(false)

const pending = computed(() => pendingMoveContainers())

// A failed send hands the text back rather than losing it.
watch(failedDraft, (value) => {
  if (value) draft.value = value
})

watch(
  () => messages.value.length,
  async () => {
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
  }
)

async function send() {
  const text = draft.value
  if (!text.trim() || thinking.value) return
  draft.value = ''
  await sendMessage(text)
}

/** Enter sends, Shift+Enter makes a new line — these prompts are usually one
 *  sentence, and reaching for a button every time gets old fast. */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

function selectedRows(message: ChatMessage) {
  return (message.rows ?? []).filter((r) => r.selected && !r.error)
}

async function applyPlan(message: ChatMessage, index: number) {
  const chosen = selectedRows(message)
  if (chosen.length === 0) return
  applyError.value = ''
  applyingIndex.value = index
  try {
    message.applied = await applyAgentPlan(chosen.map((r) => r.op))
  } catch (err) {
    applyError.value = err instanceof Error ? err.message : String(err)
  } finally {
    applyingIndex.value = null
  }
}

function setAll(message: ChatMessage, value: boolean) {
  for (const row of message.rows ?? []) {
    if (!row.error) row.selected = value
  }
}

function openRules() {
  rulesDraft.value = warehouse.placementRules || DEFAULT_PLACEMENT_RULES
  showRules.value = true
}

async function saveRules() {
  rulesSaving.value = true
  try {
    await setPlacementRules(rulesDraft.value)
    showRules.value = false
  } catch (err) {
    applyError.value = err instanceof Error ? err.message : String(err)
  } finally {
    rulesSaving.value = false
  }
}

async function rejectAllPending() {
  applyError.value = ''
  try {
    await denyAllPendingMoves()
  } catch (err) {
    applyError.value = err instanceof Error ? err.message : String(err)
  }
}

const examples = [
  'Take the screws in yellow or blue containers under BR1 and organise them so metric is on the left and imperial on the right. Metric goes in blue containers, imperial in anything else.',
  'Add metric screws M1 through M9 to the hardware boxes on SL2.',
  'Look for containers that are similar enough that they should be merged.',
  'Which shelves break the placement rules?',
]

function useExample(text: string) {
  draft.value = text
}
</script>

<template>
  <div class="ai-view">
    <div v-if="!configured" class="form-card setup-note">
      <h3>Gemini isn't set up yet</h3>
      <p>
        Create an API key at
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>,
        put it in <code>.env.local</code> as <code>VITE_GEMINI_API_KEY</code>, then rebuild.
      </p>
    </div>

    <!-- Outstanding physical work ---------------------------------------- -->
    <section v-if="pending.length" class="form-card pending-card">
      <div class="pending-head">
        <h3 class="section-heading">
          {{ pending.length }} proposal{{ pending.length === 1 ? '' : 's' }} waiting on someone
        </h3>
        <button class="btn small" :disabled="warehouse.saving" @click="rejectAllPending">Reject all</button>
      </div>
      <p class="hint">
        These boxes are still at the address shown struck through. Tick one off once it has actually been carried —
        a shelf scan that finds the box in its new spot will tick it off too.
      </p>
      <div class="pending-list">
        <div v-for="c in pending" :key="c.id" class="pending-item">
          <span class="pending-name">{{ c.label || c.id }}</span>
          <PendingMoveBadge :container-id="c.id" />
        </div>
      </div>
    </section>

    <!-- Conversation ------------------------------------------------------ -->
    <section class="form-card chat-card">
      <div class="chat-head">
        <h3 class="section-heading">Ask the warehouse agent</h3>
        <div class="head-actions">
          <button class="btn small" @click="openRules">Placement rules</button>
          <button v-if="messages.length" class="btn small" @click="resetChat">New conversation</button>
        </div>
      </div>

      <div v-if="showRules" class="rules-editor">
        <label>Standing rules the agent must follow when placing boxes</label>
        <textarea v-model="rulesDraft" rows="10"></textarea>
        <p class="hint">
          Shared by everyone and used on every request. Kept out of the code so it can change when the way the
          warehouse is run changes.
        </p>
        <div class="form-actions">
          <button class="btn" @click="showRules = false">Cancel</button>
          <button class="btn" @click="rulesDraft = DEFAULT_PLACEMENT_RULES">Reset to default</button>
          <button class="btn btn-primary" :disabled="rulesSaving" @click="saveRules">
            {{ rulesSaving ? 'Saving…' : 'Save rules' }}
          </button>
        </div>
      </div>

      <div ref="scroller" class="messages">
        <div v-if="messages.length === 0" class="intro">
          <p class="hint">
            Describe what you want changed. The agent knows every container, its address, its type and its contents,
            and answers with a plan you tick through before anything is written.
          </p>
          <p class="hint">
            Moves and merges are never done for you — they become proposals that stay visible in Search and Add until
            somebody confirms the box was actually carried.
          </p>
          <div class="examples">
            <button v-for="ex in examples" :key="ex" class="example" @click="useExample(ex)">{{ ex }}</button>
          </div>
        </div>

        <div v-for="(m, i) in messages" :key="i" class="message" :class="m.role">
          <div class="bubble">{{ m.text }}</div>

          <!-- Plan review -->
          <div v-if="m.rows && m.rows.length" class="plan">
            <div class="plan-head">
              <strong>{{ m.planSummary || 'Proposed changes' }}</strong>
              <span class="muted">{{ m.rows.length }} operation{{ m.rows.length === 1 ? '' : 's' }}</span>
            </div>

            <div v-if="!m.applied" class="select-actions">
              <button class="btn small" @click="setAll(m, true)">Select all</button>
              <button class="btn small" @click="setAll(m, false)">Select none</button>
            </div>

            <label v-for="row in m.rows" :key="row.index" class="op-row" :class="{ invalid: !!row.error }">
              <input v-model="row.selected" type="checkbox" :disabled="!!row.error || !!m.applied" />
              <span class="op-body">
                <span class="op-summary">{{ row.summary }}</span>
                <span v-if="row.op.reason && !row.error" class="op-reason">{{ row.op.reason }}</span>
              </span>
              <span v-if="row.needsConfirmation && !row.error" class="op-tag">needs confirming</span>
              <span v-else-if="row.error" class="op-tag bad">can't apply</span>
            </label>

            <p v-if="m.applied" class="applied-note">
              Applied. {{ m.applied.applied }} change{{ m.applied.applied === 1 ? '' : 's' }} written<template
                v-if="m.applied.proposed"
              >, {{ m.applied.proposed }} proposal{{ m.applied.proposed === 1 ? '' : 's' }} now waiting to be
                confirmed</template
              >.
            </p>
            <div v-else class="form-actions">
              <button
                class="btn btn-primary"
                :disabled="selectedRows(m).length === 0 || applyingIndex === i || warehouse.saving"
                @click="applyPlan(m, i)"
              >
                {{ applyingIndex === i ? 'Applying…' : `Apply ${selectedRows(m).length} operation${selectedRows(m).length === 1 ? '' : 's'}` }}
              </button>
            </div>
          </div>
        </div>

        <div v-if="thinking" class="message model">
          <div class="bubble thinking">
            <Icon name="sparkles" :size="14" />
            <span>Thinking…</span>
            <button class="btn small" @click="cancel">Stop</button>
          </div>
        </div>
      </div>

      <p v-if="chatError" class="error-banner">{{ chatError }}</p>
      <p v-if="applyError" class="error-banner">{{ applyError }}</p>

      <div class="composer">
        <textarea
          v-model="draft"
          rows="2"
          :disabled="!configured"
          placeholder="e.g. move the drill bits somewhere easier to reach"
          @keydown="onKeydown"
        ></textarea>
        <button class="btn btn-primary send" :disabled="!draft.trim() || thinking || !configured" @click="send">
          <Icon name="send" :size="16" />
          <span>Send</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ai-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pending-head,
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.pending-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.pending-item {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

.pending-name {
  font-weight: 600;
}

.rules-editor {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}

.rules-editor label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.rules-editor textarea {
  width: 100%;
  font-family: var(--mono);
  font-size: 12.5px;
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin: 12px 0;
  max-height: 58vh;
  overflow-y: auto;
  padding-right: 4px;
}

.intro {
  color: var(--text-muted);
}

.examples {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.example {
  text-align: left;
  font: inherit;
  color: var(--text);
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  cursor: pointer;
}

.example:hover {
  background: var(--bg-hover);
}

.message {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.message.user {
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

.message.user .bubble {
  background: var(--accent-bg);
  border-color: transparent;
}

.bubble.thinking {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
}

.plan {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--bg-elevated);
}

.plan-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.plan-head .muted {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.select-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.op-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  cursor: pointer;
}

.op-row.invalid {
  color: var(--text-muted);
  cursor: default;
}

.op-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.op-summary {
  overflow-wrap: anywhere;
}

.op-reason {
  font-size: 12px;
  color: var(--text-muted);
}

.op-tag {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--accent);
  white-space: nowrap;
}

.op-tag.bad {
  background: var(--danger-bg);
  color: var(--danger);
}

.applied-note {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--success);
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.composer textarea {
  flex: 1;
  resize: vertical;
}

.send {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .messages {
    max-height: none;
  }
  .bubble {
    max-width: 100%;
  }
}
</style>
