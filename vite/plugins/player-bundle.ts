import path from 'node:path'
import { build, type Plugin } from 'vite'

/**
 * Serves the published player as a string, built from source on demand.
 *
 * The editor has to embed a working copy of the player in every file it
 * publishes, which means it needs the player's *bundled* JavaScript at runtime.
 * The player is TypeScript importing `run.ts`, so `?raw` cannot read it and the
 * only honest answer is to run a real bundler. Doing that here — rather than as
 * a second `npm run build` step writing a checked-in artifact — is what keeps
 * `npm run dev`, a fresh clone and `npm test` all working with no prerequisite,
 * and leaves no generated file that can go stale against `run.ts` without
 * anyone noticing.
 *
 * It costs about 200 ms on the first request and 10-15 ms warm.
 */

const VIRTUAL_ID = 'virtual:player-bundle'
const RESOLVED_ID = '\0' + VIRTUAL_ID

const PLAYER_ENTRY = 'src/lib/publish/player/index.ts'

/** Source that can end up inside the bundle, for dev invalidation. */
const PLAYER_SOURCES = /[/\\]src[/\\]lib[/\\](publish|harlowe)[/\\]/

export function playerBundle(): Plugin {
  let root = process.cwd()
  /**
   * The build under way, shared by every load that asks while it runs.
   *
   * Two loads at once are normal, not recursion: Vitest serves its jsdom and
   * node environments as separate module graphs, and a dev-server invalidation
   * can land during a slow build. Both get the same answer from one build.
   */
  let inFlight: Promise<string> | null = null

  function bundlePlayer(): Promise<string> {
    inFlight ??= buildPlayer().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  async function buildPlayer(): Promise<string> {
    const result = await build({
      // LOAD-BEARING. Without it the inner build loads `vite.config.ts`,
      // re-applies this plugin, and recurses without bound. It does not
      // error — it hangs. Do not remove.
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        // Nothing reaches disk: this makes Vite call `bundle.generate()`
        // rather than `bundle.write()`.
        write: false,
        // Pinned. The default resolves from a browser-baseline table at build
        // time, so a published file's syntax floor would otherwise drift with
        // dependency updates — for an artifact meant to outlive the build
        // that made it, that is the wrong kind of moving part.
        target: 'es2020',
        // `true` selects rolldown's own minifier. Never 'esbuild' or
        // 'terser': neither is installed.
        minify: true,
        lib: {
          entry: PLAYER_ENTRY,
          name: 'StoryboardPlayer',
          // IIFE, never ES. A published file is opened over `file://`, where
          // a `<script type="module">` is blocked by CORS.
          formats: ['iife'],
        },
      },
    })

    // Lib mode returns one `RolldownOutput` per format, as an array even for
    // a single format. The declared return type also admits a watcher, which
    // only appears under `build.watch` — narrowed rather than asserted so a
    // future config change fails here instead of somewhere stranger.
    const outputs = (Array.isArray(result) ? result : [result]).filter(
      (o): o is Extract<typeof o, { output: unknown }> => 'output' in o,
    )
    const chunks = outputs[0]?.output ?? []
    const entry = chunks[0]
    if (entry === undefined || entry.type !== 'chunk') {
      throw new Error('[player-bundle] build produced no entry chunk')
    }
    if (chunks.length > 1) {
      // The player keeps its styles in a template literal precisely so this
      // stays true. A stylesheet import would arrive as a second output and
      // be dropped here in silence.
      const names = chunks.map((c: { fileName: string }) => c.fileName).join(', ')
      throw new Error(`[player-bundle] expected one output, got ${chunks.length}: ${names}`)
    }
    // Copied out of the chunk immediately: its fields are Rust-backed and
    // lazily read, and Vite closes the bundle before returning.
    return String(entry.code)
  }

  return {
    // Namespaced: rolldown keys some diagnostics on plugin name.
    name: 'storyboard:player-bundle',
    configResolved(config) {
      // The tripwire, not the fix. `configFile: false` is what keeps this plugin
      // out of the nested build; if a regression ever lets it back in, this is
      // the inner build resolving its config with this plugin applied, and it
      // fails loudly here rather than hanging in a build that builds itself.
      const lib = config.build.lib
      if (lib !== false && lib.entry === PLAYER_ENTRY) {
        throw new Error('[player-bundle] applied inside its own build; keep configFile: false')
      }
      root = config.root
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID
      return undefined
    },
    async load(id) {
      if (id !== RESOLVED_ID) return undefined
      const code = await bundlePlayer()
      // For `vite build --watch`; the dev server already watches the root.
      this.addWatchFile(path.resolve(root, PLAYER_ENTRY))
      return `export const playerJs = ${JSON.stringify(code)}\n`
    },
    hotUpdate({ file, modules }) {
      if (!PLAYER_SOURCES.test(file)) return undefined
      // Fires once per environment; only the client graph holds this module.
      const mod = this.environment.moduleGraph.getModuleById(RESOLVED_ID)
      if (!mod) return undefined
      this.environment.moduleGraph.invalidateModule(mod)
      return [...modules, mod]
    },
  }
}
