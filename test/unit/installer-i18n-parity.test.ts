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
