import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
// Served publicly under the path prefix strey.dev/dodoco (Traefik strips the
// prefix upstream), so the app's absolute asset/source URLs must be built with
// this base for them to resolve back through the /dodoco route.
export default defineConfig({
  base: '/dodoco/',
  plugins: [tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
})
