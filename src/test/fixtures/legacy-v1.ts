/**
 * A save file exported verbatim from the build that shipped before `isEnding`.
 *
 * Not hand-written, and not to be regenerated: its whole value is that it is
 * exactly what an author's in-progress story looks like on disk and in
 * localStorage today. `String.raw` so the `\n` escapes inside the bodies stay
 * escapes rather than becoming real newlines.
 */
export const LEGACY_V1 = String.raw`{
  "characters": [],
  "nextId": 6,
  "nodes": [
    {
      "body": "[[Go to North|P2]]\n[[Go to South|P3]]",
      "characters": [],
      "code": "P1",
      "id": "1",
      "levelOffset": 0,
      "setting": "",
      "state": "Done",
      "tags": [
        "act1"
      ],
      "title": "Opening",
      "token": ""
    },
    {
      "body": "[[Go to Summit|P4]]",
      "characters": [],
      "code": "P2",
      "id": "2",
      "levelOffset": 0,
      "setting": "",
      "state": "Draft",
      "tags": [],
      "title": "North",
      "token": ""
    },
    {
      "body": "[[Go to Summit|P4]]\n[[Go to Cave|P5]]",
      "characters": [],
      "code": "P3",
      "id": "3",
      "levelOffset": 0,
      "setting": "",
      "state": "TODO",
      "tags": [],
      "title": "South",
      "token": ""
    },
    {
      "body": "",
      "characters": [],
      "code": "P4",
      "id": "4",
      "levelOffset": 0,
      "setting": "",
      "state": "TODO",
      "tags": [],
      "title": "Summit",
      "token": "both roads meet"
    },
    {
      "body": "",
      "characters": [],
      "code": "P5",
      "id": "5",
      "levelOffset": 0,
      "setting": "A cold summit",
      "state": "TODO",
      "tags": [],
      "title": "Cave",
      "token": ""
    }
  ],
  "notes": "Draft two. Remember to cut the prologue.",
  "startNodeId": "1",
  "storyTitle": "Test Story",
  "tagColors": [
    {
      "color": "blue",
      "name": "act1"
    }
  ],
  "version": 1
}`
