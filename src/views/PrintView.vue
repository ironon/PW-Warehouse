<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { printLabel, previewUrl, type LabelStyle } from '../lib/labelPrinter'
import { currentStock, stocksLoaded } from '../store/labelStock'
import LabelStockPicker from '../components/LabelStockPicker.vue'

const text = ref('')
const style = ref<LabelStyle>({ bold: true, italic: false, underline: false })
const copies = ref(2)

const printing = ref(false)
const error = ref('')
const status = ref('')
const previewFailed = ref(false)

const trimmed = computed(() => text.value.trim())
const canPrint = computed(() => Boolean(trimmed.value) && !printing.value && stocksLoaded.value)

const stock = computed(() => currentStock())
const aspect = computed(() => {
  const s = stock.value
  return s ? `${s.design_width_mm} / ${s.design_height_mm}` : '102 / 64'
})

// Debounced so each keystroke doesn't trigger a render on the backend.
const debouncedText = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  trimmed,
  (value) => {
    clearTimeout(timer)
    timer = setTimeout(() => (debouncedText.value = value), 250)
  },
  { immediate: true }
)

const previewSrc = computed(() => {
  if (!debouncedText.value) return ''
  previewFailed.value = false
  return previewUrl(debouncedText.value, style.value)
})

async function doPrint() {
  if (!trimmed.value) return
  printing.value = true
  error.value = ''
  status.value = ''
  try {
    const n = await printLabel(trimmed.value, copies.value, style.value)
    status.value = `Sent ${n} label${n === 1 ? '' : 's'} to the printer.`
    setTimeout(() => (status.value = ''), 5000)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    printing.value = false
  }
}

function clearAll() {
  text.value = ''
  status.value = ''
  error.value = ''
}
</script>

<template>
  <div class="print-view">
    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-if="status" class="ok-banner">{{ status }}</p>

    <div class="form-card">
      <h3 class="section-heading">Print a label</h3>
      <p class="hint">
        Type anything and print it in Segoe UI. The text is sized as large as fits the loaded label.
      </p>

      <div class="field">
        <label for="print-text">Text</label>
        <textarea
          id="print-text"
          v-model="text"
          rows="3"
          placeholder="e.g. Fragile — Do Not Stack"
          autofocus
        />
      </div>

      <div class="controls">
        <div class="style-group" role="group" aria-label="Text style">
          <button
            type="button"
            class="style-btn bold"
            :class="{ on: style.bold }"
            :aria-pressed="style.bold"
            title="Bold"
            @click="style.bold = !style.bold"
          >
            B
          </button>
          <button
            type="button"
            class="style-btn italic"
            :class="{ on: style.italic }"
            :aria-pressed="style.italic"
            title="Italic"
            @click="style.italic = !style.italic"
          >
            I
          </button>
          <button
            type="button"
            class="style-btn underline"
            :class="{ on: style.underline }"
            :aria-pressed="style.underline"
            title="Underline"
            @click="style.underline = !style.underline"
          >
            U
          </button>
        </div>

        <div class="qty">
          <label for="copies">Quantity</label>
          <input id="copies" v-model.number="copies" type="number" min="1" max="50" />
        </div>
      </div>
    </div>

    <div class="form-card">
      <h3 class="section-heading">Preview</h3>
      <div class="preview-wrap">
        <img
          v-if="previewSrc && !previewFailed"
          :src="previewSrc"
          class="preview"
          :style="{ aspectRatio: aspect }"
          alt="Label preview"
          @error="previewFailed = true"
        />
        <div v-else class="preview empty" :style="{ aspectRatio: aspect }">
          {{ previewFailed ? 'Preview unavailable' : 'Type something to see it here' }}
        </div>
      </div>

      <LabelStockPicker class="stock-block" compact />

      <div class="form-actions">
        <button class="btn" :disabled="!trimmed || printing" @click="clearAll">Clear</button>
        <button class="btn btn-primary" :disabled="!canPrint" @click="doPrint">
          {{ printing ? 'Printing…' : `Print ${copies} label${copies === 1 ? '' : 's'}` }}
        </button>
      </div>

      <p v-if="!stocksLoaded" class="offline">
        The print service isn't running. Start it with
        <code>backend\start-printer-server.bat</code>.
      </p>
    </div>
  </div>
</template>

<style scoped>
.print-view {
  max-width: 720px;
}

.section-heading {
  font-size: 15px;
  margin-bottom: 6px;
}

.hint {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 14px;
}

.field textarea {
  resize: vertical;
  min-height: 72px;
}

.controls {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.style-group {
  display: flex;
  gap: 6px;
}

.style-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 16px;
  line-height: 1;
  color: var(--text);
}
.style-btn:hover {
  background: var(--bg-hover);
}
.style-btn.on {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
}
.style-btn.bold {
  font-weight: 700;
}
.style-btn.italic {
  font-style: italic;
  font-family: Georgia, serif;
}
.style-btn.underline {
  text-decoration: underline;
}

.qty {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.qty label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 600;
}
.qty input {
  width: 88px;
  padding: 9px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
}

.preview-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 14px;
}

.preview {
  width: 100%;
  max-width: 420px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.preview.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #999;
  font-size: 13px;
  text-align: center;
  padding: 12px;
}

.stock-block {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}

.offline {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}
.offline code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
