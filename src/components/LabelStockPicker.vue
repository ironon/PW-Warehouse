<script setup lang="ts">
import { computed } from 'vue'
import { stocks, currentStockId, stocksLoaded, stockError, changeStock, currentStock } from '../store/labelStock'

withDefaults(defineProps<{ compact?: boolean }>(), { compact: false })

const stock = computed(() => currentStock())

async function onChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value
  try {
    await changeStock(id)
  } catch {
    /* stockError is shown below */
  }
}
</script>

<template>
  <div class="stock-picker" :class="{ compact }">
    <label :for="`stock-${compact ? 'c' : 'f'}`">Label stock loaded</label>

    <select
      v-if="stocksLoaded"
      :id="`stock-${compact ? 'c' : 'f'}`"
      :value="currentStockId"
      @change="onChange"
    >
      <option v-for="s in stocks" :key="s.id" :value="s.id">{{ s.name }}</option>
    </select>
    <p v-else class="offline">Print service not running.</p>

    <p v-if="stock && stocksLoaded" class="detail">
      Prints {{ stock.design_width_mm }} × {{ stock.design_height_mm }} mm<template v-if="stock.rotate">
        , rotated {{ stock.rotate }}°</template>
    </p>
    <p v-if="stockError" class="err">{{ stockError }}</p>
  </div>
</template>

<style scoped>
.stock-picker label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.stock-picker select {
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 13px;
}

.compact select {
  font-size: 13px;
}

.detail {
  margin: 5px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.offline {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.err {
  margin: 5px 0 0;
  font-size: 11px;
  color: var(--danger);
}
</style>
