/**
 * The value panel's screen-to-quote table (`installer/src/valuePanel.ts`).
 *
 * Same arrangement as `test/unit/steps.test.ts`: the render lives in `main.ts`
 * and cannot be imported outside a webview, so the part that is a decision
 * rather than a render — which screen shows which testimonial, and which
 * screens show none — is a module of plain data with its own tests.
 *
 * The failures worth guarding here are the ones a screenshot would not show.
 * A quote that changed between two renders of the same screen looks fine in
 * any single frame and is only wrong in motion. A screen missing from the
 * table would be a panel that silently stopped appearing halfway through
 * setup. And a panel on the progress screen would be marketing copy next to a
 * progress bar, which no reviewer would catch unless provisioning happened to
 * be running while they looked.
 */
import { describe, it, expect } from "vitest";
import {
  QUOTES,
  SCREEN_QUOTES,
  SOURCE_LABEL_KEYS,
  STAT_KEYS,
  quoteFor,
  type QuoteId,
} from "../../installer/src/valuePanel";
import { SCREEN_STEPS, type ScreenName } from "../../installer/src/steps";
import { en } from "../../installer/src/i18n/en";
import { it as itCatalog } from "../../installer/src/i18n/it";

/** Every screen `main.ts` can render, from the rail's own list. */
const ALL_SCREENS = Object.keys(SCREEN_STEPS) as ScreenName[];

/** The screens that must never draw a panel, and why, in one place. */
const SILENT: ScreenName[] = [
  // Real status on screen, or the payoff.
  "progress",
  "progressFailed",
  "details",
  // Launch modes, not onboarding.
  "workerUpdate",
  "rotation",
  "stalePassword",
];

describe("the screen-to-quote table", () => {
  it("covers every screen the rail knows about", () => {
    // Both tables are keyed by the same `ScreenName`, so a screen added to
    // `steps.ts` and forgotten here would not compile — this guards the other
    // direction, a stale entry for a screen that no longer exists.
    expect(Object.keys(SCREEN_QUOTES).sort()).toEqual(ALL_SCREENS.sort());
  });

  it("is silent where the gutter is carrying something else", () => {
    for (const screen of SILENT) {
      expect(quoteFor(screen), screen).toBeNull();
    }
  });

  it("speaks on every other screen, including the pickers and the guards", () => {
    for (const screen of ALL_SCREENS) {
      if (SILENT.includes(screen)) continue;
      expect(quoteFor(screen), screen).not.toBeNull();
    }
  });

  it("gives the same screen the same quote every time", () => {
    // The whole reason this is a table and not a rotation: a locale change or
    // a rail refresh re-renders the screen, and a panel that swapped its words
    // underneath a user mid-sentence would pull their eye off the field.
    for (const screen of ALL_SCREENS) {
      expect(quoteFor(screen), screen).toBe(quoteFor(screen));
    }
  });

  it("names the eight highest-need screens with eight different quotes", () => {
    const featured: ScreenName[] = [
      "welcome",
      "audience",
      "password",
      "cloudflare",
      "connectExisting",
      "brainPicker",
      "unlockBrain",
      "manualEntry",
    ];
    const ids = featured.map((s) => quoteFor(s)?.id);
    expect(new Set(ids).size).toBe(featured.length);
  });

  it("puts the Cloudflare free-tier quote on the Cloudflare screens", () => {
    // The one mapping that is about content rather than spread: this post is
    // from r/Cloudflare and is about the free tier, and it sits next to the
    // sign-in that asks for a Cloudflare account.
    const onCloudflare = ["cloudflare", "cloudflareWaiting", "accountPickerProvision"] as const;
    for (const screen of onCloudflare) {
      expect(quoteFor(screen)?.id, screen).toBe("nicolo");
    }
  });

  it("keeps a scan and the picker it produces on one quote", () => {
    // `searching` resolves into `brainPicker` without the user doing anything.
    // A different quote on each would move the gutter at the exact moment the
    // answer arrives in the column.
    expect(quoteFor("searching")?.id).toBe(quoteFor("brainPicker")?.id);
    expect(quoteFor("accountPickerDiscover")?.id).toBe(quoteFor("brainPicker")?.id);
  });
});

describe("the quotes themselves", () => {
  it("agrees with its own keys", () => {
    for (const [id, quote] of Object.entries(QUOTES)) {
      expect(quote.id, id).toBe(id as QuoteId);
    }
  });

  it("attributes every one of them", () => {
    for (const quote of Object.values(QUOTES)) {
      expect(quote.author.length, quote.id).toBeGreaterThan(0);
      expect(quote.text.length, quote.id).toBeGreaterThan(0);
      expect(SOURCE_LABEL_KEYS[quote.source], quote.id).toBeDefined();
    }
  });

  it("stays short enough to read at a glance", () => {
    // The panel is at most 340px wide and lives in the corner of the eye. A
    // testimonial long enough to need reading is a testimonial that competes
    // with the question the screen is asking.
    for (const quote of Object.values(QUOTES)) {
      expect(quote.text.length, quote.id).toBeLessThanOrEqual(160);
    }
  });
});

describe("the furniture", () => {
  const catalogs = { en, it: itCatalog };

  it("has both locales for every key the panel renders", () => {
    const keys = [
      "value.heading",
      "value.label",
      ...Object.values(SOURCE_LABEL_KEYS),
      ...STAT_KEYS,
    ];
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const key of keys) {
        const leaf = key.split(".")[1] as keyof typeof catalog.value;
        expect(catalog.value[leaf], `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it("translates the stat line but never the quotes", () => {
    // The three facts are ours and are translated; the testimonials are other
    // people's published words and stay in the language they were written in.
    expect(itCatalog.value.statSetup).not.toBe(en.value.statSetup);
    expect(itCatalog.value.sourceProductHunt).toBe(en.value.sourceProductHunt);
  });

  it("reads the three facts in the order the panel draws them", () => {
    expect(STAT_KEYS).toEqual(["value.statSetup", "value.statCost", "value.statData"]);
  });
});
