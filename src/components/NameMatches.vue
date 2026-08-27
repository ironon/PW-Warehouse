<script setup lang="ts">
// The duplicate warning and "did you mean" list under a name field on the Add
// forms. Display only — it never changes anything, it just stops you typing.
import { computed } from 'vue'
import type { NameMatchResult } from '../lib/similar'

const props = withDefaults(
  defineProps<{
    result: NameMatchResult
    /** Singular noun for the thing being created, e.g. "item". */
    noun: string
    /** Plural, when it isn't just noun + "s". */
    nounPlural?: string
    /** Softens the wording when a match doesn't actually block creation. */
    blocking?: boolean
  }>(),
  { blocking: true }
)

const plural = computed(() => props.nounPlural ?? `${props.noun}s`)
const hasExact = computed(() => props.result.exact.length > 0)
</script>

<template>
  <div v-if="hasExact || result.similar.length" class="matches">
    <p v-if="hasExact" class="dupe" :class="{ soft: !blocking }">
      <strong>{{ blocking ? 'Already exists.' : 'Heads up.' }}</strong>
      <template v-if="blocking">
        There is already {{ /^[aeiou]/i.test(noun) ? 'an' : 'a' }} {{ noun }} called
      </template>
      <template v-else> There is also {{ /^[aeiou]/i.test(noun) ? 'an' : 'a' }} {{ noun }} called </template>
      <span v-for="(m, i) in result.exact" :key="m.id">
        <template v-if="i > 0">, </template>
        “{{ m.name }}” <span class="id">({{ m.id }}<template v-if="m.detail"> · {{ m.detail }}</template>)</span>
      </span>
      <template v-if="blocking">. Nothing was created.</template>
    </p>

    <div v-if="result.similar.length" class="similar">
      <span class="similar-title">Similar {{ plural }} already recorded</span>
      <div v-for="m in result.similar" :key="m.id" class="similar-row">
        <span class="similar-name">{{ m.name }}</span>
        <span class="id">{{ m.detail ? `${m.detail} · ` : '' }}{{ m.id }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Sits ABOVE the name field: on a phone the keyboard covers the bottom of the
   screen while you type, so anything below the input is unreadable exactly
   when it matters. */
.matches {
  margin-bottom: 14px;
}

.dupe {
  margin: 0 0 8px;
  padding: 8px 10px;
  border-radius: var(--radius);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: 13px;
}

/* A non-blocking notice is information, not a refusal. */
.dupe.soft {
  background: var(--accent-bg);
  color: var(--accent);
}

.similar {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  background: var(--bg);
}

.similar-title {
  display: block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.similar-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}

.similar-name {
  overflow-wrap: anywhere;
}

.id {
  color: var(--text-muted);
  font-size: 12px;
  font-family: var(--mono);
  white-space: nowrap;
}
</style>
