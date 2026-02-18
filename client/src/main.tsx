import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { logApiBaseUrlOnce } from './api'
import './index.css'
import App from './App.tsx'

logApiBaseUrlOnce()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
