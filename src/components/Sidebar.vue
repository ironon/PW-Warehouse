<script setup lang="ts">
import { computed } from 'vue'
import { warehouse, pendingMoveCount } from '../store/warehouse'
import { username } from '../store/user'
import { sidebarCollapsed, isMobile, toggleSidebar, closeDrawer } from '../store/ui'
import Icon from './Icon.vue'
import LabelStockPicker from './LabelStockPicker.vue'
import { stocksLoaded } from '../store/labelStock'
import type { Tab, IconName } from '../lib/types'

const props = defineProps<{ active: Tab }>()
const emit = defineEmits<{ navigate: [tab: Tab] }>()

const tabs: { id: Tab; icon: IconName; label: string }[] = [
  { id: 'search', icon: 'search', label: 'Search' },
  { id: 'add', icon: 'plus', label: 'Add' },
  { id: 'scan', icon: 'camera', label: 'Scan Shelf' },
  { id: 'ai', icon: 'sparkles', label: 'AI Work' },
  { id: 'print', icon: 'printer', label: 'Print Label' },
  { id: 'logs', icon: 'history', label: 'Logs' },
  { id: 'trash', icon: 'trash', label: 'Deleted' },
]

// The icon rail only applies on desktop; the mobile drawer is always full width.
const rail = computed(() => sidebarCollapsed.value && !isMobile.value)

/** Boxes somebody still has to carry. Worth seeing from every tab. */
const pendingCount = computed(() => pendingMoveCount())

const initial = computed(() => (username.value.trim()[0] ?? '?').toUpperCase())

function go(tab: Tab) {
  emit('navigate', tab)
  if (isMobile.value) closeDrawer()
}

// Referenced so the prop is used in script as well as template.
const activeTab = computed(() => props.active)
</script>

<template>
  <aside class="sidebar" :class="{ rail }">
    <div class="head">
      <span v-if="!rail" class="brand">PW-Warehouse</span>
      <button class="toggle" :title="rail ? 'Expand sidebar' : 'Collapse sidebar'" @click="toggleSidebar">
        <Icon v-if="isMobile" name="close" :size="18" />
        <Icon v-else :name="rail ? 'chevron-right' : 'chevron-left'" :size="18" />
      </button>
    </div>

    <nav>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: activeTab === tab.id }"
        :title="rail ? tab.label : undefined"
        @click="go(tab.id)"
      >
        <Icon :name="tab.icon" :size="17" />
        <span v-if="!rail" class="text">{{ tab.label }}</span>
        <span v-if="tab.id === 'trash' && warehouse.trash.length" class="badge" :class="{ dot: rail }">
          {{ rail ? '' : warehouse.trash.length }}
        </span>
        <span v-if="tab.id === 'ai' && pendingCount" class="badge" :class="{ dot: rail }">
          {{ rail ? '' : pendingCount }}
        </span>
      </button>
    </nav>

    <div class="user-box">
      <template v-if="rail">
        <button class="avatar" :title="username.trim() || 'Set your name'" @click="toggleSidebar">
          {{ initial }}
        </button>
      </template>
      <template v-else>
        <label for="username">Signed in as</label>
        <input id="username" v-model="username" type="text" placeholder="Your name" />
        <p v-if="!username.trim()" class="user-hint">Changes are logged as “unknown” until you set this.</p>
        <LabelStockPicker v-if="stocksLoaded" class="stock-block" />
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 220px;
  flex: 0 0 220px;
  background: var(--bg-elevated);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 12px;
  min-height: 100svh;
  transition: width 0.16s ease, flex-basis 0.16s ease;
}

.sidebar.rail {
  width: 60px;
  flex-basis: 60px;
  padding: 12px 8px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 16px;
}

.rail .head {
  justify-content: center;
  padding: 4px 0 16px;
}

.brand {
  font-size: 16px;
  font-weight: 700;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
  padding: 6px 8px;
  border-radius: var(--radius);
  flex: 0 0 auto;
}
.toggle:hover {
  background: var(--bg-hover);
  color: var(--text);
}

nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

nav button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  border-radius: var(--radius);
  text-align: left;
  font-size: 14px;
  color: var(--text);
}

.rail nav button {
  justify-content: center;
  padding: 10px 0;
}

nav button:hover {
  background: var(--bg-hover);
}

nav button.active {
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 600;
}

.text {
  white-space: nowrap;
}

.badge {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--danger-bg);
  color: var(--danger);
}

/* In the rail there's no room for a count, so show a marker instead. */
.badge.dot {
  position: absolute;
  top: 6px;
  right: 8px;
  margin: 0;
  padding: 0;
  width: 7px;
  height: 7px;
  background: var(--danger);
}

.user-box {
  margin-top: auto;
  padding: 12px 4px 4px;
  border-top: 1px solid var(--border);
}

.rail .user-box {
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-hover);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.avatar:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.user-box label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.user-box input {
  width: 100%;
  padding: 7px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg);
  font-size: 16px; /* >=16px stops iOS Safari zooming in on focus */
}

.user-hint {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.35;
}

.stock-block {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

@media (max-width: 860px) {
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 30;
    width: 260px;
    flex-basis: 260px;
    box-shadow: 4px 0 16px rgba(0, 0, 0, 0.18);
  }
}
</style>
