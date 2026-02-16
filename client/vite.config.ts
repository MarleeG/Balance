import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  preview: {
    allowedHosts: ['balance-2bbjqq.fly.dev', '.fly.dev', 'localhost', '127.0.0.1'],
  },
})
