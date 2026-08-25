import { ref, watch } from 'vue'

const STORAGE_KEY = 'pw-warehouse.username'

export const username = ref(localStorage.getItem(STORAGE_KEY) ?? '')

watch(username, (value) => {
  const trimmed = value.trim()
  if (trimmed) localStorage.setItem(STORAGE_KEY, trimmed)
  else localStorage.removeItem(STORAGE_KEY)
})

/** Who to attribute a database change to. */
export function currentUser(): string {
  return username.value.trim() || 'unknown'
}
