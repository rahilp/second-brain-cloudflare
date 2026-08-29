/**
 * The desktop app's two message catalogs, checked against each other.
 *
 * This check did not exist. `installer/src/i18n/{en,it}.ts` are constrained by
 * the `Messages` interface, but CI never compiles the installer's TypeScript —
 * the workflow runs `npm run bundle-worker` and `cargo check` there and nothing
 * else — so a key added to `en.ts` and forgotten in `it.ts` shipped a compile
 * error nobody ran, and a key present in both but left in English shipped a
 * silent regression. Importing both catalogs here is what makes the Italian
 * half of any copy change real rather than assumed, and it works for the same
 * reason `test/unit/rotation-screens.test.ts` works: these files import nothing
 * but each other's types.
 */
import { describe, it, expect } from "vitest";
import { en } from "../../installer/src/i18n/en";
import { it as itCatalog } from "../../installer/src/i18n/it";

type Catalog = Record<string, unknown>;

/** Every leaf, as a dotted path. Nested objects recurse; arrays are leaves. */
function flatten(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    out.set(prefix, node);
    return out;
  }
  for (const [key, value] of Object.entries(node as Catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const enFlat = flatten(en);
const itFlat = flatten(itCatalog);

describe("the installer's message catalogs", () => {
  it("carries the same key in both languages", () => {
    // Vacuity guard: a flatten that silently returned nothing would make the
    // equality below pass forever.
    expect(enFlat.size).toBeGreaterThan(400);
    expect([...enFlat.keys()].sort()).toEqual([...itFlat.keys()].sort());
  });

  it("has no leaf that is not a string", () => {
    for (const [path, value] of enFlat) expect(typeof value, `en ${path}`).toBe("string");
    for (const [path, value] of itFlat) expect(typeof value, `it ${path}`).toBe("string");
  });
});

describe("the three strings a member-token install depends on", () => {
  // The team card's role-specific bodies, and the connect field that has always
  // accepted an invite token without ever saying so.
  const keys = [
    "details.teamCardBodyAdmin",
    "details.teamCardBodyMember",
    "connectExisting.passwordPlaceholder",
    // What a non-owner reads in place of the "Update my Second Brain" button.
    "details.updateDescOther",
    // And what an owner reads NEXT TO that button on a brain too old to confirm
    // they are the owner.
    "details.updateDescLegacy",
  ];

  it("is present, non-blank and actually translated", () => {
    for (const key of keys) {
      const english = enFlat.get(key);
      const italian = itFlat.get(key);
      expect(typeof english, `en ${key}`).toBe("string");
      expect(typeof italian, `it ${key}`).toBe("string");
      expect(String(english).trim().length, `en ${key} blank`).toBeGreaterThan(0);
      expect(String(italian).trim().length, `it ${key} blank`).toBeGreaterThan(0);
      // Equal strings are how an untranslated placeholder gets shipped.
      expect(italian, `it ${key} left in English`).not.toBe(english);
    }
  });

  it("no longer calls the credential a password and nothing else", () => {
    // The whole of "the desktop app configures member tokens": the field
    // already took one, and until now nothing on screen said so.
    expect(String(enFlat.get("connectExisting.passwordPlaceholder"))).toMatch(/invite token/i);
    expect(String(itCatalog.connectExisting.unlockLede)).toMatch(/token/i);
    expect(String(en.connectExisting.unlockLede)).toMatch(/invite/i);
  });

  it("tells a member what to type on the screen a member actually reaches", () => {
    // `unlockLede` was rewritten first, and it belongs to `unlockBrainScreen` —
    // reached only from the brain picker, i.e. only when `discover_brains`
    // found the brain in the CONNECTING user's own Cloudflare account. A
    // member's brain is in the owner's account, so that screen is, for them,
    // nearly unreachable.
    //
    // `connectExisting.lede` is the one they read: `manualEntryScreen` is where
    // "none found" lands them, where "Enter the address myself" lands them, and
    // where a pasted address lands them. It sat directly above a field already
    // relabelled "Your password, or your team invite token" and still said to
    // enter "the address and password".
    for (const catalog of [enFlat, itFlat]) {
      expect(String(catalog.get("connectExisting.lede"))).toMatch(/token/i);
    }
    // And the screen that was already fixed stays fixed.
    for (const catalog of [enFlat, itFlat]) {
      expect(String(catalog.get("connectExisting.unlockLede"))).toMatch(/token/i);
    }
  });

  it("calls the shared layer what the rest of the product calls it", () => {
    // The Worker's enum is z.enum(["personal","company"]), POST /capture's 400
    // says `workspace must be "personal" or "company"`, the dashboard says
    // "company", and the owner's own card three lines above the member's said
    // "the company layer". Only the member's card invented "team layer" — a
    // name that appears nowhere the member could go and look for it.
    for (const [path, value] of [...enFlat, ...itFlat]) {
      expect(String(value), `${path} names a layer the product does not have`).not.toMatch(
        /\bteam layer\b|\blivello del team\b/i,
      );
    }
    // Said positively, so deleting the phrase rather than correcting it fails.
    expect(String(enFlat.get("details.teamCardBodyMember"))).toMatch(/company layer/i);
    expect(String(itFlat.get("details.teamCardBodyMember"))).toMatch(/livello aziendale/i);
  });

  it("explains a Worker update a non-owner cannot perform, rather than hiding it", () => {
    // Not silently dropped: a member whose brain is behind sees features go
    // missing and deserves to know why. The note has to say who CAN do it,
    // and must not read like a temporary failure.
    for (const catalog of [enFlat, itFlat]) {
      const other = String(catalog.get("details.updateDescOther"));
      expect(other.trim().length).toBeGreaterThan(0);
      expect(other, "the note must not be the owner's copy").not.toBe(
        String(catalog.get("details.updateDesc")),
      );
      // And it must not offer an action, which is the whole point.
      expect(other).not.toMatch(/Update my Second Brain|Aggiorna il Second Brain/);
    }
    expect(String(enFlat.get("details.updateDescOther"))).toMatch(/Cloudflare/);
    expect(String(itFlat.get("details.updateDescOther"))).toMatch(/Cloudflare/);
  });

  it("does not claim to know who is reading it on a brain that cannot say", () => {
    // The legacy state's copy. The button IS offered here — it is the only way
    // out of a brain whose Worker predates the `owner` key — but it is offered
    // because the app cannot yet tell who this is, not because it has confirmed
    // the owner. Printing the owner's own copy would be the app guessing out
    // loud, so the two must not be the same string, and this one has to name
    // both the uncertainty and what happens if the guess is wrong.
    for (const catalog of [enFlat, itFlat]) {
      const legacy = String(catalog.get("details.updateDescLegacy"));
      expect(legacy.trim().length).toBeGreaterThan(0);
      expect(legacy, "the legacy note must not be the confirmed owner's copy").not.toBe(
        String(catalog.get("details.updateDesc")),
      );
      expect(legacy, "nor the copy for someone who cannot update at all").not.toBe(
        String(catalog.get("details.updateDescOther")),
      );
      // Says what will happen if this is not in fact the owner, so the offer is
      // not read as a promise that it will work.
      expect(legacy).toMatch(/Cloudflare/);
    }
    // And it says, in each language, that the app does not know — not that it
    // does. Positively asserted, so softening the sentence away fails.
    expect(String(enFlat.get("details.updateDescLegacy"))).toMatch(
      /can'?t yet tell|cannot yet tell/i,
    );
    expect(String(itFlat.get("details.updateDescLegacy"))).toMatch(/non sa ancora dire/i);
    // It must never assert ownership, in either language.
    for (const catalog of [enFlat, itFlat]) {
      expect(String(catalog.get("details.updateDescLegacy"))).not.toMatch(
        /owner-admin|you own|you created|sei .{0,12}propriet|hai creato/i,
      );
    }
  });

  it("says something different to each of the three roles", () => {
    for (const catalog of [enFlat, itFlat]) {
      const bodies = [
        catalog.get("details.teamCardBody"),
        catalog.get("details.teamCardBodyAdmin"),
        catalog.get("details.teamCardBodyMember"),
      ];
      expect(new Set(bodies).size).toBe(3);
    }
  });
});
