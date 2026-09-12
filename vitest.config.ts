import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    // Only the render smoke test needs a DOM; everything else stays in node.
    environmentMatchGlobs: [['**/render.test.ts', 'jsdom']],
  },
})
