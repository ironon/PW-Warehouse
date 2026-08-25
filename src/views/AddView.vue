<script setup lang="ts">
import { ref } from 'vue'
import ContainersPanel from './add/ContainersPanel.vue'
import ItemsPanel from './add/ItemsPanel.vue'
import ContainerTypesPanel from './add/ContainerTypesPanel.vue'

const tab = ref<'containers' | 'items' | 'types'>('containers')
</script>

<template>
  <div class="add-view">
    <div class="tabs">
      <button :class="{ active: tab === 'containers' }" @click="tab = 'containers'">Containers</button>
      <button :class="{ active: tab === 'items' }" @click="tab = 'items'">Items</button>
      <button :class="{ active: tab === 'types' }" @click="tab = 'types'">Container Types</button>
    </div>

    <ContainersPanel v-if="tab === 'containers'" />
    <ItemsPanel v-else-if="tab === 'items'" />
    <ContainerTypesPanel v-else />
  </div>
</template>

<style scoped>
.add-view {
  max-width: 1000px;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}

.tabs button {
  padding: 10px 16px;
  border: none;
  background: transparent;
  border-bottom: 2px solid transparent;
  font-size: 14px;
  color: var(--text-muted);
}

.tabs button:hover {
  color: var(--text);
}

.tabs button.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

@media (max-width: 860px) {
  /* Let the three sub-tabs scroll sideways rather than wrap awkwardly. */
  .tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs button {
    padding: 10px 12px;
    white-space: nowrap;
  }
}
</style>
