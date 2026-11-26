import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// BASE_PATH is set by the Pages workflow from actions/configure-pages, so the same build works for
// a project page (/<repo>/), an org page (/) or a custom domain (/). Locally it defaults to "/".
const base = process.env.BASE_PATH ? process.env.BASE_PATH.replace(/\/?$/, '/') : '/'

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
  build: {
    chunkSizeWarningLimit: 1600, // only mermaid's lazy elk layout chunk is near this, and it loads on demand
  },
})
