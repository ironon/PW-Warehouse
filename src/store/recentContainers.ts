import { ref, watch } from 'vue'

// Personal convenience, so it lives in localStorage rather than the shared
// database — unlike the loaded label stock, which describes the hardware.
const STORAGE_KEY = 'pw-warehouse.recentContainers'
const MAX_RECENT = 8

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

/** Container ids, most recently opened first. */
export const recentContainerIds = ref<string[]>(load())

watch(
  recentContainerIds,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    } catch {
      /* private mode or full storage — the list just won't persist */
    }
  },
  { deep: true }
)

export function markContainerViewed(id: string): void {
  const without = recentContainerIds.value.filter((v) => v !== id)
  recentContainerIds.value = [id, ...without].slice(0, MAX_RECENT)
}

export function forgetContainer(id: string): void {
  recentContainerIds.value = recentContainerIds.value.filter((v) => v !== id)
}

export function clearRecentContainers(): void {
  recentContainerIds.value = []
}
