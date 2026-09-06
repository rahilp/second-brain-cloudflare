/**
 * The value panel — the testimonial setup opens each screen with.
 *
 * Most setup screens ask for one thing and then wait: a password typed, an
 * account chosen, a brain unlocked. The rail on the left says how much is
 * left; the column asks the question. This is the argument for answering it,
 * and it is one real person's published words plus the three facts a first-run
 * user is actually weighing (how long, how much, whose account).
 *
 * It used to be a 340px card in the corner of the right gutter, below the
 * fold, faded out whenever Ridge had anything to say. That put the one thing
 * on screen written to convince somebody in the quietest place the window
 * has. It is now the editorial opening: a full-width pull quote above the
 * task, at the size the words deserve, with the three facts as a foot strip
 * under the whole composition.
 *
 * Three rules shape the data below:
 *
 * 1. One quote per screen, fixed. The mapping is a table rather than a
 *    rotation or a shuffle so that a re-render — a locale change, a rail
 *    refresh, a failed check redrawing the same screen — puts the same words
 *    back. A quote that changed its mind while the user was reading it would
 *    pull the eye off the field they were filling in, and it is now big
 *    enough that the movement would be impossible to ignore.
 * 2. `null` means the screen is busy or finished. Provisioning, its failure
 *    screen and the connection details are the three places that are either
 *    carrying real status or holding the payoff, and marketing copy alongside
 *    either one reads as a shrug. The three launch modes (`rotation`,
 *    `workerUpdate`, `stalePassword`) are not onboarding at all: nobody
 *    changing a password needs to be sold the app they already installed.
 * 3. Quotes are other people's words, so they are stored verbatim in one
 *    place and are never translated. Only the furniture around them — the
 *    kicker, the source labels, the stat line — goes through `t()`.
 *
 * Like `steps.ts`, this module is plain data and pure lookups with no DOM in
 * it, so `test/unit/valuePanel.test.ts` can check the mapping without a
 * webview. `main.ts` renders it.
 */
import type { IconName } from "./icons";
import type { ScreenName } from "./steps";

/** Where a quote was published. Both are proper nouns in either locale. */
export type SourceId = "productHunt" | "reddit";

export type QuoteId =
  | "aron"
  | "rupert"
  | "vahid"
  | "birgul"
  | "mustafa"
  | "nicolo"
  | "needleworker"
  | "gludius";

export interface Quote {
  id: QuoteId;
  /**
   * The words as published, English in both locales. Four of the eight are
   * shortened to the sentences that carry the point; none is reworded, and
   * nothing is added.
   */
  text: string;
  author: string;
  source: SourceId;
}

/** The i18n key each source label lives under. */
export const SOURCE_LABEL_KEYS: Record<SourceId, `value.${string}`> = {
  productHunt: "value.sourceProductHunt",
  reddit: "value.sourceReddit",
};

/**
 * The eight testimonials published on thesecondbrain.dev, verbatim.
 *
 * Not a marketing pool to be added to freely: every one of these is a real
 * person's public post, so the text belongs to them. Edit only to trim, and
 * only where the trimmed version still says what they said.
 */
export const QUOTES: Record<QuoteId, Quote> = {
  aron: {
    id: "aron",
    text:
      "Finally something that solves the most frustrating part of using AI. " +
      "The recall by meaning actually works.",
    author: "Aron Woolman",
    source: "productHunt",
  },
  rupert: {
    id: "rupert",
    text:
      "Boring-in-a-good-way infrastructure. Explicit control is the saner version.",
    author: "rupert_at_work",
    source: "reddit",
  },
  vahid: {
    id: "vahid",
    text:
      "The interesting part isn't just 'memory,' it's whether the system can " +
      "tell what is still true vs what was only temporary context.",
    author: "Vahid Davoudi",
    source: "productHunt",
  },
  birgul: {
    id: "birgul",
    text:
      "The semantic recall saved me from re-explaining a project setup I had " +
      "already detailed the day before.",
    author: "Birgül",
    source: "productHunt",
  },
  mustafa: {
    id: "mustafa",
    text: "The resolution logic IS the product — everything else is storage.",
    author: "Mustafa Arian",
    source: "productHunt",
  },
  nicolo: {
    id: "nicolo",
    text:
      "A clever setup, especially running entirely on the free tier. " +
      "Memory is the new moat for agents.",
    author: "nicoloboschi",
    source: "reddit",
  },
  needleworker: {
    id: "needleworker",
    text:
      "The 85–95 flagged tier is the clever bit. Most setups hard-dedupe at " +
      "one threshold and lose the partial overlaps that actually carry new context.",
    author: "NeedleworkerSmart486",
    source: "reddit",
  },
  gludius: {
    id: "gludius",
    text:
      "Love the included iOS shortcuts + bookmarklet. I've built so many of " +
      "those for personal use; this brings it to another level.",
    author: "GludiusMaximus",
    source: "reddit",
  },
};

/**
 * Screen to quote. `null` draws no panel at all.
 *
 * Screens that belong to the same question share a quote on purpose: a scan
 * running and the picker it produces are one moment to the user, and swapping
 * the testimonial between them would draw the eye to the gutter at exactly
 * the point where the answer they asked for has just arrived in the column.
 *
 * Where there was a choice, the quote is the one that fits the screen: the
 * free-tier post next to the Cloudflare sign-in it is about, "explicit
 * control" next to the password the user is choosing, the cross-tool recall
 * next to the question of who the brain is for.
 */
export const SCREEN_QUOTES: Record<ScreenName, QuoteId | null> = {
  // Creating a new brain.
  welcome: "aron",
  audience: "birgul",
  password: "rupert",
  cloudflare: "nicolo",
  cloudflareWaiting: "nicolo",
  accountPickerProvision: "nicolo",
  progress: null,
  progressFailed: null,
  existingBrainGuard: "vahid",
  resourceConflictGuard: "rupert",
  // Connecting to a brain that already exists.
  connectExisting: "vahid",
  searching: "needleworker",
  accountPickerDiscover: "needleworker",
  brainPicker: "needleworker",
  unlockBrain: "mustafa",
  manualEntry: "gludius",
  memberTokenHelp: "gludius",
  existingTeam: "birgul",
  // Shared close.
  tools: "aron",
  details: null,
  // Not onboarding.
  workerUpdate: null,
  rotation: null,
  stalePassword: null,
};

/**
 * The stat line under the composition, in the order it reads.
 *
 * Three keys rather than one sentence: the separator between them is drawn by
 * CSS, so a locale can translate each fact without also having to reproduce
 * the punctuation between them.
 */
export const STAT_KEYS: readonly `value.${string}`[] = [
  "value.statSetup",
  "value.statCost",
  "value.statData",
];

/**
 * One Lucide mark per fact, so the strip reads as three answers rather than as
 * a sentence that has lost its commas. Each mark restates its own fact and
 * nothing else: a clock for how long, a tick for the price, a shield for whose
 * account it lands in.
 */
export const STAT_ICONS: Record<(typeof STAT_KEYS)[number], IconName> = {
  "value.statSetup": "clock",
  "value.statCost": "check",
  "value.statData": "shieldCheck",
};

/**
 * Where a quote stops being one confident line and starts being a paragraph.
 *
 * The band's type scales with the window, but three of the eight testimonials
 * are long enough that the largest step would cost a fourth line at 940px and
 * push the task down with it. They drop one step instead. The threshold is on
 * the text rather than on the screen so that a quote moved to another screen
 * takes its own sizing with it.
 */
export const LONG_QUOTE_CHARS = 115;

/** Whether a quote renders at the smaller of the band's two type steps. */
export function isLongQuote(quote: Quote): boolean {
  return quote.text.length > LONG_QUOTE_CHARS;
}

/** The quote a screen shows, or `null` when it shows no panel. */
export function quoteFor(screen: ScreenName): Quote | null {
  const id = SCREEN_QUOTES[screen];
  return id ? QUOTES[id] : null;
}
