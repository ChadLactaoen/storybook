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
          e.preventDefault()
          handlers.focusSearch()
          return
        // Deliberately not behind the plain typing guard: both panels are
        // reached with the cursor already in a text field, and the expanded
        // editor focuses its own textarea, so a key that stood down while
        // typing could open it but never close it again.
        case 'e':
          if (nativeEditing) return
          e.preventDefault()
          handlers.toggleBodyEditor()
          return
        case 'k':
          if (nativeEditing) return
          e.preventDefault()
          handlers.toggleCheatSheet()
          return
        // Same reasoning, and it bites hardest here: the notes panel is a
        // textarea that focuses itself on open, so a key that stood down while
        // typing could open it and then never close it again.
        case 'j':
          if (nativeEditing) return
          e.preventDefault()
          handlers.toggleNotes()
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
