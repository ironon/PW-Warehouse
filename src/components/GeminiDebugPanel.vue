<script setup lang="ts">
// Shows exactly what Gemini sent back, unparsed. The whole point is that
// "it returned invalid JSON" stops being something you have to take on faith.
import { computed, ref } from 'vue'
import { exchanges, clearExchanges, exchangeAsText, type GeminiExchange } from '../lib/geminiDebug'

const props = defineProps<{ source?: 'scan' | 'agent' }>()
const emit = defineEmits<{ close: [] }>()

const copied = ref('')

const visible = computed<GeminiExchange[]>(() =>
  props.source ? exchanges.value.filter((e) => e.source === props.source) : [...exchanges.value]
)

const expandedId = ref<number | null>(null)

function toggle(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

function verdict(e: GeminiExchange): { text: string; tone: string } {
  if (e.httpStatus !== 200) return { text: `HTTP ${e.httpStatus}`, tone: 'bad' }
  if (e.finishReason === 'MAX_TOKENS') return { text: 'cut off at the token limit', tone: 'bad' }
  if (e.parseError) return { text: 'unparseable', tone: 'bad' }
  if (e.repaired) return { text: 'truncated, partly recovered', tone: 'warn' }
  return { text: 'ok', tone: 'good' }
}

async function copy(e: GeminiExchange) {
  try {
    await navigator.clipboard.writeText(exchangeAsText(e))
    copied.value = `Copied call #${e.id}.`
  } catch {
    // Clipboard is blocked outside a secure context, and this app is served
    // over plain http. The text is on screen and selectable regardless.
    copied.value = 'Clipboard is blocked here — select the text below and copy it manually.'
  }
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}
</script>

<template>
  <div class="debug">
    <div class="debug-head">
      <h3 class="section-heading">Last Gemini calls</h3>
      <div class="head-actions">
        <button v-if="visible.length" class="btn small" @click="clearExchanges">Clear</button>
        <button class="btn small" @click="emit('close')">Close</button>
      </div>
    </div>

    <p v-if="copied" class="ok-banner">{{ copied }}</p>

    <p v-if="visible.length === 0" class="hint">
      Nothing recorded yet this session. Run a request and it will show up here — the raw response, the finish
      reason, and the token counts.
    </p>

    <div v-for="e in visible" :key="e.id" class="call">
      <button class="call-head" @click="toggle(e.id)">
        <span class="verdict" :class="verdict(e).tone">{{ verdict(e).text }}</span>
        <span class="call-meta">
          {{ formatTime(e.at) }} · {{ e.model }} · {{ (e.durationMs / 1000).toFixed(1) }}s
        </span>
        <span class="tokens">
          in {{ e.promptTokens ?? '?' }} · out {{ e.outputTokens ?? '?' }}
          <template v-if="e.thoughtsTokens"> · thought {{ e.thoughtsTokens }}</template>
        </span>
      </button>

      <div v-if="expandedId === e.id" class="call-body">
        <dl class="facts">
          <div><dt>finishReason</dt><dd>{{ e.finishReason ?? '(none)' }}</dd></div>
          <div><dt>HTTP</dt><dd>{{ e.httpStatus }}</dd></div>
          <div v-if="e.parseError"><dt>parse error</dt><dd class="bad-text">{{ e.parseError }}</dd></div>
          <div v-if="e.repaired"><dt>repaired</dt><dd>yes — the reply was incomplete</dd></div>
          <div v-if="e.totalTokens"><dt>total tokens</dt><dd>{{ e.totalTokens }}</dd></div>
        </dl>

        <p v-if="e.finishReason === 'MAX_TOKENS'" class="diagnosis">
          <strong>This is the usual cause of bad JSON.</strong> The model ran out of output budget partway through
          writing its answer, so what arrived is a JSON document with no ending. Thinking tokens come out of the
          same budget, which is why the call was also slow. Raise the max-tokens setting, or set
          <code>VITE_GEMINI_THINKING_LEVEL=low</code>.
        </p>

        <div class="raw-head">
          <span>Raw response ({{ e.rawText.length }} characters)</span>
          <button class="btn small" @click="copy(e)">Copy all details</button>
        </div>
        <pre class="raw">{{ e.rawText || '(empty)' }}</pre>

        <template v-if="e.errorBody">
          <div class="raw-head"><span>Error body</span></div>
          <pre class="raw">{{ e.errorBody }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 14px;
  margin-bottom: 16px;
}

.debug-head {
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

.call {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 8px;
}

.call-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 4px 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}

.verdict {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.verdict.good {
  background: var(--success-bg);
  color: var(--success);
}
.verdict.warn {
  background: var(--accent-bg);
  color: var(--accent);
}
.verdict.bad {
  background: var(--danger-bg);
  color: var(--danger);
}

.call-meta,
.tokens {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.tokens {
  margin-left: auto;
}

.call-body {
  padding: 8px 0 4px;
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
  margin: 0 0 10px;
}

.facts > div {
  display: flex;
  gap: 6px;
  font-size: 12.5px;
}

.facts dt {
  color: var(--text-muted);
}

.facts dd {
  margin: 0;
  font-family: var(--mono);
}

.bad-text {
  color: var(--danger);
}

.diagnosis {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}

.raw-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.raw {
  margin: 0 0 10px;
  padding: 10px;
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.45;
  /* Wrap rather than scroll sideways: a truncated response is usually one very
     long line, and the interesting part is the end of it. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
