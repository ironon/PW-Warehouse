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
    // Vite rejects requests whose Host header it doesn't recognise (DNS-rebinding
    // protection). The app is reached as http://pw-warehouse.local on this
    // network, so that name and any other intranet name must be allowed through.
    allowedHosts: ['pw-warehouse.local', '.local', 'pw-warehouse'],
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
    allowedHosts: ['pw-warehouse.local', '.local', 'pw-warehouse'],
  },
})
