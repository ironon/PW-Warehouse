<script setup lang="ts">
// Works out the truss structure for an LED wall and shows what to load.
//
// The numbers live in one place, src/lib/truss.ts; this tab is the inputs, the
// parts list, and the 3D view. Everything under Rules is editable because the
// limits are judgement calls that change with the venue.
import { computed, ref, watch, type DeepReadonly } from 'vue'
import {
  DEFAULT_SPEC,
  DEFAULT_STOCK,
  lengthColor,
  metres,
  planTruss,
  type TrussSetup,
  type TrussSpec,
} from '../lib/truss'
import { warehouse, saveTrussSetup, deleteTrussSetup } from '../store/warehouse'
import TrussScene from '../components/TrussScene.vue'
import Icon from '../components/Icon.vue'

// Rules are set once and then reused every event, so they outlive a reload.
// This is a per-browser convenience; a whole build is shared through Saved
// setups instead.
const RULES_KEY = 'pw-truss-rules'

const spec = ref<TrussSpec>({ ...DEFAULT_SPEC, stock: [...DEFAULT_STOCK] })
const stockText = ref(DEFAULT_STOCK.join(', '))
const showRules = ref(false)
const setupName = ref('')
const error = ref('')
const saved = ref('')

try {
  const stored = localStorage.getItem(RULES_KEY)
  if (stored) {
    const parsed = JSON.parse(stored) as Partial<TrussSpec>
    // Only the rules come back, never the wall size: that is per event.
    const { panelsWide, panelsHigh, ...rules } = parsed as TrussSpec
    void panelsWide
    void panelsHigh
    Object.assign(spec.value, rules)
    if (Array.isArray(spec.value.stock)) stockText.value = spec.value.stock.join(', ')
  }
} catch {
  // A corrupt or blocked localStorage is not worth failing the tab over.
}

const plan = computed(() => planTruss(spec.value))

/** Parses the comma-separated stock list, ignoring anything unparseable so
 *  the field stays usable mid-edit. */
watch(stockText, (text) => {
  const lengths = text
    .split(/[,\s]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (lengths.length) spec.value.stock = lengths
})

watch(
  spec,
  (next) => {
    try {
      localStorage.setItem(RULES_KEY, JSON.stringify(next))
    } catch {
      /* storage blocked; the tab still works for this session */
    }
  },
  { deep: true }
)

const legDescription = computed(() => {
  const segments = plan.value.leg.segments
  if (!segments.length) return 'nothing fits'
  return segments.map((s) => metres(s)).join(' + ')
})

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
}

function setPercent(field: 'footRatio', value: string) {
  const n = Number(value)
  if (Number.isFinite(n)) spec.value[field] = n / 100
}

async function save() {
  error.value = ''
  saved.value = ''
  try {
    await saveTrussSetup(setupName.value, spec.value)
    saved.value = `Saved “${setupName.value.trim()}”.`
    setupName.value = ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

// The store hands out deeply readonly views, so a saved setup is copied on
// the way in rather than being edited in place.
type StoredSetup = DeepReadonly<TrussSetup>

function loadSetup(setup: StoredSetup) {
  spec.value = { ...setup.spec, stock: [...setup.spec.stock] }
  stockText.value = setup.spec.stock.join(', ')
  setupName.value = setup.name
  saved.value = `Loaded “${setup.name}”.`
  error.value = ''
}

async function removeSetup(setup: StoredSetup) {
  if (!confirm(`Delete the saved setup “${setup.name}”?`)) return
  error.value = ''
  try {
    await deleteTrussSetup(setup.id)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function formatWhen(at: number): string {
  if (!at) return ''
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="truss-view">
    <p v-if="error" class="error-banner">{{ error }}</p>
    <p v-if="saved" class="ok-banner">{{ saved }}</p>

    <!-- Wall size ---------------------------------------------------------->
    <div class="form-card">
      <h3 class="section-heading">Video wall</h3>
      <div class="form-grid five">
        <div class="field">
          <label for="panels-wide">Panels across</label>
          <input id="panels-wide" v-model.number="spec.panelsWide" type="number" min="1" step="1" />
        </div>
        <div class="field">
          <label for="panels-high">Panels high</label>
          <input id="panels-high" v-model.number="spec.panelsHigh" type="number" min="1" step="1" />
        </div>
        <div class="field">
          <label for="panel-w">Panel width (m)</label>
          <input id="panel-w" v-model.number="spec.panelWidth" type="number" min="0.05" step="0.05" />
        </div>
        <div class="field">
          <label for="panel-h">Panel height (m)</label>
          <input id="panel-h" v-model.number="spec.panelHeight" type="number" min="0.05" step="0.05" />
        </div>
        <div class="field">
          <label for="panel-d">Panel depth (m)</label>
          <input id="panel-d" v-model.number="spec.panelDepth" type="number" min="0.01" step="0.01" />
        </div>
      </div>
      <p class="wall-size">
        <span class="address-tag">
          <Icon name="pin" :size="13" />
          {{ metres(plan.wallWidth) }} wide × {{ metres(plan.wallHeight) }} tall
        </span>
      </p>
    </div>

    <p v-for="(warning, i) in plan.warnings" :key="i" class="error-banner">{{ warning }}</p>

    <!-- What it comes to --------------------------------------------------->
    <div class="form-card">
      <div class="summary">
        <div class="stat">
          <span class="stat-value">{{ plan.positions.length }}</span>
          <span class="stat-label">L frames</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ plan.totalPieces }}</span>
          <span class="stat-label">pieces to load</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ plan.totalLength.toFixed(1) }} m</span>
          <span class="stat-label">of truss</span>
        </div>
        <div class="stat">
          <span class="stat-value">{{ metres(plan.leg.standingHeight) }}</span>
          <span class="stat-label">leg height</span>
        </div>
      </div>

      <dl class="facts">
        <div>
          <dt>Each leg</dt>
          <dd>
            {{ metres(plan.spec.section) }} box + {{ legDescription }} =
            {{ metres(plan.leg.standingHeight) }}, leaving
            {{ metres(plan.leg.headroom) }} of wall above it
          </dd>
        </div>
        <div>
          <dt>Each foot</dt>
          <dd>{{ metres(plan.leg.foot) }}, reaching {{ metres(plan.leg.footReach) }} back from the wall</dd>
        </div>
        <div>
          <dt>Leg spacing</dt>
          <dd>
            {{ metres(plan.gap) }} of clear air, {{ metres(plan.pitch) }} centre to centre
          </dd>
        </div>
        <div>
          <dt>End legs</dt>
          <dd>
            {{ metres(plan.inset) }} in from each edge
            <span class="muted"
              >({{ (plan.inset / plan.spec.panelWidth).toFixed(1) }} panels overhanging)</span
            >
          </dd>
        </div>
        <div v-if="plan.connector">
          <dt>Connecting bars</dt>
          <dd>
            {{ plan.connector.heights.length }} row{{ plan.connector.heights.length === 1 ? '' : 's' }} of
            {{ metres(plan.connector.length) }},
            {{ plan.connector.count }} bars in all
            <span class="muted">
              — at {{ plan.connector.heights.map((h) => metres(h)).join(', ') }} up
            </span>
          </dd>
        </div>
        <div v-else>
          <dt>Connecting bars</dt>
          <dd class="muted">none — see the warning above</dd>
        </div>
      </dl>
    </div>

    <!-- 3D ----------------------------------------------------------------->
    <div class="form-card">
      <h3 class="section-heading">Structure</h3>
      <TrussScene :plan="plan" />
    </div>

    <!-- Parts -------------------------------------------------------------->
    <div class="form-card">
      <h3 class="section-heading">What to load</h3>
      <ul class="totals">
        <li v-for="line in plan.stockTotals" :key="`${line.kind}-${line.length}`">
          <span class="swatch" :style="{ background: lengthColor(line.length, plan.spec.stock, line.kind) }" />
          <span class="qty">{{ line.quantity }}×</span>
          <span class="what">{{ line.kind === 'ub' ? 'universal box' : `${metres(line.length)} truss` }}</span>
        </li>
      </ul>

      <h4 class="sub-heading">Where each piece goes</h4>
      <ul class="breakdown">
        <li v-for="(line, i) in plan.bill" :key="i">
          <span class="qty">{{ line.quantity }}×</span>
          {{ line.kind === 'ub' ? 'universal box' : metres(line.length) }}
          <span class="muted">— {{ line.usedFor }}</span>
        </li>
      </ul>
    </div>

    <!-- Saved setups ------------------------------------------------------->
    <div class="form-card">
      <h3 class="section-heading">Saved setups</h3>
      <div class="panel-toolbar">
        <input
          v-model="setupName"
          type="text"
          placeholder="Name this build, e.g. Alfred St gala"
          @keyup.enter="save"
        />
        <button class="btn btn-primary" :disabled="!setupName.trim()" @click="save">Save</button>
      </div>

      <p v-if="warehouse.trussSetups.length === 0" class="hint">
        Nothing saved yet. A saved setup keeps the wall size and the rules, and everyone on the network sees
        the same list.
      </p>
      <div v-else class="panel-list">
        <div v-for="setup in warehouse.trussSetups" :key="setup.id" class="panel-row" @click="loadSetup(setup)">
          <span class="row-main">
            <span class="setup-name">{{ setup.name }}</span>
            <span class="address-tag">{{ setup.spec.panelsWide }} × {{ setup.spec.panelsHigh }} panels</span>
          </span>
          <span class="row-end">
            <span class="muted">{{ setup.savedBy }} · {{ formatWhen(setup.savedAt) }}</span>
            <button class="btn small btn-danger" @click.stop="removeSetup(setup)">Delete</button>
          </span>
        </div>
      </div>
    </div>

    <!-- Rules -------------------------------------------------------------->
    <div class="form-card">
      <div class="rules-head">
        <h3 class="section-heading">Rules</h3>
        <button class="btn small" @click="showRules = !showRules">
          {{ showRules ? 'Hide' : 'Edit' }}
        </button>
      </div>
      <p class="hint">
        Truss lengths {{ plan.spec.stock.join(', ') }} m · legs at most {{ metres(spec.maxGap) }} apart ·
        end legs within {{ metres(spec.maxEdgeOffset) }} of the edge · boxes always tied together, then
        another row every {{ spec.connectorEvery }} panels up
      </p>

      <template v-if="showRules">
        <div class="form-grid single">
          <div class="field">
            <label for="stock">Truss lengths we own (m)</label>
            <input id="stock" v-model="stockText" type="text" placeholder="2.5, 2, 1.5, 1.25, 1, 0.5" />
          </div>
        </div>
        <div class="form-grid four">
          <div class="field">
            <label for="section">Truss / box size (m)</label>
            <input id="section" v-model.number="spec.section" type="number" min="0.05" step="0.05" />
          </div>
          <div class="field">
            <label for="edge">Max edge to end leg (m)</label>
            <input id="edge" v-model.number="spec.maxEdgeOffset" type="number" min="0" step="0.05" />
          </div>
          <div class="field">
            <label for="gap">Max gap between legs (m)</label>
            <input id="gap" v-model.number="spec.maxGap" type="number" min="0.1" step="0.1" />
          </div>
          <div class="field">
            <label for="every">Extra bar row every (panels up)</label>
            <input id="every" v-model.number="spec.connectorEvery" type="number" min="1" step="1" />
          </div>
          <div class="field">
            <label for="foot-ratio">Foot length (% of leg height)</label>
            <input
              id="foot-ratio"
              type="number"
              min="5"
              max="100"
              step="1"
              :value="Math.round(spec.footRatio * 100)"
              @input="setPercent('footRatio', ($event.target as HTMLInputElement).value)"
            />
          </div>
        </div>
        <p class="hint">
          The gap limit is clear air between legs, so it decides the centre-to-centre pitch together with
          the truss width. Leg spacing is chosen so one of our own lengths fills that gap exactly, which is
          what makes the connecting bars drop straight in. Foot length is currently
          {{ percent(spec.footRatio) }} of the standing height, rounded to the nearest length we own.
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.truss-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-heading {
  font-size: 15px;
  margin-bottom: 12px;
}

.sub-heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin: 16px 0 8px;
}

.form-grid.four {
  grid-template-columns: repeat(4, 1fr);
}

.form-grid.five {
  grid-template-columns: repeat(5, 1fr);
}

.wall-size {
  margin: 4px 0 0;
}

.summary {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
  padding-bottom: 14px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  font-family: var(--mono);
  letter-spacing: -0.01em;
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

.facts {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.facts > div {
  display: flex;
  gap: 10px;
  font-size: 13px;
  flex-wrap: wrap;
}

.facts dt {
  flex: 0 0 130px;
  color: var(--text-muted);
  font-weight: 600;
}

.facts dd {
  margin: 0;
  min-width: 0;
}

.muted {
  color: var(--text-muted);
}

.totals {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
}

.totals li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  font-size: 14px;
}

.swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: 0 0 auto;
}

.qty {
  font-family: var(--mono);
  font-weight: 700;
}

.breakdown {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rules-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.hint {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.5;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.setup-name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.row-end {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  white-space: nowrap;
}

.btn.small {
  padding: 5px 11px;
  font-size: 13px;
}

@media (max-width: 860px) {
  .form-grid.four,
  .form-grid.five {
    grid-template-columns: 1fr 1fr;
  }

  .summary {
    gap: 18px;
  }

  .facts dt {
    flex-basis: 100%;
  }
}
</style>
