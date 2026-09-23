import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { playerBundle } from './vite/plugins/player-bundle.ts'

export default defineConfig({
  // `playerBundle` serves `virtual:player-bundle`, which `lib/publish/publish.ts`
  // imports. It is only reached lazily, but Vite still resolves the specifier at
  // transform time, so any test whose graph includes the store needs the plugin
  // present. It costs one real player build (~200ms) per run, and buys the
  // guarantee that what the tests mount is what the editor ships.
  plugins: [vue(), playerBundle()],
  test: {
    environment: 'node',
    // Only the render smoke test needs a DOM; everything else stays in node.
    environmentMatchGlobs: [['**/render.test.ts', 'jsdom']],
  },
})
