import type {
  CharacterEntry,
  CharacterRelation,
  SceneCharacter,
  StoryDoc,
  StoryNode,
  TagColorEntry,
} from '../../types/story'
import {
  DOC_VERSION,
  compareByName,
  compareNodes,
  compareStr,
  emptyCharacter,
  isNodeState,
  isTagColor,
  orderRoster,
} from '../../types/story'

/**
 * Canonical serialization.
 *
 * Keys are emitted in a fixed order and every array is sorted, so a given
 * document always produces byte-identical JSON. Combined with layout being a
 * pure function of the document, that is what makes the save file idempotent:
 * the same story renders the same way every time, on any machine.
 */
export function serializeDoc(doc: StoryDoc): string {
  const nodes = [...doc.nodes].sort(compareNodes).map(canonicalNode)
  const tagColors = [...doc.tagColors]
    .sort(compareByName)
    .map((t) => ({ color: t.color, name: t.name }))
  const characters = orderRoster(doc.characters).map(canonicalRosterCharacter)

  return JSON.stringify(
    {
      characters,
      nextId: doc.nextId,
      nodes,
      startNodeId: doc.startNodeId,
      storyTitle: doc.storyTitle,
      tagColors,
      version: DOC_VERSION,
    },
    null,
    2,
  )
}

function canonicalNode(n: StoryNode) {
  return {
    body: n.body,
    characters: [...n.characters].sort(compareByName).map(canonicalSceneCharacter),
    code: n.code,
    id: n.id,
    levelOffset: n.levelOffset,
    setting: n.setting,
    state: n.state,
    tags: [...n.tags].sort(compareStr),
    title: n.title,
  }
}

function canonicalSceneCharacter(c: SceneCharacter) {
  return { name: c.name, note: c.note }
}

/**
 * A roster entry, with its trait lists.
 *
 * Note what is *not* sorted here. Every other array in this file is sorted for
 * byte-stability, but `personality`, `dialogue`, `mannerisms` and each
 * relation's `points` keep the author's ordering — the order is the content.
 * Relations themselves do sort, by target, since their order means nothing.
 * Determinism is unaffected either way: we simply never reorder those lists.
 *
 * The roster's own order is content too, which is why `order` is written out
 * rather than inferred from array position — a hand-edited file may list the
 * entries any way at all and still load back into the author's order.
 */
function canonicalRosterCharacter(c: CharacterEntry) {
  return {
    dialogue: [...c.dialogue],
    mannerisms: [...c.mannerisms],
    name: c.name,
    note: c.note,
    order: c.order,
    personality: [...c.personality],
    relations: [...c.relations]
      .sort((a, b) => compareStr(a.to, b.to))
      .map((r) => ({ points: [...r.points], to: r.to })),
  }
}

export class StoryParseError extends Error {}

interface RawNode {
  id?: unknown
  title?: unknown
  name?: unknown
  body?: unknown
  tags?: unknown
  state?: unknown
  levelOffset?: unknown
  level?: unknown
  setting?: unknown
  code?: unknown
  characters?: unknown
}

/** Read a `{ name, note }[]`, dropping junk, deduplicating and sorting by name. */
function readSceneCharacters(value: unknown): SceneCharacter[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: SceneCharacter[] = []
  for (const entry of value) {
    // A bare string is accepted so a hand-written `["Mira"]` still loads.
    const name = (typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name))
      ?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const note =
      typeof entry === 'string' ? '' : (str((entry as Record<string, unknown>).note) ?? '')
    out.push({ name, note })
  }
  return out.sort(compareByName)
}

/** Trim, drop non-strings and drop blanks — but never reorder. */
function readPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const p of value) {
    if (typeof p !== 'string') continue
    const text = p.trim()
    if (text.length > 0) out.push(text)
  }
  return out
}

function readRelations(value: unknown, self: string): CharacterRelation[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: CharacterRelation[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const to = str(rec.to)?.trim()
    // A self-relation or a repeated target has no meaning; drop rather than repair.
    if (!to || to === self || seen.has(to)) continue
    seen.add(to)
    out.push({ to, points: readPoints(rec.points) })
  }
  return out.sort((a, b) => compareStr(a.to, b.to))
}

/**
 * Read the global roster, with its trait lists.
 *
 * A missing or unusable `order` falls back to the entry's position in the
 * file, which is what a save from before this field — written name-sorted —
 * should come back as.
 */
function readRosterCharacters(value: unknown): CharacterEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: CharacterEntry[] = []
  for (const entry of value) {
    const name = (typeof entry === 'string' ? entry : str((entry as Record<string, unknown>)?.name))
      ?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)

    const character = emptyCharacter(name, out.length)
    if (typeof entry === 'object' && entry !== null) {
      const rec = entry as Record<string, unknown>
      const order = rec.order
      if (typeof order === 'number' && Number.isFinite(order)) character.order = order
      character.note = str(rec.note) ?? ''
      character.personality = readPoints(rec.personality)
      character.dialogue = readPoints(rec.dialogue)
      character.mannerisms = readPoints(rec.mannerisms)
      character.relations = readRelations(rec.relations, name)
    }
    out.push(character)
  }
  return orderRoster(out)
}

export interface ParsedDoc {
  doc: StoryDoc
  /** Nodes carrying a legacy absolute `level`, to be reconciled against layout. */
  legacyLevels: Map<string, number>
  warnings: string[]
}

/**
 * Parse and normalize. Anything malformed is repaired rather than rejected —
 * an author who hand-edits their save file should get their story back, with a
 * note about what changed, not a blank canvas.
 */
export function parseDoc(json: string): ParsedDoc {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new StoryParseError('That file is not valid JSON.')
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new StoryParseError('That file does not contain a story.')
  }

  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.nodes)) {
    throw new StoryParseError('That file does not contain a story (no passages found).')
  }

  const warnings: string[] = []
  const legacyLevels = new Map<string, number>()
  const usedIds = new Set<string>()
  const usedCodes = new Set<string>()
  const nodes: StoryNode[] = []
  /** Nodes whose code was missing or taken; given one once `nextId` is known. */
  const needsCode: StoryNode[] = []
  /** Codes a second passage also claimed, for one aggregate warning. */
  const contested: string[] = []
  let maxNumericId = 0

  for (const entry of obj.nodes as RawNode[]) {
    if (typeof entry !== 'object' || entry === null) continue

    // `name` is accepted for forward compatibility with files that separated
    // an internal name from a display title.
    //
    // Titles are cosmetic, so duplicates are legal and an empty one is left
    // empty — `nodeLabel` falls back to the code, and inventing a name would be
    // a lie about a file the author wrote. `createNode` still supplies a
    // placeholder for passages the app itself makes.
    const title = (str(entry.title) ?? str(entry.name) ?? '').trim()

    let id = str(entry.id) ?? ''
    if (id.length === 0 || usedIds.has(id)) {
      id = `r${usedIds.size + 1}`
      while (usedIds.has(id)) id = `r${id}`
    }
    usedIds.add(id)
    const numeric = Number(id)
    if (Number.isFinite(numeric)) maxNumericId = Math.max(maxNumericId, numeric)

    const tags = Array.isArray(entry.tags)
      ? [...new Set(entry.tags.filter((t): t is string => typeof t === 'string' && t.length > 0))]
      : []

    // A code is the link target, so a passage without a usable one is
    // unreachable. First claim wins; anyone who loses gets a fresh code in the
    // second pass below, once `nextId` is known.
    let code = (str(entry.code) ?? '').trim()
    if (code.length > 0 && usedCodes.has(code)) {
      contested.push(code)
      code = ''
    }
    if (code.length > 0) usedCodes.add(code)

    let levelOffset = 0
    if (typeof entry.levelOffset === 'number' && Number.isFinite(entry.levelOffset)) {
      levelOffset = Math.min(1, Math.max(0, Math.trunc(entry.levelOffset)))
    } else if (typeof entry.level === 'number' && Number.isFinite(entry.level)) {
      legacyLevels.set(id, Math.trunc(entry.level))
    }

    const node: StoryNode = {
      id,
      title,
      body: str(entry.body) ?? '',
      tags: tags.sort(compareStr),
      state: isNodeState(entry.state) ? entry.state : 'TODO',
      levelOffset,
      setting: (str(entry.setting) ?? '').trim(),
      code,
      characters: readSceneCharacters(entry.characters),
    }
    nodes.push(node)
    if (code.length === 0) needsCode.push(node)
  }

  const tagColors: TagColorEntry[] = []
  if (Array.isArray(obj.tagColors)) {
    const seen = new Set<string>()
    for (const t of obj.tagColors) {
      if (typeof t !== 'object' || t === null) continue
      const rec = t as Record<string, unknown>
      const name = str(rec.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      tagColors.push({ name, color: isTagColor(rec.color) ? rec.color : 'none' })
    }
  }

  // Restore the roster invariant: every name a passage casts, and every name a
  // relation points at, must be on the roster. A hand-edited file naming
  // someone absent gets them added with an empty profile rather than having the
  // author's casting — or the points they wrote about them — discarded.
  const characters: CharacterEntry[] = readRosterCharacters(obj.characters)
  const rostered = new Set(characters.map((c) => c.name))
  const adopted: string[] = []

  const adopt = (name: string) => {
    if (rostered.has(name)) return
    rostered.add(name)
    characters.push(emptyCharacter(name, characters.length))
    adopted.push(name)
  }

  for (const node of nodes) for (const c of node.characters) adopt(c.name)
  // Snapshot first: adopting appends, and a freshly adopted entry has no
  // relations of its own to walk.
  for (const c of [...characters]) for (const r of c.relations) adopt(r.to)

  if (adopted.length > 0) {
    adopted.sort(compareStr)
    warnings.push(
      `Added ${adopted.map((n) => `"${n}"`).join(', ')} to the cast — ` +
        'they were referenced but missing from the character list.',
    )
  }

  const ids = new Set(nodes.map((n) => n.id))
  let startNodeId = str(obj.startNodeId)
  if (!startNodeId || !ids.has(startNodeId)) startNodeId = nodes[0]?.id ?? null

  const nextIdRaw = obj.nextId
  let nextId =
    typeof nextIdRaw === 'number' && Number.isFinite(nextIdRaw) && nextIdRaw > maxNumericId
      ? Math.trunc(nextIdRaw)
      : maxNumericId + 1

  // Second pass: hand out the codes that could not be read. It has to run here
  // rather than inline above, because `nextId` is only known once every id has
  // been seen.
  //
  // `P<id>` is tried first because that is exactly what `createNode` would have
  // minted, so a file this app wrote and someone then stripped of codes reloads
  // with the codes it started with. `nextId` is bumped past everything invented:
  // leave it behind and the next passage the author adds would mint a code that
  // already exists, silently giving two passages the same link target.
  const invented: string[] = []
  for (const node of needsCode) {
    let candidate = /^\d+$/.test(node.id) ? `P${node.id}` : ''
    if (candidate.length === 0 || usedCodes.has(candidate)) {
      do {
        candidate = `P${nextId}`
        nextId += 1
      } while (usedCodes.has(candidate))
    }
    usedCodes.add(candidate)
    node.code = candidate
    invented.push(candidate)
  }

  if (contested.length > 0) {
    contested.sort(compareStr)
    warnings.push(
      `${contested.map((c) => `"${c}"`).join(', ')} ${contested.length === 1 ? 'was' : 'were'} ` +
        'used by more than one passage; the first kept the code and the rest were given new ones.',
    )
  }
  if (invented.length > 0) {
    warnings.push(
      `Gave ${invented.length === 1 ? 'a passage' : `${invented.length} passages`} a code ` +
        `(${invented.map((c) => `"${c}"`).join(', ')}) — a passage without one cannot be linked to.`,
    )
  }

  return {
    doc: {
      version: DOC_VERSION,
      storyTitle: str(obj.storyTitle) ?? str(obj.title) ?? 'Untitled Story',
      startNodeId,
      nodes: nodes.sort(compareNodes),
      tagColors: tagColors.sort(compareByName),
      characters: orderRoster(characters),
      nextId,
    },
    legacyLevels,
    warnings,
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
