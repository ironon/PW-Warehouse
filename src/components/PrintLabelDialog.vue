<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { printLabel, previewUrl, DEFAULT_COPIES } from '../lib/labelPrinter'
import LabelStockPicker from './LabelStockPicker.vue'
import { currentStockId, currentStock } from '../store/labelStock'

const props = defineProps<{
  /** Container name to print. Empty string closes the dialog. */
  text: string
  /** Why the prompt appeared, used for the wording only. */
  reason: 'created' | 'renamed'
}>()

const emit = defineEmits<{ close: [] }>()

const printing = ref(false)
const error = ref('')
const done = ref(false)
const previewFailed = ref(false)

const heading = computed(() =>
  props.reason === 'created' ? 'Container created — print labels?' : 'Name changed — print new labels?'
)

// The preview must be re-fetched and re-proportioned when the stock changes,
// since a different roll means a different label shape.
const stock = computed(() => currentStock())
const aspect = computed(() => {
  const s = stock.value
  return s ? `${s.design_width_mm} / ${s.design_height_mm}` : '102 / 64'
})
const previewSrc = computed(() => `${previewUrl(props.text)}&stock=${currentStockId.value}`)

// Reset state whenever a new prompt opens.
watch(
  () => props.text,
  () => {
    printing.value = false
    error.value = ''
    done.value = false
    previewFailed.value = false
  }
)

async function confirmPrint() {
  printing.value = true
  error.value = ''
  try {
    await printLabel(props.text, DEFAULT_COPIES)
    done.value = true
    setTimeout(() => emit('close'), 900)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    printing.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true">
      <h2 class="heading">{{ heading }}</h2>
      <p class="sub">
        {{ DEFAULT_COPIES }} identical labels will print — one for each side of the box.
      </p>

      <div class="preview-wrap">
        <img
          v-if="!previewFailed"
          :key="previewSrc"
          :src="previewSrc"
          class="preview"
          :style="{ aspectRatio: aspect }"
          alt="Label preview"
          @error="previewFailed = true"
        />
        <div v-else class="preview fallback" :style="{ aspectRatio: aspect }">{{ text }}</div>
      </div>

      <LabelStockPicker class="stock-in-dialog" compact />

      <p v-if="error" class="error">{{ error }}</p>
      <p v-else-if="done" class="ok">Sent to the printer.</p>

      <div class="actions">
        <button class="btn" :disabled="printing" @click="emit('close')">
          {{ done ? 'Close' : 'Skip' }}
        </button>
        <button v-if="!done" class="btn btn-primary" :disabled="printing" @click="confirmPrint">
          {{ printing ? 'Printing…' : error ? 'Try again' : `Print ${DEFAULT_COPIES} labels` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.45);
}

.dialog {
  width: 100%;
  max-width: 460px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
  padding: 20px;
}

.heading {
  font-size: 16px;
  margin-bottom: 6px;
}

.sub {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0 0 14px;
}

.preview-wrap {
  display: flex;
  justify-content: center;
  margin-bottom: 14px;
}

/* Aspect ratio is bound to the selected stock so the preview matches what
   comes out of the printer. */
.preview {
  width: 100%;
  max-width: 340px;
  object-fit: contain;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.preview.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 12px;
  font-weight: 700;
  color: #111;
  font-size: 18px;
}

.error {
  background: var(--danger-bg);
  color: var(--danger);
  padding: 8px 10px;
  border-radius: var(--radius);
  font-size: 12px;
  margin: 0 0 12px;
  line-height: 1.45;
}

.ok {
  color: var(--success);
  font-size: 13px;
  margin: 0 0 12px;
}

.stock-in-dialog {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}

.actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
