import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { Bounds } from '../lib/graph/types'

export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 3
/** Below this, text and edge labels are dropped to keep big stories responsive. */
export const DETAIL_ZOOM = 0.4

const ZOOM_STEP = 1.2

export interface Viewport {
  x: number
  y: number
  k: number
}

function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k))
}

/**
 * Pan and zoom over a shared transform.
 *
 * The SVG edge layer and the HTML node layer both consume this same transform,
 * which is what keeps curves glued to cards at every scale while still letting
 * card text use real CSS ellipsis.
 */
export function useViewport(container: Ref<HTMLElement | null>) {
  const view = reactive<Viewport>({ x: 0, y: 0, k: 1 })
  const size = reactive({ width: 1, height: 1 })
  const panning = ref(false)

  const transform = computed(
    () => `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
  )
  const svgTransform = computed(
    () => `translate(${view.x}, ${view.y}) scale(${view.k})`,
  )
  const detailed = computed(() => view.k >= DETAIL_ZOOM)

  /** Screen point -> story coordinates. */
  function toStory(clientX: number, clientY: number) {
    const rect = container.value?.getBoundingClientRect()
    const px = clientX - (rect?.left ?? 0)
    const py = clientY - (rect?.top ?? 0)
    return { x: (px - view.x) / view.k, y: (py - view.y) / view.k }
  }

  /** Zoom about a fixed screen point, so the spot under the cursor stays put. */
  function zoomAt(factor: number, clientX?: number, clientY?: number) {
    const rect = container.value?.getBoundingClientRect()
    const px = clientX === undefined ? size.width / 2 : clientX - (rect?.left ?? 0)
    const py = clientY === undefined ? size.height / 2 : clientY - (rect?.top ?? 0)

    const next = clampZoom(view.k * factor)
    if (next === view.k) return
    const ratio = next / view.k
    view.x = px - (px - view.x) * ratio
    view.y = py - (py - view.y) * ratio
    view.k = next
  }

  function zoomIn() {
    zoomAt(ZOOM_STEP)
  }

  function zoomOut() {
    zoomAt(1 / ZOOM_STEP)
  }

  function resetZoom() {
    const cx = size.width / 2
    const cy = size.height / 2
    const storyPoint = { x: (cx - view.x) / view.k, y: (cy - view.y) / view.k }
    view.k = 1
    view.x = cx - storyPoint.x
    view.y = cy - storyPoint.y
  }

  function zoomToFit(bounds: Bounds, padding = 40) {
    if (bounds.width <= 0 || bounds.height <= 0) return
    const k = clampZoom(
      Math.min(
        (size.width - padding * 2) / bounds.width,
        (size.height - padding * 2) / bounds.height,
      ),
    )
    view.k = k
    view.x = size.width / 2 - (bounds.minX + bounds.width / 2) * k
    view.y = size.height / 2 - (bounds.minY + bounds.height / 2) * k
  }

  function centerOn(x: number, y: number) {
    view.x = size.width / 2 - x * view.k
    view.y = size.height / 2 - y * view.k
  }

  /* ---------- input ---------- */

  function onWheel(e: WheelEvent) {
    // Both a plain wheel and a trackpad pinch (which arrives as ctrlKey) zoom;
    // shift+wheel pans sideways, matching the usual canvas convention.
    e.preventDefault()
    if (e.shiftKey && !e.ctrlKey) {
      view.x -= e.deltaY
      return
    }
    const intensity = e.ctrlKey ? 0.01 : 0.0022
    zoomAt(Math.exp(-e.deltaY * intensity), e.clientX, e.clientY)
  }

  let pointerId: number | null = null
  let last = { x: 0, y: 0 }

  function onPointerDown(e: PointerEvent) {
    // Drag the background, or middle-drag anywhere.
    const onBackground = (e.target as HTMLElement).dataset?.canvasBackground !== undefined
    if (!onBackground && e.button !== 1) return
    pointerId = e.pointerId
    panning.value = true
    last = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent) {
    if (pointerId !== e.pointerId) return
    view.x += e.clientX - last.x
    view.y += e.clientY - last.y
    last = { x: e.clientX, y: e.clientY }
  }

  function onPointerUp(e: PointerEvent) {
    if (pointerId !== e.pointerId) return
    pointerId = null
    panning.value = false
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  /* ---------- sizing ---------- */

  let observer: ResizeObserver | null = null

  /**
   * Watch the ref rather than measuring once on mount.
   *
   * The canvas lives behind a `v-if` that is false until a story is opened, so
   * at mount time the ref is still null. Measuring only then would leave `size`
   * at its 1x1 placeholder forever, and zoom-to-fit would compute a negative
   * scale and clamp to the minimum — a blank-looking canvas with the story
   * parked off-screen.
   */
  watch(
    container,
    (el) => {
      observer?.disconnect()
      observer = null
      if (!el) return

      const measure = () => {
        // A zero measurement means the element is not laid out yet; keep the
        // last good size rather than poisoning the fit calculation.
        if (el.clientWidth > 0) size.width = el.clientWidth
        if (el.clientHeight > 0) size.height = el.clientHeight
      }
      measure()
      observer = new ResizeObserver(measure)
      observer.observe(el)
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return {
    view,
    size,
    panning,
    transform,
    svgTransform,
    detailed,
    toStory,
    zoomAt,
    zoomIn,
    zoomOut,
    resetZoom,
    zoomToFit,
    centerOn,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
