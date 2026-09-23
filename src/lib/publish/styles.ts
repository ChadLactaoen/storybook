/**
 * How the player looks: shared structure, then one block per theme.
 *
 * Every theme styles the same markup (`player/index.ts` builds one tree for all
 * four), so switching theme is a change of `data-theme` and nothing else. The
 * player sets it on both `.reader` and `<html>`, and `html.ts` writes the
 * author's default onto `<html>` before any script runs, so the page is the
 * right colour from the first paint.
 *
 * Three rules are easy to break from here:
 *
 * - **The trail is never transformed.** Marks are case-sensitive (`SkDt` is not
 *   `skdt`), and Folio uses small caps elsewhere. The shared rules pin
 *   `text-transform` and `font-variant` on `.passage-trail` and
 *   `.trail-box__code` with `!important`, so no theme block can override them.
 * - **An ending's top half looks like any other passage's.** Nothing above the
 *   body may be styled off `isEnding`. "The End" comes after the prose.
 * - **Text size scales through `--body-size`.** The reader's S / M / L sets it
 *   as a multiplier, and every prose-sized `font-size` below multiplies by it,
 *   including the mobile overrides.
 *
 * It is a template literal rather than a `.css` file on purpose. The player is
 * bundled in library mode, where a stylesheet import arrives as a *second*
 * build output — and a plugin reading only the first would drop the styles with
 * no error at all. Keeping the CSS in TypeScript means the bundle has exactly
 * one output and there is nothing to forget.
 */

/** Page reset, and everything the reader spec does not cover. */
const BASE = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  -webkit-text-size-adjust: 100%;
}

/* Buttons stand in for the spec's links, so they are reset to look like
   nothing until a theme styles them. Lowest specificity on purpose: every
   theme rule below outranks it. */
.choice, .inline-link, .reader-settings__option, .restart-button, .trail-box__copy {
  margin: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  text-align: left;
}
.choice { width: 100%; min-height: 44px; }
.trail-box__copy { min-height: 44px; }
.restart-button { min-height: 44px; }
`

/** The reader spec's shared structure, verbatim, plus the button adjustments. */
const SHARED = `
.reader { min-height: 100vh; background: var(--bg); color: var(--ink); font-family: var(--font-body); }
.reader button { font: inherit; color: inherit; cursor: pointer; }
.reader button:disabled { cursor: default; }
.reader button:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
/* Focus moves to the column after each choice only to restart the Tab order.
   It is not a control, so it never draws a ring, even after a key press. */
.reader-main:focus, .reader-main:focus-visible { outline: none; }
.reader a { color: var(--link); }
.reader a:hover { color: var(--link-hover); }

.reader-header { position: relative; display: flex; align-items: center; justify-content: space-between; box-sizing: border-box; }
.reader-header__textsize { border: 0; background: transparent; width: 44px; height: 44px; }

.reader-main { width: 100%; max-width: 680px; margin: 0 auto; padding: 72px 0 80px; display: flex; flex-direction: column; box-sizing: border-box; }

.passage-meta { display: flex; justify-content: flex-start; }   /* only the code group remains */
.passage-meta__group { display: flex; align-items: baseline; gap: 12px; }
.passage-trail { text-transform: none !important; font-variant: normal !important; } /* never transform slugs */

/* Below the choices: the trail so far, and the keys hint. The trail moved here
   from the top row, where a long one wrapped and pushed the title down. */
.passage-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
  margin-top: 16px;
}
.passage-footer__trail {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;          /* let long trails wrap instead of overflowing */
}
.passage-footer__trail .passage-trail { word-break: break-all; }
/* Spacing now comes from the footer. The .reader prefix raises this above each
   theme's own .keys-hint margin, which comes later in the sheet at equal weight. */
.reader .passage-footer .keys-hint { margin-top: 0; flex-shrink: 0; }

.passage-body { display: flex; flex-direction: column; }
.passage-body p, .passage-body blockquote { margin: 0; white-space: pre-wrap; }
.passage-body blockquote { padding-left: 1.2em; border-left: 2px solid var(--rule); color: var(--muted); font-style: italic; }
.passage-body .b { font-weight: 700; }
.passage-body .i { font-style: italic; }
/* Prose reached through a macro this player could not read. Shown rather than
   hidden (run.ts fails open, because a hidden hook deletes writing), and
   marked, so a guess is not mistaken for intent. */
.reader .hazy { opacity: 0.7; text-decoration: underline dotted var(--muted); text-underline-offset: 3px; }

.inline-link { padding: 0; color: var(--link); text-decoration: underline; text-underline-offset: 0.18em; }
.reader .inline-link { color: var(--link); }
.reader .inline-link:hover:not(:disabled) { color: var(--link-hover); }
.reader .inline-link:disabled { color: var(--muted); text-decoration-style: dotted; }

.choices { display: flex; flex-direction: column; }
.choice { display: flex; align-items: center; text-decoration: none; color: var(--link); }
.reader .choice { color: var(--link); }
.reader .choice:hover:not(:disabled) { color: var(--link-hover); }
.choice:hover { background: var(--choice-hover-bg); }
.choice__key { flex-shrink: 0; box-sizing: border-box; }
.choice__text { flex-grow: 1; }
.choice__arrow { flex-shrink: 0; }
.reader .choice:disabled { color: var(--muted); }
.reader .choice:disabled:hover { background: transparent; }
.reader .choice:disabled .choice__text { text-decoration: none; }
.choice__why { flex-shrink: 0; font-size: 13px; font-style: italic; color: var(--muted); }

.dead-end { margin: 48px 0 0; font-style: italic; color: var(--muted); }

.end-marker { display: flex; align-items: center; }
.trail-share { display: flex; flex-direction: column; gap: 12px; }
.trail-box { display: flex; align-items: stretch; }
.trail-box__code { flex-grow: 1; text-transform: none !important; font-variant: normal !important; word-break: break-all; }
.trail-box__copy { flex-shrink: 0; border: 0; display: flex; align-items: center; justify-content: center; gap: 8px; }
.choice-history { display: flex; flex-direction: column; }
.choice-history__list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; }
.choice-history__item { display: flex; align-items: baseline; }
.choice-history__num { flex-shrink: 0; }
.restart-button { display: flex; align-items: center; gap: 10px; }

.reader-fail { max-width: 680px; margin: 0 auto; padding: 72px 24px; font-style: italic; color: var(--muted); }

/* The Aa popover. Theme tokens only, so it belongs to whichever theme is up. */
.reader-settings {
  position: absolute; top: 100%; right: 16px; z-index: 10; margin-top: 8px;
  width: 280px; padding: 16px; display: flex; flex-direction: column; gap: 10px;
  background: var(--surface, var(--bg)); color: var(--ink);
  border: 1px solid var(--rule-strong); box-shadow: 0 12px 32px rgb(0 0 0 / 0.25);
  font-family: var(--font-body); font-size: 14px;
}
.reader-settings[hidden] { display: none; }
.reader-settings__label { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.reader-settings__row { display: flex; gap: 6px; flex-wrap: wrap; }
.reader-settings__row + .reader-settings__label { margin-top: 6px; }
.reader .reader-settings__option {
  flex: 1 1 0; min-width: 44px; min-height: 44px; padding: 0 10px;
  border: 1px solid var(--rule-strong); text-align: center; font-size: 14px; color: var(--ink);
}
.reader-settings__row--themes .reader-settings__option { flex-basis: 40%; }
.reader .reader-settings__option[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }

/* The author console: Play in the editor only, never a published file. */
.author-console {
  max-width: 680px; margin: 0 auto 48px; border: 1px dashed var(--rule-strong);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted);
}
/* Left as a list item: a summary set to flex loses its disclosure triangle. */
.author-console__summary { padding: 12px 14px; cursor: pointer; }
.author-console__rows {
  display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; padding: 0 14px 12px;
}
.author-console__v { color: var(--ink); word-break: break-word; }
.author-console__v--empty { color: var(--muted); font-style: italic; }
/* What the author must not miss: a session started mid-story, or input asked
   for and never given. Play only, and in the flow rather than the console. */
.author-note {
  margin: 0 0 24px; padding: 10px 14px; border-left: 3px solid var(--accent);
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted);
}
.passage-body + .author-note { margin: 24px 0 0; }

@media (max-width: 640px) {
  .reader-main { padding: 28px 24px 40px; }
  .passage-meta__group--code .meta-label { display: none; }   /* mobile shows only the code */
  .choice__key, .keys-hint { display: none; }                  /* no keyboard affordances */
  .author-console { margin: 0 24px 40px; }
  /* keys hint is already hidden on mobile, so the trail is the last line of the page */
  .passage-footer { margin-top: 20px; }
}
`

const MARQUEE = `
[data-theme="marquee"] {
  --font-display: 'Bebas Neue', Impact, sans-serif; --font-body: 'Gothic A1', system-ui, sans-serif;
  --bg:#222222; --ink:#EDEDED; --muted:#A6A6A6; --rule:#3A3A3A; --rule-strong:#5C5C5C;
  --accent:#70CAFB; --on-accent:#222222; --link:#F8BE14; --link-hover:#FFD55C; --choice-hover-bg:#2C2C2C;
}
[data-theme="marquee"] .reader-header { height: 64px; padding: 0 40px; border-bottom: 1px solid var(--rule); }
[data-theme="marquee"] .reader-header__title { font-family: var(--font-display); font-size: 28px; letter-spacing: .04em; }
[data-theme="marquee"] .reader-header__textsize { font-size: 18px; color: var(--muted); }

[data-theme="marquee"] .passage-meta { align-items: flex-end; padding-bottom: 16px; border-bottom: 1px solid var(--rule); }
[data-theme="marquee"] .meta-label,
[data-theme="marquee"] .choices__label,
[data-theme="marquee"] .section-label { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
[data-theme="marquee"] .passage-code { font-family: var(--font-display); font-size: 44px; line-height: .8; letter-spacing: .02em; color: var(--accent); }
[data-theme="marquee"] .passage-trail { font-size: 16px; font-weight: 700; letter-spacing: .08em; }

[data-theme="marquee"] .passage-title { margin: 36px 0 28px; font-family: var(--font-display); font-weight: 400; font-size: 76px; line-height: .95; letter-spacing: .02em; }
[data-theme="marquee"] .passage-body { font-size: calc(18px * var(--body-size, 1)); line-height: 1.8; gap: 20px; }

[data-theme="marquee"] .choices { margin-top: 48px; }
[data-theme="marquee"] .choices__label { padding-bottom: 14px; }
[data-theme="marquee"] .choice { gap: 20px; padding: 20px 8px; border-top: 1px solid var(--rule); }
[data-theme="marquee"] .choice:last-child { border-bottom: 1px solid var(--rule); }
[data-theme="marquee"] .choice__key { width: 30px; height: 30px; border: 1px solid var(--rule-strong); color: var(--muted); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; }
[data-theme="marquee"] .choice__text { font-size: calc(18px * var(--body-size, 1)); line-height: 1.5; font-weight: 500; }
[data-theme="marquee"] .choice:hover .choice__text { text-decoration: underline; text-underline-offset: 4px; }
[data-theme="marquee"] .choice__arrow { stroke-width: 2; }
[data-theme="marquee"] .keys-hint { margin-top: 16px; text-align: right; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }

[data-theme="marquee"] .end-marker { margin-top: 56px; gap: 24px; }
[data-theme="marquee"] .end-marker__rule { flex-grow: 1; height: 1px; background: var(--rule); }
[data-theme="marquee"] .end-marker__text { font-family: var(--font-display); font-size: 56px; line-height: 1; letter-spacing: .08em; color: var(--accent); }

[data-theme="marquee"] .trail-share { margin-top: 48px; }
[data-theme="marquee"] .trail-box { border: 1px solid var(--rule); }
[data-theme="marquee"] .trail-box__code { padding: 18px 20px; font-size: 26px; font-weight: 700; letter-spacing: .1em; color: var(--accent); }
[data-theme="marquee"] .trail-box__copy { min-width: 120px; border-left: 1px solid var(--rule); background: transparent; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
[data-theme="marquee"] .trail-share__hint { font-size: 13px; color: var(--muted); }

[data-theme="marquee"] .choice-history { margin-top: 44px; }
[data-theme="marquee"] .choice-history .section-label { padding-bottom: 8px; }
[data-theme="marquee"] .choice-history__item { gap: 20px; padding: 14px 0; border-top: 1px solid var(--rule); font-size: calc(17px * var(--body-size, 1)); line-height: 1.5; }
[data-theme="marquee"] .choice-history__item:last-child { border-bottom: 1px solid var(--rule); }
[data-theme="marquee"] .choice-history__num { width: 28px; font-family: var(--font-display); font-size: 24px; color: var(--muted); }

[data-theme="marquee"] .restart-wrap { margin-top: 40px; }
[data-theme="marquee"] .restart-button { min-height: 52px; padding: 0 28px; border: 0; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }

@media (max-width: 640px) {
  [data-theme="marquee"] .reader-header { height: 56px; padding: 0 8px 0 24px; }
  [data-theme="marquee"] .reader-header__title { font-size: 24px; }
  [data-theme="marquee"] .passage-meta { padding-bottom: 12px; }
  [data-theme="marquee"] .passage-code { font-size: 40px; }
  [data-theme="marquee"] .meta-label { font-size: 11px; }
  [data-theme="marquee"] .passage-trail { font-size: 15px; }
  [data-theme="marquee"] .passage-title { margin: 28px 0 20px; font-size: 52px; }
  [data-theme="marquee"] .passage-body { font-size: calc(17px * var(--body-size, 1)); line-height: 1.75; gap: 16px; }
  [data-theme="marquee"] .choices { margin-top: 40px; }
  [data-theme="marquee"] .choices__label { font-size: 11px; padding-bottom: 12px; }
  [data-theme="marquee"] .choice { gap: 16px; padding: 18px 0; }
  [data-theme="marquee"] .choice__text { font-size: calc(17px * var(--body-size, 1)); }
}
`

const FOLIO = `
[data-theme="folio"] {
  --font-display: 'EB Garamond', Georgia, serif; --font-body: 'EB Garamond', Georgia, serif;
  --bg:#F4EEDF; --ink:#2A241C; --muted:#6B604F; --rule:#D8CCB4; --rule-strong:#B3A588;
  --accent:#7A2E1F; --link:#7A2E1F; --link-hover:#A0402C; --choice-hover-bg:transparent;
}
[data-theme="folio"] .reader-header { height: 72px; padding: 0 40px; border-bottom: 3px double #CDBFA4; }
[data-theme="folio"] .reader-header__title { font-size: 18px; font-variant: small-caps; text-transform: lowercase; letter-spacing: .16em; }
[data-theme="folio"] .reader-header__textsize { font-size: 20px; font-style: italic; color: var(--muted); }

[data-theme="folio"] .passage-meta { align-items: baseline; padding-bottom: 14px; border-bottom: 1px solid var(--rule); }
[data-theme="folio"] .meta-label { font-size: 15px; font-style: italic; color: var(--muted); }
[data-theme="folio"] .passage-code { font-size: 20px; font-weight: 500; letter-spacing: .04em; color: var(--accent); }
[data-theme="folio"] .passage-trail { font-size: 17px; letter-spacing: .06em; }

[data-theme="folio"] .passage-title { margin: 52px 0 36px; font-weight: 400; font-style: italic; font-size: 54px; line-height: 1.1; text-align: center; }
[data-theme="folio"] .passage-body { font-size: calc(21px * var(--body-size, 1)); line-height: 1.65; text-align: justify; hyphens: auto; gap: 0; }
[data-theme="folio"] .passage-body p + p { text-indent: 1.6em; }
[data-theme="folio"] .passage-body p:first-child::first-letter { float: left; font-size: 4.2em; line-height: .78; padding: 8px 10px 0 0; font-weight: 500; color: var(--accent); }

[data-theme="folio"] .choices__label,
[data-theme="folio"] .section-label { font-size: 16px; font-variant: small-caps; text-transform: lowercase; letter-spacing: .18em; color: var(--muted); text-align: center; }
[data-theme="folio"] .choices { margin-top: 52px; }
[data-theme="folio"] .choices__label { padding-bottom: 16px; }
[data-theme="folio"] .choice { align-items: baseline; gap: 16px; padding: 10px 8px; }
[data-theme="folio"] .choice__key { width: 24px; font-style: italic; font-size: 18px; color: var(--muted); text-align: right; }
[data-theme="folio"] .choice__text { font-size: calc(21px * var(--body-size, 1)); line-height: 1.5; font-style: italic; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 5px; }
[data-theme="folio"] .choice:hover .choice__text { text-decoration-thickness: 2px; }
[data-theme="folio"] .choice__arrow { stroke-width: 1.25; color: var(--rule-strong); align-self: center; }
[data-theme="folio"] .keys-hint { margin-top: 20px; text-align: center; font-size: 15px; font-style: italic; color: var(--muted); }
/* Everything below the choices is centered */
[data-theme="folio"] .passage-footer { flex-direction: column; align-items: center; gap: 8px; margin-top: 20px; }

[data-theme="folio"] .end-marker { margin-top: 56px; justify-content: center; gap: 20px; }
[data-theme="folio"] .end-marker__rule { width: 72px; height: 1px; background: var(--rule-strong); }
[data-theme="folio"] .end-marker__text { font-size: 28px; font-style: italic; letter-spacing: .04em; color: var(--accent); }

[data-theme="folio"] .trail-share { margin-top: 52px; }
[data-theme="folio"] .trail-box { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
/* left padding equals the Copy button's width so the code sits visually centered */
[data-theme="folio"] .trail-box__code { padding: 16px 4px 16px 110px; font-size: 28px; letter-spacing: .08em; color: var(--accent); text-align: center; }
[data-theme="folio"] .trail-box__copy { min-width: 110px; background: transparent; font-size: 17px; font-style: italic; color: var(--link); }
[data-theme="folio"] .trail-share__hint { font-size: 15px; font-style: italic; color: var(--muted); text-align: center; }

[data-theme="folio"] .choice-history { margin-top: 44px; }
[data-theme="folio"] .choice-history .section-label { padding-bottom: 10px; }
[data-theme="folio"] .choice-history__item { gap: 18px; padding: 8px 0; font-size: calc(19px * var(--body-size, 1)); line-height: 1.5; }
[data-theme="folio"] .choice-history__num { width: 28px; font-size: 17px; font-style: italic; color: var(--muted); text-align: right; }

[data-theme="folio"] .restart-wrap { margin-top: 44px; display: flex; justify-content: center; }
[data-theme="folio"] .restart-button { min-height: 52px; padding: 0 28px; border: 1px solid var(--ink); background: transparent; color: var(--ink); font-size: 18px; font-variant: small-caps; text-transform: lowercase; letter-spacing: .14em; }

@media (max-width: 640px) {
  [data-theme="folio"] .reader-header { height: 56px; padding: 0 8px 0 24px; }
  [data-theme="folio"] .reader-header__title { font-size: 16px; letter-spacing: .14em; }
  [data-theme="folio"] .passage-meta { padding-bottom: 12px; }
  [data-theme="folio"] .passage-code { font-size: 18px; }
  [data-theme="folio"] .passage-trail { font-size: 16px; }
  [data-theme="folio"] .passage-title { margin: 36px 0 24px; font-size: 40px; }
  [data-theme="folio"] .passage-body { font-size: calc(19px * var(--body-size, 1)); line-height: 1.6; }
  [data-theme="folio"] .choices { margin-top: 40px; }
  [data-theme="folio"] .choice { align-items: center; gap: 14px; padding: 12px 0; }
  [data-theme="folio"] .choice__text { font-size: calc(19px * var(--body-size, 1)); line-height: 1.45; }
  /* The centring offset assumes the desktop Copy width; on a phone it only
     squeezes the code. */
  [data-theme="folio"] .trail-box__code { padding-left: 16px; text-align: left; }
}
`

const PHOSPHOR = `
[data-theme="phosphor"] {
  --font-display: VT323, monospace; --font-body: 'IBM Plex Mono', ui-monospace, monospace;
  --bg:#0A0E0B; --ink:#C5F2CF; --muted:#6FAE7F; --rule:#1F3526; --rule-strong:#1F3526;
  --accent:#6CFF8F; --link:#FFC24B; --link-hover:#FFD98A; --choice-hover-bg:#111A13;
}
[data-theme="phosphor"] .passage-code,
[data-theme="phosphor"] .passage-title,
[data-theme="phosphor"] .end-marker__text,
[data-theme="phosphor"] .trail-box__code { text-shadow: 0 0 10px rgba(108,255,143,.45); }

[data-theme="phosphor"] .reader-header { height: 56px; padding: 0 40px; border-bottom: 1px dashed var(--rule); }
[data-theme="phosphor"] .reader-header__title { font-family: var(--font-display); font-size: 28px; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); }
[data-theme="phosphor"] .reader-header__textsize { border: 1px solid var(--rule); font-size: 14px; color: var(--muted); }

[data-theme="phosphor"] .passage-meta { align-items: baseline; padding: 12px 16px; border: 1px dashed var(--rule); }
[data-theme="phosphor"] .meta-label,
[data-theme="phosphor"] .choices__label,
[data-theme="phosphor"] .section-label,
[data-theme="phosphor"] .keys-hint { font-size: 12px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
[data-theme="phosphor"] .passage-code { font-family: var(--font-display); font-size: 32px; line-height: .8; color: var(--accent); }
[data-theme="phosphor"] .passage-trail { font-size: 15px; font-weight: 600; letter-spacing: .06em; }

[data-theme="phosphor"] .passage-title { margin: 44px 0 24px; font-family: var(--font-display); font-weight: 400; font-size: 64px; line-height: 1; text-transform: uppercase; color: var(--accent); }
[data-theme="phosphor"] .passage-title::before { content: '> '; }
[data-theme="phosphor"] .passage-body { font-size: calc(16px * var(--body-size, 1)); line-height: 1.85; gap: 22px; }

[data-theme="phosphor"] .choices { margin-top: 44px; }
[data-theme="phosphor"] .choices__label { padding-bottom: 10px; }
[data-theme="phosphor"] .choices__label::after { content: '_'; margin-left: 2px; animation: phosphor-blink 1.1s steps(1) infinite; }
@keyframes phosphor-blink { 50% { opacity: 0; } }
[data-theme="phosphor"] .choice { gap: 16px; padding: 12px 10px; }
[data-theme="phosphor"] .choice__key { font-size: 15px; font-weight: 600; color: var(--muted); }
[data-theme="phosphor"] .choice__key:not(:empty)::before { content: '['; }
[data-theme="phosphor"] .choice__key:not(:empty)::after { content: ']'; }
[data-theme="phosphor"] .choice__text { font-size: calc(16px * var(--body-size, 1)); line-height: 1.6; }
[data-theme="phosphor"] .choice:hover .choice__text { text-decoration: underline; text-underline-offset: 4px; }
[data-theme="phosphor"] .choice__arrow { stroke-width: 2; }
[data-theme="phosphor"] .keys-hint { margin-top: 16px; }
/* Match the dashed-rule terminal look */
[data-theme="phosphor"] .passage-footer { padding-top: 14px; border-top: 1px dashed var(--rule); }

[data-theme="phosphor"] .end-marker { margin-top: 56px; gap: 16px; }
[data-theme="phosphor"] .end-marker__rule { flex-grow: 1; height: 0; border-top: 1px dashed var(--rule); }
[data-theme="phosphor"] .end-marker__text { font-family: var(--font-display); font-size: 48px; line-height: 1; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }

[data-theme="phosphor"] .trail-share { margin-top: 48px; }
[data-theme="phosphor"] .trail-box { border: 1px dashed var(--rule); }
[data-theme="phosphor"] .trail-box__code { padding: 16px 18px; font-size: 22px; font-weight: 600; letter-spacing: .1em; color: var(--accent); }
[data-theme="phosphor"] .trail-box__copy { min-width: 110px; border-left: 1px dashed var(--rule); background: transparent; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--link); }
[data-theme="phosphor"] .trail-share__hint { font-size: 12px; color: var(--muted); }

[data-theme="phosphor"] .choice-history { margin-top: 44px; }
[data-theme="phosphor"] .choice-history .section-label { padding-bottom: 8px; }
[data-theme="phosphor"] .choice-history__item { gap: 16px; padding: 8px 0; font-size: calc(15px * var(--body-size, 1)); line-height: 1.6; }
[data-theme="phosphor"] .choice-history__num { width: 28px; font-size: 15px; color: var(--muted); }

[data-theme="phosphor"] .restart-wrap { margin-top: 40px; }
[data-theme="phosphor"] .restart-button { min-height: 52px; padding: 0 24px; border: 1px solid var(--accent); background: transparent; color: var(--accent); font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: .1em; }

@media (prefers-reduced-motion: reduce) { [data-theme="phosphor"] .choices__label::after { animation: none; } }

@media (max-width: 640px) {
  [data-theme="phosphor"] .reader-header { padding: 0 8px 0 24px; }
  [data-theme="phosphor"] .reader-header__title { font-size: 24px; }
  [data-theme="phosphor"] .passage-meta { padding: 10px 12px; }
  [data-theme="phosphor"] .passage-code { font-size: 28px; }
  [data-theme="phosphor"] .passage-trail { font-size: 14px; }
  [data-theme="phosphor"] .passage-title { margin: 32px 0 20px; font-size: 46px; }
  [data-theme="phosphor"] .passage-body { font-size: calc(15px * var(--body-size, 1)); line-height: 1.8; gap: 18px; }
  [data-theme="phosphor"] .choices { margin-top: 36px; }
  [data-theme="phosphor"] .choice { gap: 14px; padding: 14px 0; border-top: 1px dashed var(--rule); }
  [data-theme="phosphor"] .choice:last-child { border-bottom: 1px dashed var(--rule); }
  [data-theme="phosphor"] .choice__text { font-size: calc(15px * var(--body-size, 1)); }
  /* The last choice already has a bottom border, so drop the duplicate */
  [data-theme="phosphor"] .passage-footer { padding-top: 0; border-top: 0; }
}
`

const DAYLIGHT = `
[data-theme="daylight"] {
  --font-display: 'Atkinson Hyperlegible', system-ui, sans-serif; --font-body: 'Atkinson Hyperlegible', system-ui, sans-serif;
  --bg:#FAFAF7; --surface:#FFFFFF; --ink:#141414; --muted:#4D4D4D; --rule:#DADAD3; --rule-strong:#141414;
  --accent:#C2410C; --on-accent:#FFFFFF; --link:#0B57D0; --link-hover:#083F99; --choice-hover-bg:#F1F5FD;
}
[data-theme="daylight"] .reader-header { height: 68px; padding: 0 40px; background: var(--surface); border-bottom: 2px solid var(--ink); }
[data-theme="daylight"] .reader-header__title { font-size: 20px; font-weight: 700; }
[data-theme="daylight"] .reader-header__textsize { min-width: 48px; height: 48px; border: 2px solid var(--ink); border-radius: 10px; background: var(--surface); font-size: 18px; font-weight: 700; }

[data-theme="daylight"] .passage-meta { align-items: center; padding: 12px 16px; background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; }
[data-theme="daylight"] .meta-label { font-size: 14px; font-weight: 700; color: var(--muted); }
[data-theme="daylight"] .passage-code { font-size: 22px; font-weight: 700; color: var(--accent); }
[data-theme="daylight"] .passage-trail { font-size: 18px; font-weight: 700; letter-spacing: .06em; }

[data-theme="daylight"] .passage-title { margin: 40px 0 24px; font-weight: 700; font-size: 48px; line-height: 1.15; }
[data-theme="daylight"] .passage-body { font-size: calc(21px * var(--body-size, 1)); line-height: 1.7; gap: 24px; }

[data-theme="daylight"] .choices { margin-top: 48px; gap: 12px; }
[data-theme="daylight"] .choices__label,
[data-theme="daylight"] .section-label { font-size: 17px; font-weight: 700; }
[data-theme="daylight"] .choice { gap: 16px; padding: 18px 20px; background: var(--surface); border: 2px solid var(--rule); border-radius: 12px; }
[data-theme="daylight"] .choice:hover { border-color: var(--link); background: var(--choice-hover-bg); }
[data-theme="daylight"] .choice:focus-visible { outline: 3px solid var(--link); outline-offset: 3px; }
[data-theme="daylight"] .choice__key { width: 36px; height: 36px; border-radius: 8px; background: var(--ink); color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 700; }
[data-theme="daylight"] .choice__text { font-size: calc(20px * var(--body-size, 1)); line-height: 1.45; font-weight: 700; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 5px; }
[data-theme="daylight"] .choice:hover .choice__text { text-decoration-thickness: 3px; }
[data-theme="daylight"] .choice__arrow { stroke-width: 2.5; }
[data-theme="daylight"] .keys-hint { margin-top: 12px; font-size: 15px; color: var(--muted); }

[data-theme="daylight"] .end-marker { margin-top: 48px; justify-content: center; gap: 16px; padding: 20px; background: var(--surface); border: 2px solid var(--accent); border-radius: 12px; }
[data-theme="daylight"] .end-marker__rule { width: 32px; height: 2px; background: var(--accent); }
[data-theme="daylight"] .end-marker__text { font-size: 28px; font-weight: 700; color: var(--accent); }

[data-theme="daylight"] .trail-share { margin-top: 44px; }
[data-theme="daylight"] .trail-box { background: var(--surface); border: 2px solid var(--ink); border-radius: 12px; overflow: hidden; }
[data-theme="daylight"] .trail-box__code { padding: 18px 20px; font-size: 28px; font-weight: 700; letter-spacing: .08em; }
[data-theme="daylight"] .trail-box__copy { min-width: 120px; background: var(--ink); color: #FFFFFF; font-size: 17px; font-weight: 700; }
[data-theme="daylight"] .trail-share__hint { font-size: 16px; color: var(--muted); }

[data-theme="daylight"] .choice-history { margin-top: 44px; }
[data-theme="daylight"] .choice-history .section-label { padding-bottom: 12px; }
[data-theme="daylight"] .choice-history__item { gap: 16px; padding: 14px 0; border-top: 1px solid var(--rule); font-size: calc(19px * var(--body-size, 1)); line-height: 1.5; }
[data-theme="daylight"] .choice-history__item:last-child { border-bottom: 1px solid var(--rule); }
[data-theme="daylight"] .choice-history__num { width: 32px; font-size: 19px; font-weight: 700; color: var(--muted); }

[data-theme="daylight"] .restart-wrap { margin-top: 40px; }
[data-theme="daylight"] .restart-button { min-height: 56px; padding: 0 28px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); font-size: 18px; font-weight: 700; }

@media (max-width: 640px) {
  [data-theme="daylight"] .reader-header { height: 60px; padding: 0 8px 0 20px; }
  [data-theme="daylight"] .reader-header__title { font-size: 18px; }
  [data-theme="daylight"] .passage-meta { padding: 10px 14px; }
  [data-theme="daylight"] .passage-code { font-size: 20px; }
  [data-theme="daylight"] .passage-trail { font-size: 17px; }
  [data-theme="daylight"] .passage-title { margin: 28px 0 20px; font-size: 36px; }
  [data-theme="daylight"] .passage-body { font-size: calc(19px * var(--body-size, 1)); line-height: 1.65; gap: 20px; }
  [data-theme="daylight"] .choices { margin-top: 36px; gap: 10px; }
  [data-theme="daylight"] .choice { gap: 12px; padding: 16px; }
  [data-theme="daylight"] .choice__text { font-size: calc(18px * var(--body-size, 1)); }
}
`

export const PLAYER_CSS = `${BASE}${SHARED}${MARQUEE}${FOLIO}${PHOSPHOR}${DAYLIGHT}`
