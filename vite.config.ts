import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { playerBundle } from './vite/plugins/player-bundle.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), playerBundle()],
})
