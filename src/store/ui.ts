import { ref, watch } from 'vue'

const COLLAPSE_KEY = 'pw-warehouse.sidebarCollapsed'
const MOBILE_QUERY = '(max-width: 860px)'

/** Desktop: sidebar shrunk to an icon-only rail. Persisted. */
export const sidebarCollapsed = ref(localStorage.getItem(COLLAPSE_KEY) === '1')

/** Mobile: off-canvas drawer showing. Never persisted — always starts closed. */
export const sidebarOpen = ref(false)

watch(sidebarCollapsed, (value) => {
  localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
})

const mq = window.matchMedia(MOBILE_QUERY)
export const isMobile = ref(mq.matches)

mq.addEventListener('change', (e) => {
  isMobile.value = e.matches
  // Leaving mobile with the drawer open would strand the overlay on desktop.
  if (!e.matches) sidebarOpen.value = false
})

/** On mobile this opens/closes the drawer; on desktop it collapses the rail. */
export function toggleSidebar(): void {
  if (isMobile.value) sidebarOpen.value = !sidebarOpen.value
  else sidebarCollapsed.value = !sidebarCollapsed.value
}

export function closeDrawer(): void {
  sidebarOpen.value = false
}
