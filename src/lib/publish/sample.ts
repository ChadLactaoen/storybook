/**
 * The story a theme preview plays: four passages, two routes, one ending.
 *
 * It is small, but it has to reach every part of the reader a theme styles. So
 * the first passage offers two choices, the second asks the reader's name with
 * a `(prompt:)` — the one dialog a theme styles — then puts a link inside a
 * sentence and uses bold and italic, each passage carries a mark so the trail grows as you
 * read, and both routes reach an ending. That ending is where "The End", the
 * trail box, "Your choices" and Restart appear. The name is printed only in the
 * passage that asks for it, since the other route never sets it.
 *
 * Built by hand rather than with `createNode`, so that a preview never depends on
 * a mutation's defaults, and never mints codes that would change with them.
 */

import type { StoryDoc, StoryNode } from '../../types/story'
import { emptyDoc } from '../../types/story'

function passage(
  id: string,
  title: string,
  slug: string,
  body: string,
  isEnding = false,
): StoryNode {
  return {
    id,
    title,
    code: `P${id}`,
    slug,
    note: '',
    body,
    tags: [],
    state: 'Done',
    isEnding,
    levelOffset: 0,
    setting: '',
    characters: [],
  }
}

const NODES: StoryNode[] = [
  passage(
    '1',
    'A Knock in the Storm',
    'Kn',
    [
      'Rain hammers the shutters of the lighthouse, and the lamp above you turns its slow circle through the dark.',
      '',
      'Then, under the wind, you hear it: three knocks at the cottage door. //Nobody// walks the causeway on a night like this.',
      '',
      '[[Answer the knock at the cottage door.|P2]]',
      '[[Stay by the fire and wait.|P3]]',
    ].join('\n'),
  ),
  passage(
    '2',
    'The Stranger',
    'Dr',
    [
      'A woman in an oilskin coat stands on the step, lantern in hand. Her boots are dry.',
      '',
      '(set: $name to (prompt: "“Who keeps this light?” she asks.", "Keeper"))"The lamp is failing, $name," she says. "You have until the tide turns." Before you can ask how she knows, she turns and walks toward the tower, and you could [[follow her up the stair|P4]] or let the door swing shut.',
      '',
      "''Something about her lantern is wrong.'' Its flame does not move in the wind.",
      '',
      '[[Close the door and return to the fire.|P3]]',
    ].join('\n'),
  ),
  passage(
    '3',
    'By the Fire',
    'Fi',
    [
      'You let the knocking fade. The fire spits; the kettle ticks as it cools.',
      '',
      'Above you the lamp stutters once, twice, and the beam stops turning.',
      '',
      '[[Climb the tower to the lamp.|P4]]',
    ].join('\n'),
  ),
  passage(
    '4',
    'The Lamp Room',
    'Lp',
    [
      'At the top of the stair the great lens stands dark. Out on the water, a ship’s lights are closer than they should be.',
      '',
      'You strike a match, and the old wick catches. The beam swings out across the swell, and the ship’s lights turn away from the rocks.',
    ].join('\n'),
    true,
  ),
]

/** Only ever read: `buildPayload` writes nothing onto the document it is given. */
export const SAMPLE_DOC: StoryDoc = {
  ...emptyDoc('The Lighthouse Keeper'),
  startNodeId: '1',
  nodes: NODES,
  nextId: NODES.length + 1,
}
