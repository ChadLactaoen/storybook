/**
 * Assembling the single file a reader actually opens.
 *
 * Two things go in — the player bundle and the payload — and each is made
 * incapable of breaking out of its container rather than trusted not to. The
 * payload is base64, so it cannot contain a `<` at all. The bundle is checked
 * for `<script` and `</script` and *refused* if it carries either, rather than
 * escaped: it is our own code, so one of those in it means something went wrong
 * upstream, and quietly rewriting the bytes would hide that.
 *
 * Refusing the opening tag too is what makes `<!--` harmless. The bundle does
 * contain one, in a string. Inside a script, `<!--` followed later by `<script`
 * switches the HTML tokenizer into a state where the next `</script>` no longer
 * ends the element, so the page's own closing tag would be swallowed. With no
 * `<script` anywhere in the bundle, that state cannot be entered.
 *
 * The bundle arrives as a **parameter**, never an import, so this module can be
 * tested against a stub bundle without running the real player build. Only
 * `publish.ts` touches the virtual module.
 */

import { slug } from '../doc/file'
import { PLAYER_CSS } from './styles'
import { FONTS_URL } from './themes'
import type { Payload } from './payload'
import { encodeText, toBase64 } from './crypto'

/** Matches the id the player looks for. Both sides are wrong if only one moves. */
export const PAYLOAD_ID = 'story-payload'

export class AssemblyError extends Error {}

/** Escape for HTML text and quoted attributes. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The complete published document.
 *
 * The player runs from a classic `<script>`, not `type="module"`. A module
 * script is subject to CORS even from `file://`, and opening the file by
 * double-clicking it is the entire delivery model — so the bundle is built as
 * an IIFE and invoked directly.
 */
export function assemble(bundle: string, payload: Payload): string {
  if (/<\/?script/i.test(bundle)) {
    throw new AssemblyError(
      'The player bundle contains a script tag sequence and cannot be embedded safely.',
    )
  }
  const encoded = toBase64(encodeText(JSON.stringify(payload)))

  // The theme is written onto `<html>` here as well as set by the player, so
  // the page is already the right colour before the bundle has run. Without
  // it a dark theme flashes white while the first passage decrypts.
  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(payload.theme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(payload.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${escapeHtml(FONTS_URL)}">
<style>
${PLAYER_CSS}
</style>
</head>
<body>
<div id="story"><noscript>This story needs JavaScript to read.</noscript></div>
<script type="application/json" id="${PAYLOAD_ID}">${encoded}</script>
<script>
${bundle}
</script>
<script>
StoryboardPlayer.start(document.getElementById('story'));
</script>
</body>
</html>
`
}

/** `My Story` → `my-story.html`, named the way `exportDoc` names the JSON. */
export function publishFilename(storyTitle: string): string {
  return `${slug(storyTitle)}.html`
}
