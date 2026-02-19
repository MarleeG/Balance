import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const previewApiPort = process.env.API_PORT?.trim() || '3000'
const previewApiTarget = process.env.PREVIEW_API_TARGET?.trim() || `http://127.0.0.1:${previewApiPort}`
const previewAllowedHosts = process.env.PREVIEW_ALLOWED_HOSTS
  ?.split(',')
  .map((host) => host.trim())
  .filter((host) => host.length > 0)
  ?? ['.fly.dev', '.internal', 'localhost', '127.0.0.1']

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  preview: {
    allowedHosts: previewAllowedHosts,
    proxy: {
      '/api': {
        target: previewApiTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
