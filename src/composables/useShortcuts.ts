import { onBeforeUnmount, onMounted } from 'vue'

export interface ShortcutHandlers {
  zoomIn: () => void
  zoomOut: () => void
  zoomToFit: () => void
  resetZoom: () => void
  undo: () => void
  redo: () => void
  addPassage: () => void
  deletePassage: () => void
  focusSearch: () => void
  openHelp: () => void
}

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

    if (e.key === '?') {
      e.preventDefault()
      handlers.openHelp()
      return
    }
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
