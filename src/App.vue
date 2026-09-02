<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { warehouse, load } from './store/warehouse'
import { isMobile, sidebarOpen, toggleSidebar, closeDrawer } from './store/ui'
import { loadStocks } from './store/labelStock'
import LoadingScreen from './components/LoadingScreen.vue'
import Sidebar from './components/Sidebar.vue'
import Icon from './components/Icon.vue'
import SearchView from './views/SearchView.vue'
import AddView from './views/AddView.vue'
import ScanView from './views/ScanView.vue'
import AiWorkView from './views/AiWorkView.vue'
import PrintView from './views/PrintView.vue'
import LogsView from './views/LogsView.vue'
import TrashView from './views/TrashView.vue'
import type { Tab } from './lib/types'

// The truss calculator carries three.js with it, which is larger than the
// whole rest of the app. Loading it only when somebody opens that tab keeps
// the shelf lookup people use on their phones as light as it was.
const TrussView = defineAsyncComponent(() => import('./views/TrussView.vue'))

const tab = ref<Tab>('search')

const TITLES: Record<Tab, string> = {
  search: 'Search',
  add: 'Add',
  scan: 'Scan Shelf',
  ai: 'AI Work',
  truss: 'Truss Calculator',
  print: 'Print Label',
  logs: 'Logs',
  trash: 'Deleted Containers',
}

const title = computed(() => TITLES[tab.value])

onMounted(() => {
  load()
  // Fire and forget: if the print service isn't running the app is unaffected.
  loadStocks()
})
</script>

<template>
  <LoadingScreen v-if="!warehouse.loaded" :error="warehouse.error" @retry="load" />
  <div v-else class="layout">
    <header v-if="isMobile" class="topbar">
      <button class="menu-btn" aria-label="Open menu" @click="toggleSidebar">
        <Icon name="menu" :size="20" />
      </button>
      <span class="topbar-title">{{ title }}</span>
      <span v-if="warehouse.saving" class="saving">Saving…</span>
    </header>

    <div v-if="isMobile && sidebarOpen" class="backdrop" @click="closeDrawer" />

    <Sidebar v-if="!isMobile || sidebarOpen" :active="tab" @navigate="tab = $event" />

    <main class="content">
      <SearchView v-if="tab === 'search'" />
      <AddView v-else-if="tab === 'add'" />
      <ScanView v-else-if="tab === 'scan'" />
      <AiWorkView v-else-if="tab === 'ai'" />
      <TrussView v-else-if="tab === 'truss'" />
      <PrintView v-else-if="tab === 'print'" />
      <LogsView v-else-if="tab === 'logs'" />
      <TrashView v-else />
    </main>
  </div>
</template>

<style scoped>
.layout {
  display: flex;
  min-height: 100svh;
}

.content {
  flex: 1;
  min-width: 0;
}

.topbar {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 20;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
}

.menu-btn {
  display: flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 8px 10px;
  border-radius: var(--radius);
}
.menu-btn:hover {
  background: var(--bg-hover);
}

.topbar-title {
  font-weight: 600;
  font-size: 15px;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.saving {
  font-size: 12px;
  color: var(--text-muted);
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 25;
  background: rgba(0, 0, 0, 0.45);
}

@media (max-width: 860px) {
  /* Clear the fixed top bar. */
  .content {
    padding-top: 52px;
  }
}
</style>
