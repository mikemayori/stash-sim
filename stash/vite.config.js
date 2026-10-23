import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: 'stash-sim'
  // server: { port: 3001, open: true },
})
