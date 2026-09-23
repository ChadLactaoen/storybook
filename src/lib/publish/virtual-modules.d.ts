/**
 * The player bundle, served by `vite/plugins/player-bundle.ts`.
 *
 * Declared here rather than in `tsconfig.node.json`'s project because the
 * consumer is app code: `publish.ts` imports it, the plugin merely produces it.
 */
declare module 'virtual:player-bundle' {
  /** The published player, bundled as a self-contained IIFE. */
  export const playerJs: string
}
