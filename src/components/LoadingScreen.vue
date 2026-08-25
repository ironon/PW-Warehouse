<script setup lang="ts">
defineProps<{ error?: string | null }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="loading-screen">
    <template v-if="error">
      <div class="icon error">!</div>
      <h2>Couldn't load the warehouse database</h2>
      <p class="detail">{{ error }}</p>
      <button class="retry" @click="emit('retry')">Retry</button>
    </template>
    <template v-else>
      <div class="spinner" />
      <h2>Loading warehouse database&hellip;</h2>
      <p class="detail">Fetching containers and inventory from Google Sheets.</p>
    </template>
  </div>
</template>

<style scoped>
.loading-screen {
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  padding: 24px;
}

.spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
  margin-bottom: 8px;
}

.icon.error {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--danger-bg);
  color: var(--danger);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  margin-bottom: 8px;
}

.detail {
  color: var(--text-muted);
  max-width: 420px;
}

.retry {
  margin-top: 12px;
  padding: 8px 20px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}
.retry:hover {
  background: var(--bg-hover);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
