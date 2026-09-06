// The icon set, as data. No imports — deliberately.
//
// `shared.ts` (where these used to live) imports `./i18n` and
// `@tauri-apps/api/core` for its DOM helpers. Anything importing `IconName`
// from there therefore pulled DOM globals and the Tauri API into its program,
// including the repo-root `tsc`, which is Worker-typed and has neither. Path
// data has no reason to carry that, so it sits on its own.

/* ── Icons ────────────────────────────────────────────────────────────────────
 * Every mark in this app is one of these. There are no emoji anywhere in the
 * UI: an emoji is a font, and a font is rendered by the host OS — the same
 * character is a flat glyph on one machine, a gradient sticker on another, and
 * a tofu box on a machine missing the range. None of those is a design
 * decision, and setup has to look like itself on every desktop it ships to.
 *
 * Path data is Lucide (MIT), inlined rather than linked: setup must render
 * fully offline, so there is no CDN, no icon font and no network request in
 * this file. Drawn on Lucide's grid — 24×24, 2px stroke, no fill, round caps
 * and joins — which is why they sit together as one set and why they take
 * their colour from whatever they are placed in.
 */
export const ICON_PATHS = {
  /** A step that finished. */
  check: '<path d="M20 6 9 17l-5-5"/>',
  /** A step that failed. An x, not a bang: it says "this one did not happen",
   *  where a bang says "danger", and the failure is neither dangerous nor the
   *  user's doing. */
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  /** A step that has not started. Deliberately a filled dot rather than a
   *  stroked ring: .check-icon is already a ring, and a ring inside a ring
   *  reads as a target. */
  dot: '<circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/>',
  /** Something went wrong and it is worth stopping to read. */
  alert:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>',
  /** Nothing is wrong; here is something useful. */
  lightbulb:
    '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/>' +
    '<path d="M9 18h6"/><path d="M10 22h4"/>',
  /** A password or a token — the thing to write down before moving on. */
  key:
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 ' +
    '1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
    '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor" stroke="none"/>',
  /** A Second Brain that already exists. */
  brain:
    '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>' +
    '<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>' +
    '<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>' +
    '<path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/>' +
    '<path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/>' +
    '<path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  /** The road is blocked, and going around it is the whole answer. */
  construction:
    '<rect x="2" y="6" width="20" height="8" rx="1"/>' +
    '<path d="M17 14v7"/><path d="M7 14v7"/><path d="M17 3v3"/><path d="M7 3v3"/>' +
    '<path d="M10 14 2.3 6.3"/><path d="m14 6 7.7 7.7"/><path d="m8 6 8 8"/>',
  /** A signed, verified update. */
  shieldCheck:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 ' +
    '1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  /** How long this takes. */
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  /** Make one of these for me. */
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 ' +
    '9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 ' +
    '1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>' +
    '<path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M6 18H4"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;
