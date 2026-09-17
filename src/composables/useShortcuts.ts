import { onBeforeUnmount, onMounted } from 'vue'

export interface ShortcutHandlers {
  zoomIn: () => void
  zoomOut: () => void
  zoomToFit: () => void
  resetZoom: () => void
  undo: () => void
  redo: () => void
  addPassage: () => void
  /** Deletes the whole selection, not just the anchor. */
  deletePassage: () => void
  focusSearch: () => void
  toggleBodyEditor: () => void
  toggleCheatSheet: () => void
  toggleNotes: () => void
  openHelp: () => void
  openStats: () => void
  /** True while the stats sheet itself is what is up. */
  statsOpen: () => boolean
  openTags: () => void
  /** True while the tag sheet itself is what is up. */
  tagsOpen: () => boolean
  togglePlay: () => void
  /** True while the reader itself is what is up. */
  playOpen: () => boolean
  /**
   * True while any dialog that owns Escape is up — `modalOpen` plus the
   * expanded body editor, which is not a modal for the purposes below because
   * it has a textarea `isTyping` already catches.
   */
  dialogOpen: () => boolean
  /** True while a full-screen modal is up; the unmodified keys stand down. */
  modalOpen: () => boolean
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/**
 * Global keyboard shortcuts.
 *
 * Cmd +/-/0 are claimed from the browser's own page zoom with preventDefault,
 * which is the behaviour a canvas app wants: zooming the story, not the chrome
 * around it.
 */
export function useShortcuts(handlers: ShortcutHandlers) {
  function onKeyDown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey
    const typing = isTyping(e.target)
    // macOS gives Ctrl E and Ctrl K to the text field itself — end of line, and
    // kill to end of line. The Cmd variants are ours; the Ctrl ones are not.
    const nativeEditing = typing && IS_MAC && !e.metaKey

    if (mod) {
      switch (e.key) {
        case '=':
        case '+':
          e.preventDefault()
          handlers.zoomIn()
          return
        case '-':
        case '_':
          e.preventDefault()
          handlers.zoomOut()
          return
        case '0':
          e.preventDefault()
          handlers.zoomToFit()
          return
        case '1':
          e.preventDefault()
          handlers.resetZoom()
          return
        case 'f':
          if (handlers.modalOpen()) return
          e.preventDefault()
          handlers.focusSearch()
          return
        // Deliberately not behind the plain typing guard: both panels are
        // reached with the cursor already in a text field, and the expanded
        // editor focuses its own textarea, so a key that stood down while
        // typing could open it but never close it again.
        // ...but they do stand down under a full-screen modal, which is a
        // different question from typing. `modalOpen`, not `dialogOpen`: the
        // expanded editor is not a modal here, or Cmd E could not close it.
        // Without this, Cmd E mounts the body editor *under* an open veil,
        // focuses its invisible textarea, and every keystroke after that edits
        // the passage — through a session that is supposed to be read-only.
        case 'e':
          if (nativeEditing || handlers.modalOpen()) return
          e.preventDefault()
          handlers.toggleBodyEditor()
          return
        case 'k':
          if (nativeEditing || handlers.modalOpen()) return
          e.preventDefault()
          handlers.toggleCheatSheet()
          return
        // Same reasoning, and it bites hardest here: the notes panel is a
        // textarea that focuses itself on open, so a key that stood down while
        // typing could open it and then never close it again.
        case 'j':
          if (nativeEditing || handlers.modalOpen()) return
          e.preventDefault()
          handlers.toggleNotes()
          return
        // Not a letter: the editor owns Mod B / I / Shift . / Shift K for
        // markup, and a global binding on one of those would fire alongside it.
        // `/` also puts stats next to `?` for help, which is where it belongs.
        //
        // Same carve-out as the panels above: the sheet is reachable
        // mid-sentence and closes with the key that opened it, so standing down
        // while typing would open it with no way back.
        case '/':
          if (nativeEditing) return
          // The one key in this branch that opens a modal of its own, so it is
          // also the one that has to respect a modal already up. Stacking the
          // sheet over the expanded editor left both listening for Escape, and
          // one press closed the editor the author was writing in along with
          // it. Stats itself is exempt, or the key that opens it could not
          // close it again.
          if (handlers.dialogOpen() && !handlers.statsOpen()) return
          e.preventDefault()
          handlers.openStats()
          return
        // Tags, next to stats because it answers the neighbouring question.
        // `g` rather than `t`: Chrome keeps Cmd T for a new tab and will not
        // yield it, so the binding would simply not arrive. Same self-exempt
        // guard as `/` — the sheet has to close with the key that opened it,
        // and must not stack over the expanded editor, which listens for the
        // same Escape.
        case 'g':
          if (nativeEditing) return
          if (handlers.dialogOpen() && !handlers.tagsOpen()) return
          e.preventDefault()
          handlers.openTags()
          return
        // Takes browser Print, deliberately. This app already claims Cmd
        // +/-/0 from page zoom on the grounds that a canvas app wants its own
        // zoom; a story-graph editor wants its own Play more than it wants
        // Print. An unmodified `p` would be worse — it would stand down while
        // typing, and the author is nearly always in the body textarea, so it
        // would simply appear broken.
        case 'p':
          if (nativeEditing) return
          // Same rule as `/` above, and for the same reason: a key that opens a
          // modal has to respect one already up, or the reader stacks over the
          // expanded editor and one Escape closes them both. The reader is
          // exempt from its own guard, or the key could not close it again.
          if (handlers.dialogOpen() && !handlers.playOpen()) return
          e.preventDefault()
          handlers.togglePlay()
          return
        case 'z':
          if (typing) return
          e.preventDefault()
          if (e.shiftKey) handlers.redo()
          else handlers.undo()
          return
        case 'y':
          if (typing) return
          e.preventDefault()
          handlers.redo()
          return
        default:
          return
      }
    }

    if (typing) return
    // A modal owns the keyboard while it is up, and handles Escape itself. Only
    // the bare keys below stand down — Cmd Z and the zoom keys still belong to
    // the canvas underneath.
    if (handlers.modalOpen()) return

    if (e.key === '?') {
      e.preventDefault()
      handlers.openHelp()
      return
    }
    // Selection-wide: one passage or a Cmd/Shift-built set, the same key.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      handlers.deletePassage()
      return
    }
    // Deliberately not Tab: hijacking it globally would break keyboard
    // traversal of the toolbar and inspector.
    if (e.key === 'n') {
      e.preventDefault()
      handlers.addPassage()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))
}
