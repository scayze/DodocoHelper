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
      // The app's apiUrl() builds endpoints under the base prefix, so dev
      // calls land on /dodoco/api/* — rewrite them to /api/* for the API.
      "/dodoco/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/dodoco/, ""),
      },
      "/api": "http://localhost:3001",
    },
  },
})
