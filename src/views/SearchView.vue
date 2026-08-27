<script setup lang="ts">
import { computed, ref } from 'vue'
import { warehouse, itemById, containerTypeById, itemStackById } from '../store/warehouse'
import { readableTextColor } from '../lib/color'
import Icon from '../components/Icon.vue'
import PendingMoveBadge from '../components/PendingMoveBadge.vue'

const query = ref('')

type ReadonlyContainer = (typeof warehouse.containers)[number]

interface Result {
  container: ReadonlyContainer
  matchedItemNames: string[]
}

interface AddressGroup {
  address: string
  results: Result[]
}

// Shelf addresses look like SL1, SL1-M, SL1-M-A, SR3-M2-B: letters, digits,
// then up to two dash-separated segments. A trailing dash is allowed so the
// address stays recognised while you're still typing it.
const ADDRESS_PATTERN = /^[a-z]{1,3}\d+(-[a-z0-9]*){0,2}$/i

const trimmedQuery = computed(() => query.value.trim())

/** True when the query is shaped like an address AND actually prefixes a
 *  real location — so a label that happens to look address-ish still
 *  searches normally. */
const isAddressSearch = computed(() => {
  const q = trimmedQuery.value
  if (!q || !ADDRESS_PATTERN.test(q)) return false
  const upper = q.toUpperCase()
  return warehouse.containers.some((c) => c.location.toUpperCase().startsWith(upper))
})

function matchedItemsFor(container: ReadonlyContainer, q: string): string[] {
  if (!q) return []
  const names: string[] = []
  for (const stackId of container.contents) {
    const stack = itemStackById(stackId)
    if (!stack) continue
    const item = itemById(stack.itemRef)
    if (item && item.name.toLowerCase().includes(q)) names.push(item.name)
  }
  return names
}

/** Text search across container labels and the items inside them. */
const results = computed<Result[]>(() => {
  const q = trimmedQuery.value.toLowerCase()
  if (!q || isAddressSearch.value) return []

  const out: Result[] = []
  for (const container of warehouse.containers) {
    const matchedOnLabel = container.label.toLowerCase().includes(q)
    const matchedItemNames = matchedItemsFor(container, q)
    if (matchedOnLabel || matchedItemNames.length > 0) {
      out.push({ container, matchedItemNames })
    }
  }
  return out
})

/** Address search: every container whose location starts with the query,
 *  grouped by exact address so a shelf-level query reads as a shelf map. */
const addressGroups = computed<AddressGroup[]>(() => {
  if (!isAddressSearch.value) return []
  const upper = trimmedQuery.value.toUpperCase()

  const byAddress = new Map<string, Result[]>()
  for (const container of warehouse.containers) {
    if (!container.location.toUpperCase().startsWith(upper)) continue
    const list = byAddress.get(container.location)
    const result: Result = { container, matchedItemNames: [] }
    if (list) list.push(result)
    else byAddress.set(container.location, [result])
  }

  return [...byAddress.entries()]
    .map(([address, list]) => ({ address, results: list }))
    .sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }))
})

const addressTotal = computed(() => addressGroups.value.reduce((n, g) => n + g.results.length, 0))

const hasNoMatches = computed(
  () => Boolean(trimmedQuery.value) && results.value.length === 0 && addressGroups.value.length === 0
)

function contentsOf(container: ReadonlyContainer) {
  return container.contents
    .map((id) => itemStackById(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .map((stack) => ({ stack, item: itemById(stack.itemRef) }))
}
</script>

<template>
  <div class="search-view">
    <div class="search-bar">
      <input
        v-model="query"
        type="text"
        placeholder="Search by label, contents, or address&hellip;"
        autofocus
      />
    </div>

    <p v-if="!trimmedQuery" class="hint">
      Search by label or contents, or type a shelf address like SL1-M-A to see what's stored there.
    </p>
    <p v-else-if="hasNoMatches" class="hint">Nothing found for “{{ trimmedQuery }}”.</p>

    <!-- Address search: grouped by exact position -->
    <div v-else-if="isAddressSearch" class="results">
      <p class="count">
        {{ addressTotal }} container{{ addressTotal === 1 ? '' : 's' }} across
        {{ addressGroups.length }} position{{ addressGroups.length === 1 ? '' : 's' }}
      </p>

      <section v-for="group in addressGroups" :key="group.address" class="address-group">
        <h2 class="address-heading">
          <Icon name="pin" :size="14" />
          <span>{{ group.address }}</span>
          <span class="address-count">{{ group.results.length }}</span>
        </h2>

        <div v-for="r in group.results" :key="r.container.id" class="card">
          <div class="card-header">
            <div class="title">
              <span class="label">{{ r.container.label || '(no label)' }}</span>
              <span
                v-if="r.container.containerType"
                class="type-badge"
                :style="{
                  background: containerTypeById(r.container.containerType)?.color || undefined,
                  color: readableTextColor(containerTypeById(r.container.containerType)?.color || ''),
                }"
              >
                {{ containerTypeById(r.container.containerType)?.name || r.container.containerType }}
              </span>
            </div>
          </div>

          <PendingMoveBadge v-if="r.container.pendingMove" :container-id="r.container.id" />

          <p v-if="r.container.notes" class="notes">{{ r.container.notes }}</p>

          <div v-if="contentsOf(r.container).length" class="contents">
            <span v-for="{ stack, item } in contentsOf(r.container)" :key="stack.id" class="item-chip">
              {{ item?.name || stack.itemRef }}<template v-if="stack.quantity"> × {{ stack.quantity }}</template>
            </span>
          </div>

          <p class="id">{{ r.container.id }}</p>
        </div>
      </section>
    </div>

    <!-- Text search: flat list -->
    <div v-else class="results">
      <p class="count">{{ results.length }} container{{ results.length === 1 ? '' : 's' }} found</p>
      <div v-for="r in results" :key="r.container.id" class="card">
        <div class="card-header">
          <div class="title">
            <span class="label">{{ r.container.label || '(no label)' }}</span>
            <span
              v-if="r.container.containerType"
              class="type-badge"
              :style="{
                background: containerTypeById(r.container.containerType)?.color || undefined,
                color: readableTextColor(containerTypeById(r.container.containerType)?.color || ''),
              }"
            >
              {{ containerTypeById(r.container.containerType)?.name || r.container.containerType }}
            </span>
          </div>
          <span class="location">
            <Icon name="pin" :size="13" />
            {{ r.container.location }}
          </span>
        </div>

        <PendingMoveBadge v-if="r.container.pendingMove" :container-id="r.container.id" />

        <p v-if="r.container.notes" class="notes">{{ r.container.notes }}</p>

        <div v-if="contentsOf(r.container).length" class="contents">
          <span
            v-for="{ stack, item } in contentsOf(r.container)"
            :key="stack.id"
            class="item-chip"
            :class="{ matched: item && r.matchedItemNames.includes(item.name) }"
          >
            {{ item?.name || stack.itemRef }}<template v-if="stack.quantity"> × {{ stack.quantity }}</template>
          </span>
        </div>

        <p class="id">{{ r.container.id }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  max-width: 900px;
}

.search-bar input {
  width: 100%;
  padding: 12px 16px;
  font-size: 16px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}

.search-bar input:focus {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.hint {
  color: var(--text-muted);
  margin-top: 20px;
}

.count {
  color: var(--text-muted);
  margin: 20px 0 12px;
}

.results {
  display: flex;
  flex-direction: column;
}

.card {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  margin-bottom: 10px;
}

.card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.label {
  font-weight: 600;
  font-size: 15px;
}

.type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-bg);
  color: var(--text);
  /* Inset ring rather than a border, so a white container-type colour still
     reads as a badge against a white card without shifting layout. */
  box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.35);
}

.location {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 13px;
  font-family: var(--mono);
}

.address-group {
  margin-bottom: 22px;
}

.address-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-family: var(--mono);
  color: var(--text-muted);
  letter-spacing: 0.02em;
  padding-bottom: 7px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.address-count {
  margin-left: auto;
  font-family: var(--sans);
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-hover);
}

.notes {
  color: var(--text-muted);
  font-size: 13px;
  margin: 6px 0 0;
}

.contents {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.item-chip {
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--bg-hover);
  border: 1px solid var(--border);
}

.item-chip.matched {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.id {
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--mono);
  margin: 8px 0 0;
}

@media (max-width: 860px) {
  /* Stack header rows so the location always sits on its own line, rather
     than wrapping inconsistently depending on how long the label is. */
  .card-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .title {
    flex-wrap: wrap;
  }
  .label {
    font-size: 14px;
  }
}
</style>
