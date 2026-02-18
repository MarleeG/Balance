import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const previewApiPort = process.env.API_PORT?.trim() || '3000'
const previewApiTarget = process.env.PREVIEW_API_TARGET?.trim() || `http://127.0.0.1:${previewApiPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  preview: {
    allowedHosts: ['balance-2bbjqq.fly.dev', '.fly.dev', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        target: previewApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
