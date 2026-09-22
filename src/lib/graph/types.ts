import type { NodeId, StoryNode } from '../../types/story'

export type EdgeId = string
/** Key in the layered graph: `n:<nodeId>` for real nodes, `d:<edgeId>:<layer>` for dummies. */
export type LKey = string

export interface DerivedEdge {
  /** `${sourceId}|${ordinal}` — stable across retargeting. */
  id: EdgeId
  sourceId: NodeId
  /** Resolved target; points at a phantom id when the code is unknown. */
  targetId: NodeId
  /** The code this link names, verbatim, whether or not it resolved. */
  targetCode: string
  label: string | null
  /** Position of the link within the source body. */
  ordinal: number
  // No span here, deliberately — anything wanting one parses the live body, as
  // `macros.ts` and `run.ts` both do. Layout is memoized on the story's
  // structure rather than its prose, so this graph is rightly retained across a
  // prose edit; a span is an offset into text that edit has moved. Typing one
  // character ahead of a link shifts every span after it, and a retained one
  // would point into the wrong place while every other field here stayed true.
  /** True when no passage in the document carries the target code. */
  dangling: boolean
  /** sourceId === targetId */
  selfLoop: boolean
}

/**
 * A link target with no passage behind it.
 *
 * It has a code (the unresolved target) but no title — only the display text a
 * link proposed for it, which is null when every link to it is the bare
 * `[[code]]` form.
 */
export interface PhantomNode {
  id: NodeId
  code: string
  label: string | null
}

export type GraphNode = StoryNode | PhantomNode

export interface DerivedGraph {
  /** Real nodes in canonical order. */
  nodes: readonly StoryNode[]
  phantoms: readonly PhantomNode[]
  /** All node ids (real then phantom) in canonical order. Iterate this, never a Map. */
  ids: readonly NodeId[]
  edges: readonly DerivedEdge[]
  edgeById: ReadonlyMap<EdgeId, DerivedEdge>
  byId: ReadonlyMap<NodeId, GraphNode>
  outAdj: ReadonlyMap<NodeId, readonly EdgeId[]>
  inAdj: ReadonlyMap<NodeId, readonly EdgeId[]>
  /** The structural key: a node's code, or a phantom's unresolved target. */
  codeOf: ReadonlyMap<NodeId, string>
  /** Display title. Empty for a phantom that no link proposed a name for. */
  titleOf: ReadonlyMap<NodeId, string>
  // No `stateOf` here, for the reason `DerivedEdge` carries no span: `state` is
  // absent from the layout memo key on purpose, so a map of it built here would
  // go stale the moment anyone ticked a status. The canvas builds its own from
  // the live document, which is the only place it can be read correctly.
}

export interface AcyclicResult {
  backEdges: ReadonlySet<EdgeId>
  /** Node paths of each detected cycle, for diagnostics. */
  cycles: readonly (readonly NodeId[])[]
}

export interface LevelingResult {
  /** 1-based, user-facing. */
  level: ReadonlyMap<NodeId, number>
  /** Structural floor before the user's offset. The UI gates the level control on this. */
  minLevel: ReadonlyMap<NodeId, number>
  maxLevel: number
}

export type LNodeKind = 'real' | 'dummy'

export type PackingMode = 'balanced' | 'aligned'

export interface LNode {
  key: LKey
  kind: LNodeKind
  nodeId: NodeId | null
  edgeId: EdgeId | null
  /** 0-based internal layer index. */
  layer: number
  /** Index within layers[layer]. */
  order: number
  width: number
  height: number
  /** Center coordinates, filled in by xcoord/assignY. */
  x: number
  y: number
  component: number
}

export interface LEdgeSeg {
  edgeId: EdgeId
  from: LKey
  to: LKey
}

export interface LayeredGraph {
  nodes: Map<LKey, LNode>
  /** Canonical key order. Iterate this, never `nodes.keys()`. */
  keys: LKey[]
  /** Merged view: layers[layer] = ordered keys across all components. */
  layers: LKey[][]
  /** compLayers[component][layer] = ordered keys. Ordering and x run on these. */
  compLayers: LKey[][][]
  segs: LEdgeSeg[]
  segsOut: Map<LKey, LKey[]>
  segsIn: Map<LKey, LKey[]>
  /** Edges that were reversed to break cycles. */
  reversed: ReadonlySet<EdgeId>
  /** Ordered dummy chain per edge; empty for span-1 edges. */
  chainOf: Map<EdgeId, LKey[]>
  /** Internal layer index -> displayed level number. */
  levelOfLayer: number[]
  componentCount: number
  /** Edges with no drawable chain: self-loops, and cycle edges within one level. */
  degenerate: Map<EdgeId, EdgeKind>
}

export interface Point {
  x: number
  y: number
}

export type EdgeKind = 'normal' | 'back' | 'flat' | 'self' | 'dangling'

export interface EdgeLayout {
  edgeId: EdgeId
  sourceId: NodeId
  targetId: NodeId
  kind: EdgeKind
  label: string | null
  /** Pre-clip polyline through source anchor, dummies, target anchor. */
  points: Point[]
  /** Final SVG path data, clipped at both ends. */
  d: string
  labelPoint: Point | null
  straight: boolean
}

export interface NodeLayout {
  id: NodeId
  /** The passage's code, or a phantom's unresolved target. Always present. */
  code: string
  /** Display title. Empty for a phantom that no link proposed a name for. */
  title: string
  level: number
  layer: number
  order: number
  /** Center coordinates. */
  x: number
  y: number
  width: number
  height: number
  isPhantom: boolean
  /** Structural floor; UI uses this to gate the level control. */
  minLevel: number
  levelOffset: number
}

export interface LevelBand {
  level: number
  y: number
  height: number
  count: number
}

export type DiagnosticCode =
  | 'cycle'
  | 'dangling-link'
  | 'override-clamped'
  | 'duplicate-code'
  | 'self-loop'
  | 'orphan'

export interface Diagnostic {
  code: DiagnosticCode
  severity: 'info' | 'warn' | 'error'
  message: string
  nodeIds: NodeId[]
  edgeIds: EdgeId[]
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface LayoutResult {
  nodes: NodeLayout[]
  nodeById: Map<NodeId, NodeLayout>
  edges: EdgeLayout[]
  levels: LevelBand[]
  bounds: Bounds
  diagnostics: Diagnostic[]
  stats: { crossings: number; layers: number; dummies: number; hash: string }
  /** Retained so callers can run path counts without re-deriving. */
  graph: DerivedGraph
  backEdges: ReadonlySet<EdgeId>
}

export interface LayoutConfig {
  /**
   * How `tidy.ts` resolves a parent that cannot reach its children's midpoint.
   *
   * `balanced` takes only the slack already in the layer, so a card sitting on
   * its midpoint is never moved off it. `aligned` shoves the run ahead instead,
   * which reaches space the first cannot at the cost of disturbing cards that
   * were already right, and of drawing wider. A story with no merges is drawn
   * identically either way — nothing is ever off its midpoint in a tree, so
   * there is nothing for either strategy to do.
   */
  packing: PackingMode
  nodeWidth: number
  nodeHeight: number
  nodeGap: number
  edgeGap: number
  componentGap: number
  layerSpacing: number
  margin: number
  orderingSweeps: number
  transposeMaxLayerWidth: number
  coordPrecision: number
}
