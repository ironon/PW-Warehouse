import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // Bind all interfaces so the app can be opened from a phone on the same
    // network (http://<laptop-lan-ip>:5173). Internal network only.
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      // None of these can trigger HMR, and watching them is actively harmful:
      // a file being written or locked (an archive mid-zip, a credential file
      // dropped in) makes the watcher throw EBUSY on Windows and kills the
      // dev server outright.
      ignored: [
        '**/backend/**',
        '**/*.zip',
        '**/*.json.tmp',
        '**/service_account_cred.json',
        '**/*firebase-adminsdk*.json',
        '**/dist/**',
      ],
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
})
