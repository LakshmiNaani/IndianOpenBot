import { defineConfig } from 'vite'

export default defineConfig({
  root: 'client',
  envDir: '..',
  server: {
    port: 8081,
    host: true
  },
  preview: {
    port: 8081,
    host: true
  },
  build: {
    outDir: '../build',
    emptyOutDir: true
  }
})
