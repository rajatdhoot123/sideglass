import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    build: {
      // Tango is ESM-only. Bundle it into the main process instead of require().
      externalizeDeps: {
        exclude: [
          '@yume-chan/adb',
          '@yume-chan/adb-scrcpy',
          '@yume-chan/adb-server-node-tcp',
          '@yume-chan/scrcpy',
          '@yume-chan/stream-extra',
        ],
      },
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    plugins: [react()],
  },
})
