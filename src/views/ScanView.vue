<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  warehouse,
  knownShelves,
  levelsForShelf,
  duplicateLabels,
  computeScanDiff,
  applyScanChanges,
  type ScanChange,
} from '../store/warehouse'
import { scanShelf, fileToScaledJpegBase64, isGeminiConfigured, GeminiNotConfiguredError } from '../lib/gemini'

type Phase = 'setup' | 'scanning' | 'review' | 'done'

const phase = ref<Phase>('setup')
const shelfId = ref('')
const customShelf = ref('')
const file = ref<File | null>(null)
const previewUrl = ref('')
const error = ref('')
const geminiNotes = ref('')
const ambiguous = ref<string[]>([])
const unchanged = ref(0)
const appliedCount = ref(0)
const rows = ref<{ change: ScanChange; selected: boolean }[]>([])

const shelves = computed(() => knownShelves())
const dupes = computed(() => duplicateLabels())
const effectiveShelf = computed(() => (shelfId.value === '__custom__' ? customShelf.value.trim() : shelfId.value))
const configured = isGeminiConfigured()

const containersOnShelf = computed(() => {
  const s = effectiveShelf.value
  if (!s) return 0
  return warehouse.containers.filter((c) => c.location === s || c.location.startsWith(`${s}-`)).length
})

const selectedCount = computed(() => rows.value.filter((r) => r.selected).length)

function onFileChange(e: Event) {
  const picked = (e.target as HTMLInputElement).files?.[0] ?? null
  file.value = picked
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = picked ? URL.createObjectURL(picked) : ''
}

async function runScan() {
  if (!file.value || !effectiveShelf.value) return
  error.value = ''
  phase.value = 'scanning'
  try {
    const imageBase64 = await fileToScaledJpegBase64(file.value)
    const result = await scanShelf({
      imageBase64,
      shelfId: effectiveShelf.value,
      knownLevels: levelsForShelf(effectiveShelf.value),
      knownLabels: warehouse.containers.map((c) => c.label).filter(Boolean),
      containerTypeNames: warehouse.containerTypes.map((t) => t.name).filter(Boolean),
    })
    geminiNotes.value = result.notes
    const diff = computeScanDiff(effectiveShelf.value, result.boxes)
    rows.value = diff.changes.map((change) => ({ change, selected: true }))
    ambiguous.value = diff.ambiguous
    unchanged.value = diff.unchanged
    phase.value = 'review'
  } catch (err) {
    error.value =
      err instanceof GeminiNotConfiguredError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err)
    phase.value = 'setup'
  }
}

async function apply() {
  const chosen = rows.value.filter((r) => r.selected).map((r) => r.change)
  if (chosen.length === 0) return
  error.value = ''
  try {
    appliedCount.value = await applyScanChanges(effectiveShelf.value, chosen)
    phase.value = 'done'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function reset() {
  phase.value = 'setup'
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  file.value = null
  rows.value = []
  ambiguous.value = []
  geminiNotes.value = ''
  unchanged.value = 0
  error.value = ''
}

function setAll(value: boolean) {
  rows.value.forEach((r) => (r.selected = value))
}

function kindLabel(kind: ScanChange['kind']): string {
  if (kind === 'move') return 'Move'
  if (kind === 'create') return 'New'
  return 'To trash'
}
</script>

<template>
  <div class="scan-view">
    <p v-if="error" class="error-banner">{{ error }}</p>

    <div v-if="!configured" class="form-card setup-note">
      <h3>Gemini isn't set up yet</h3>
      <p>
        Create an API key at
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>,
        put it in <code>.env.local</code> as <code>VITE_GEMINI_API_KEY</code>, then restart the dev server.
      </p>
    </div>

    <!-- Setup ------------------------------------------------------------ -->
    <template v-if="phase === 'setup' || phase === 'scanning'">
      <div class="form-card">
        <h3 class="section-heading">Scan a shelf</h3>
        <p class="hint">
          Pick the shelf you're about to photograph, take one photo of the whole unit, and Gemini will read the
          labels and work out where each box sits. Boxes from neighbouring shelves that creep into the edge of the
          frame are ignored.
        </p>

        <div class="form-grid">
          <div class="field">
            <label>Shelf</label>
            <select v-model="shelfId">
              <option value="" disabled>Select a shelf…</option>
              <option v-for="s in shelves" :key="s" :value="s">{{ s }}</option>
              <option value="__custom__">Other (type it in)…</option>
            </select>
          </div>
          <div v-if="shelfId === '__custom__'" class="field">
            <label>Shelf ID</label>
            <input v-model="customShelf" type="text" placeholder="e.g. SR4" />
          </div>
        </div>

        <p v-if="effectiveShelf" class="hint">
          The database currently has <strong>{{ containersOnShelf }}</strong> container{{ containersOnShelf === 1 ? '' : 's' }}
          on {{ effectiveShelf }}. Any of them not visible in the photo will be proposed for Deleted Containers.
        </p>

        <div class="field photo-field">
          <label>Photo</label>
          <label class="upload-btn">
            {{ file ? 'Choose a different photo' : 'Take / choose photo' }}
            <input type="file" accept="image/*" capture="environment" hidden @change="onFileChange" />
          </label>
          <img v-if="previewUrl" :src="previewUrl" class="preview" alt="Shelf photo preview" />
        </div>

        <div class="form-actions">
          <button
            class="btn btn-primary"
            :disabled="!file || !effectiveShelf || phase === 'scanning' || !configured"
            @click="runScan"
          >
            {{ phase === 'scanning' ? 'Reading the photo…' : 'Scan shelf' }}
          </button>
        </div>
      </div>

      <div v-if="dupes.length" class="form-card warn-card">
        <strong>Heads up:</strong> these labels are used by more than one container, so a scan can't tell them apart
        and will skip them: {{ dupes.join(', ') }}.
      </div>
    </template>

    <!-- Review ----------------------------------------------------------- -->
    <template v-else-if="phase === 'review'">
      <div class="form-card">
        <h3 class="section-heading">Proposed changes for {{ effectiveShelf }}</h3>
        <p class="hint">
          {{ rows.length }} change{{ rows.length === 1 ? '' : 's' }} proposed, {{ unchanged }} box{{ unchanged === 1 ? '' : 'es' }}
          already in the right place. Untick anything that looks wrong before applying.
        </p>
        <p v-if="geminiNotes" class="hint notes-from-model">Gemini noted: {{ geminiNotes }}</p>
        <p v-if="ambiguous.length" class="hint warn-inline">
          Skipped (duplicate labels, can't tell which container): {{ ambiguous.join(', ') }}
        </p>

        <p v-if="rows.length === 0" class="hint">
          Nothing to change — the shelf matches the database exactly.
        </p>

        <template v-else>
          <div class="select-actions">
            <button class="btn small" @click="setAll(true)">Select all</button>
            <button class="btn small" @click="setAll(false)">Select none</button>
          </div>

          <div class="change-list">
            <label v-for="(row, i) in rows" :key="i" class="change-row" :class="row.change.kind">
              <input v-model="row.selected" type="checkbox" />
              <span class="kind" :class="row.change.kind">{{ kindLabel(row.change.kind) }}</span>
              <span class="change-label">{{ row.change.label }}</span>
              <span class="change-detail">
                <template v-if="row.change.kind === 'move'">
                  {{ row.change.fromLocation }} → <strong>{{ row.change.toLocation }}</strong>
                </template>
                <template v-else-if="row.change.kind === 'create'">
                  at <strong>{{ row.change.toLocation }}</strong>
                  <template v-if="row.change.containerTypeName"> · {{ row.change.containerTypeName }}</template>
                </template>
                <template v-else> not seen at {{ row.change.fromLocation }} </template>
              </span>
              <span v-if="row.change.confidence && row.change.confidence !== 'high'" class="confidence">
                {{ row.change.confidence }} confidence
              </span>
            </label>
          </div>
        </template>

        <div class="form-actions">
          <button class="btn" @click="reset">Cancel</button>
          <button class="btn btn-primary" :disabled="selectedCount === 0 || warehouse.saving" @click="apply">
            Apply {{ selectedCount }} change{{ selectedCount === 1 ? '' : 's' }}
          </button>
        </div>
      </div>
    </template>

    <!-- Done ------------------------------------------------------------- -->
    <template v-else>
      <div class="form-card">
        <h3 class="section-heading">Done</h3>
        <p class="hint">
          Applied {{ appliedCount }} change{{ appliedCount === 1 ? '' : 's' }} to {{ effectiveShelf }}. Every change is
          recorded in the Logs tab, and anything trashed can be restored from Deleted Containers.
        </p>
        <div class="form-actions">
          <button class="btn btn-primary" @click="reset">Scan another shelf</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.scan-view {
  max-width: 900px;
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

.setup-note h3 {
  font-size: 15px;
  margin-bottom: 6px;
}
.setup-note p {
  color: var(--text-muted);
  font-size: 13px;
  margin: 0;
}
.setup-note code {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--bg-hover);
  padding: 1px 5px;
  border-radius: 4px;
}

.photo-field {
  margin: 14px 0;
}

.upload-btn {
  align-self: flex-start;
  padding: 8px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
  cursor: pointer;
}
.upload-btn:hover {
  background: var(--bg-hover);
}

.preview {
  margin-top: 10px;
  max-width: 320px;
  width: 100%;
  border-radius: var(--radius);
  border: 1px solid var(--border);
}

.warn-card {
  background: var(--danger-bg);
  border-color: var(--danger);
  font-size: 13px;
}
.warn-inline {
  color: var(--danger);
}
.notes-from-model {
  font-style: italic;
}

.select-actions {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}

.change-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 16px;
}

.change-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  font-size: 13px;
  cursor: pointer;
}
.change-row:hover {
  background: var(--bg-hover);
}

.kind {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.kind.move {
  background: var(--accent-bg);
  color: var(--accent);
}
.kind.create {
  background: rgba(31, 146, 84, 0.15);
  color: var(--success);
}
.kind.trash {
  background: var(--danger-bg);
  color: var(--danger);
}

.change-label {
  font-weight: 600;
  flex: 1;
  min-width: 0;
}

.change-detail {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 12px;
}

.confidence {
  font-size: 11px;
  color: var(--danger);
  white-space: nowrap;
}

@media (max-width: 860px) {
  /* Checkbox + kind + label on one line, the position detail underneath. */
  .change-row {
    flex-wrap: wrap;
    gap: 6px 8px;
  }
  .change-label {
    flex: 1 1 auto;
  }
  .change-detail,
  .confidence {
    flex: 1 1 100%;
    padding-left: 26px;
  }
  .preview {
    max-width: 100%;
  }
}
</style>
