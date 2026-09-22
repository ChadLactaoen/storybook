import { realKey } from './layered'
import type {
  DerivedGraph,
  EdgeKind,
  EdgeLayout,
  LayeredGraph,
  LayoutConfig,
  Point,
} from './types'

const ARROW_GAP = 9
const STRAIGHT_EPS = 0.5
const CLIP_ITERATIONS = 12

interface Cubic {
  p0: Point
  c1: Point
  c2: Point
  p3: Point
}

function round(v: number, precision: number): number {
  const f = 10 ** precision
  return Math.round(v * f) / f
}

/**
 * Build the drawable path for every edge.
 *
 * Segments are cubic Beziers with vertical handles of length dy/2. Because
 * layers are equally spaced, both the tangents *and* the handle lengths match
 * on either side of a dummy, so the joints come out C1-smooth with no extra
 * math, and the curve stays monotone in y — it never doubles back, which
 * matters a lot for reading story flow.
 */
export function routeEdges(
  lg: LayeredGraph,
  g: DerivedGraph,
  cfg: LayoutConfig,
): EdgeLayout[] {
  const out: EdgeLayout[] = []

  for (const e of g.edges) {
    const degenerate = lg.degenerate.get(e.id)
    const source = lg.nodes.get(realKey(e.sourceId))
    const target = lg.nodes.get(realKey(e.targetId))
    if (!source || !target) continue

    const kind: EdgeKind = degenerate
      ? degenerate
      : lg.reversed.has(e.id)
        ? 'back'
        : e.dangling
          ? 'dangling'
          : 'normal'

    if (degenerate === 'self') {
      out.push(selfLoopPath(e.id, e.sourceId, e.label, source.x, source.y, cfg))
      continue
    }
    if (degenerate === 'flat') {
      out.push(flatArcPath(e.id, e.sourceId, e.targetId, e.label, source, target, cfg))
      continue
    }

    // The chain was built in the direction the edge was laid out; the drawn
    // path always runs source -> target so the arrowhead lands where the author
    // wrote the link, even for a reversed cycle edge.
    const chain = lg.chainOf.get(e.id) ?? []
    const mid = (lg.reversed.has(e.id) ? [...chain].reverse() : chain).map((k) => {
      const n = lg.nodes.get(k)!
      return { x: n.x, y: n.y }
    })

    const points: Point[] = [
      { x: source.x, y: source.y },
      ...mid,
      { x: target.x, y: target.y },
    ]

    const straight = points.every((p) => Math.abs(p.x - points[0]!.x) < STRAIGHT_EPS)
    const cubics = toCubics(points)

    const sourceRect = rectOf(source.x, source.y, cfg)
    const targetRect = rectOf(target.x, target.y, cfg)
    const clipped = clipEnds(cubics, sourceRect, targetRect)

    out.push({
      edgeId: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      kind,
      label: e.label,
      points,
      d: straight ? straightPath(clipped, cfg) : cubicsToPath(clipped, cfg),
      labelPoint: labelPointOf(points, cfg),
      straight,
    })
  }

  out.sort((a, b) => (a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0))
  return out
}

function rectOf(cx: number, cy: number, cfg: LayoutConfig) {
  return {
    left: cx - cfg.nodeWidth / 2 - ARROW_GAP,
    right: cx + cfg.nodeWidth / 2 + ARROW_GAP,
    top: cy - cfg.nodeHeight / 2 - ARROW_GAP,
    bottom: cy + cfg.nodeHeight / 2 + ARROW_GAP,
  }
}

type Rect = ReturnType<typeof rectOf>

function inside(p: Point, r: Rect): boolean {
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
}

function toCubics(points: readonly Point[]): Cubic[] {
  const out: Cubic[] = []
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i]!
    const p3 = points[i + 1]!
    const dy = p3.y - p0.y
    out.push({
      p0,
      c1: { x: p0.x, y: p0.y + dy / 2 },
      c2: { x: p3.x, y: p3.y - dy / 2 },
      p3,
    })
  }
  return out
}

function cubicAt(c: Cubic, t: number): Point {
  const mt = 1 - t
  const a = mt * mt * mt
  const b = 3 * mt * mt * t
  const d = 3 * mt * t * t
  const e = t * t * t
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p3.y,
  }
}

/** de Casteljau split, keeping either [0,t] or [t,1]. */
function splitCubic(c: Cubic, t: number, keep: 'first' | 'second'): Cubic {
  const lerp = (a: Point, b: Point): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  })
  const p01 = lerp(c.p0, c.c1)
  const p12 = lerp(c.c1, c.c2)
  const p23 = lerp(c.c2, c.p3)
  const p012 = lerp(p01, p12)
  const p123 = lerp(p12, p23)
  const mid = lerp(p012, p123)
  return keep === 'first'
    ? { p0: c.p0, c1: p01, c2: p012, p3: mid }
    : { p0: mid, c1: p123, c2: p23, p3: c.p3 }
}

/**
 * Trim the first and last segments back to the card boundary.
 *
 * A fixed-iteration bisection on the curve parameter, rather than clipping at
 * `y = top`: that shortcut is simply wrong whenever an edge approaches a card
 * from a steep angle, which happens constantly in a wide fan.
 */
function clipEnds(cubics: Cubic[], sourceRect: Rect, targetRect: Rect): Cubic[] {
  const out = [...cubics]
  if (out.length === 0) return out

  const first = out[0]!
  if (inside(first.p0, sourceRect)) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < CLIP_ITERATIONS; i++) {
      const m = (lo + hi) / 2
      if (inside(cubicAt(first, m), sourceRect)) lo = m
      else hi = m
    }
    out[0] = splitCubic(first, lo, 'second')
  }

  const last = out[out.length - 1]!
  if (inside(last.p3, targetRect)) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < CLIP_ITERATIONS; i++) {
      const m = (lo + hi) / 2
      if (inside(cubicAt(last, m), targetRect)) hi = m
      else lo = m
    }
    out[out.length - 1] = splitCubic(last, hi, 'first')
  }

  return out
}

function fmt(p: Point, cfg: LayoutConfig): string {
  return `${round(p.x, cfg.coordPrecision)} ${round(p.y, cfg.coordPrecision)}`
}

function cubicsToPath(cubics: readonly Cubic[], cfg: LayoutConfig): string {
  if (cubics.length === 0) return ''
  let d = `M ${fmt(cubics[0]!.p0, cfg)}`
  for (const c of cubics) {
    d += ` C ${fmt(c.c1, cfg)} ${fmt(c.c2, cfg)} ${fmt(c.p3, cfg)}`
  }
  return d
}

/** A vertical run reads far better as a line than as a near-straight curve. */
function straightPath(cubics: readonly Cubic[], cfg: LayoutConfig): string {
  if (cubics.length === 0) return ''
  const start = cubics[0]!.p0
  const end = cubics[cubics.length - 1]!.p3
  return `M ${fmt(start, cfg)} L ${fmt(end, cfg)}`
}

function labelPointOf(points: readonly Point[], cfg: LayoutConfig): Point | null {
  if (points.length < 2) return null
  const i = Math.floor((points.length - 1) / 2)
  const a = points[i]!
  const b = points[i + 1]!
  return {
    x: round((a.x + b.x) / 2, cfg.coordPrecision),
    y: round((a.y + b.y) / 2, cfg.coordPrecision),
  }
}

function selfLoopPath(
  edgeId: string,
  nodeId: string,
  label: string | null,
  cx: number,
  cy: number,
  cfg: LayoutConfig,
): EdgeLayout {
  const right = cx + cfg.nodeWidth / 2
  const top = cy - cfg.nodeHeight / 4
  const bottom = cy + cfg.nodeHeight / 4
  // Sized from the gap it has to fit inside, not as a constant: the arc swings
  // out past the card's own anchor box, and a compact drawing leaves far less
  // room beside a card than the default does. `56 - 9 - 3` is exactly the 44
  // this replaces, so the default drawing is unchanged to the pixel, while a
  // narrower gap shrinks the loop instead of drawing it under the next card.
  const bulge = Math.max(8, Math.min(44, cfg.nodeGap - ARROW_GAP - 3))
  const d =
    `M ${round(right, cfg.coordPrecision)} ${round(top, cfg.coordPrecision)}` +
    ` C ${round(right + bulge, cfg.coordPrecision)} ${round(top - bulge / 2, cfg.coordPrecision)}` +
    ` ${round(right + bulge, cfg.coordPrecision)} ${round(bottom + bulge / 2, cfg.coordPrecision)}` +
    ` ${round(right + ARROW_GAP, cfg.coordPrecision)} ${round(bottom, cfg.coordPrecision)}`
  return {
    edgeId,
    sourceId: nodeId,
    targetId: nodeId,
    kind: 'self',
    label,
    points: [],
    d,
    labelPoint: { x: round(right + bulge, cfg.coordPrecision), y: round(cy, cfg.coordPrecision) },
    straight: false,
  }
}

/** A cycle edge whose endpoints landed on the same level: arc above the band. */
function flatArcPath(
  edgeId: string,
  sourceId: string,
  targetId: string,
  label: string | null,
  a: { x: number; y: number },
  b: { x: number; y: number },
  cfg: LayoutConfig,
): EdgeLayout {
  const lift = cfg.nodeHeight / 2 + 40
  const y = a.y - cfg.nodeHeight / 2
  const d =
    `M ${round(a.x, cfg.coordPrecision)} ${round(y, cfg.coordPrecision)}` +
    ` C ${round(a.x, cfg.coordPrecision)} ${round(y - lift, cfg.coordPrecision)}` +
    ` ${round(b.x, cfg.coordPrecision)} ${round(y - lift, cfg.coordPrecision)}` +
    ` ${round(b.x, cfg.coordPrecision)} ${round(y - ARROW_GAP, cfg.coordPrecision)}`
  return {
    edgeId,
    sourceId,
    targetId,
    kind: 'flat',
    label,
    points: [],
    d,
    labelPoint: {
      x: round((a.x + b.x) / 2, cfg.coordPrecision),
      y: round(y - lift * 0.75, cfg.coordPrecision),
    },
    straight: false,
  }
}
