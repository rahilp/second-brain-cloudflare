/**
 * Integrations sheet: connection provenance for every member.
 *
 * A connected card used to tell a non-admin nothing but "Admins only" — no
 * hint at who to ask, or whether a synced page lands in their own private
 * layer or the team's. This adds one prose line, and the WHOLE line is gated
 * on TEAM_MODE.
 *
 * Gating only the mirror-layer clause was the original shape and it was wrong:
 * `connectedAt` predates this phase entirely and `connectedBy` resolves on any
 * brain with a named roster, so a solo install that merely upgraded grew a
 * provenance line out of data it already had, with no action by its owner. New
 * UI on an untouched solo brain is the one thing the compatibility constraint
 * rules out, so the gate moved to cover all three clauses.
 *
 * Harness copied from disconnect-sheet.test.ts's `load()`, which already
 * builds the right vm context for integrations.js.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function makeEl() {
  const classes = new Set<string>();
  return {
    id: "",
    checked: false,
    disabled: false,
    value: "",
    textContent: "",
    innerHTML: "",
    style: {} as Record<string, string>,
    classList: {
      add: (c: string) => void classes.add(c),
      remove: (c: string) => void classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
    setAttribute() {},
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    dataset: {} as Record<string, string>,
  };
}

/** Same file set + bootstrap as disconnect-sheet.test.ts, plus TEAM_MODE. api.js
 *  (which owns the real declaration) is deliberately not loaded, so this `var`
 *  is the only declaration in scope — same trick team-panel.test.ts uses. */
function load(teamMode: boolean, locale: "en" | "it" = "en") {
  const els = new Map<string, any>();
  const ctx: any = {
    console,
    document: {
      getElementById: (id: string) => {
        if (!els.has(id)) {
          const el = makeEl();
          el.id = id;
          els.set(id, el);
        }
        return els.get(id);
      },
      createElement: () => makeEl(),
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { style: {}, appendChild(el: any) { if (el.id) els.set(el.id, el); } },
    },
    confirm: () => {
      throw new Error("confirm() must not be used");
    },
    alert: () => {
      throw new Error("alert() must not be used");
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => {
      throw new Error("no fetch expected in these tests");
    },
  };
  ctx.globalThis = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  installI18n(ctx, locale);
  for (const f of [
    "public/utils.js",
    "public/js/state.js",
    "public/js/toast.js",
    "public/js/confirm-sheet.js",
    "public/js/integrations.js",
  ]) {
    vm.runInContext(readFileSync(resolve(ROOT, f), "utf8"), ctx);
  }
  vm.runInContext(`WORKER_URL = "https://example.test"; AUTH_TOKEN = "tok"; var TEAM_MODE = ${teamMode}`, ctx);
  return ctx;
}

const BASE = {
  provider: "notion",
  name: "Notion",
  connected: true,
  workspaceName: "Acme Notion",
  itemCount: 5,
  lastSyncedAt: 1771999999000,
};

describe("integrations sheet: connection provenance", () => {
  it("shows who connected it and where syncs land, on a team brain", () => {
    const ctx = load(true);
    const html = ctx.renderIntegrationCard({
      ...BASE,
      connectedBy: "Alice",
      mirrorWorkspace: "company",
      connectedAt: 1772000000000,
    });
    expect(html).toContain("Connected by Alice");
    expect(html).toContain("Synced memories land in the shared team layer");
  });

  it("says personal, not shared, when the mirror workspace is personal — both branches", () => {
    const ctx = load(true);
    const personalHtml = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "personal" });
    expect(personalHtml).toContain("Synced memories land in the personal layer");
    expect(personalHtml).not.toContain("Synced memories land in the shared team layer");

    const sharedHtml = ctx.renderIntegrationCard({ ...BASE, mirrorWorkspace: "company" });
    expect(sharedHtml).toContain("Synced memories land in the shared team layer");
    expect(sharedHtml).not.toContain("Synced memories land in the personal layer");
  });

  it("names no one and writes no literal 'null' when connectedBy is null", () => {
    const ctx = load(true);
    const html = ctx.renderIntegrationCard({ ...BASE, connectedBy: null, mirrorWorkspace: "company" });
    expect(html).not.toContain("Connected by");
    expect(html).not.toContain("null");
  });

  // The server contract is "a name, or null, or empty string" — listRoster maps
  // a missing users.name to "" and the route's nameOf.get(id) ?? null does not
  // catch that case, so a truthiness check (not `!== null`) is what keeps this
  // from rendering "Connected by " with nothing after it.
  it("names no one, and leaves no dangling label, when connectedBy is the empty string", () => {
    const ctx = load(true);
    const html = ctx.renderIntegrationCard({ ...BASE, connectedBy: "", mirrorWorkspace: "company" });
    expect(html).not.toContain("Connected by");
  });

  it("still reads the provenance line for a member, above the reason they cannot act on it", () => {
    const ctx = load(true);
    vm.runInContext("integrationsAdmin = false", ctx);
    const html = ctx.renderIntegrationCard({
      ...BASE,
      connectedBy: "Alice",
      mirrorWorkspace: "company",
      connectedAt: 1772000000000,
    });
    expect(html).toContain("Connected by Alice");
    expect(html).toContain("Synced memories land in the shared team layer");
    expect(html).toContain(ctx.t("integrations.adminsOnly"));
    // The provenance line reads before the reason the member cannot act on it.
    expect(html.indexOf("Connected by Alice")).toBeLessThan(html.indexOf("Only workspace admins"));
    expect(html).not.toContain("<button");
  });

  // ensureTenantBootstrap creates a company workspace and joins the owner to it
  // on every brain, including a one-person one — so on a real solo brain
  // connectedBy resolves to the owner's OWN name rather than null. That is
  // precisely why the emptiness of the fields cannot be what suppresses this
  // line: the data is there, and TEAM_MODE is the only thing that isn't.
  it("names no connector on a solo brain even though the name resolves", () => {
    const ctx = load(false);
    const html = ctx.renderIntegrationCard({ ...BASE, connectedBy: "Owner", mirrorWorkspace: "personal" });
    expect(html).not.toContain("Connected by Owner");
    expect(html).not.toContain("Synced memories land in the personal layer");
    expect(html).not.toContain("Synced memories land in the shared team layer");
  });

  // NOT "byte-identical to the pre-task render": this task's provenance slot
  // (`${provenance ? ... : ''}`) always adds one line to the template, and for
  // this fixture that line is empty — a real but whitespace-only difference
  // from the pre-task string. Comparing non-blank lines is what makes this
  // test actually able to catch a REAL content drift instead of being pinned
  // to a literal that already includes the harmless line it should ignore.
  it("adds no visible content for a pre-Task-6 record with none of the three provenance fields", () => {
    const ctx = load(false);
    // A pre-Task-6 record: no connectedBy, no mirrorWorkspace, no connectedAt.
    // (A real solo brain's connectedBy is the owner's name, not this — see
    // above. This fixture is the "field never existed" case, not "solo brain".)
    const html = ctx.renderIntegrationCard({ ...BASE });
    expect(html).not.toContain("Synced memories land in the personal layer");
    expect(html).not.toContain("Synced memories land in the shared team layer");
    const nonBlankLines = (html as string).split("\n").map((l: string) => l.trim()).filter(Boolean);
    expect(nonBlankLines).toEqual([
      '<div class="integration-row">',
      '<div class="integration-head"><i class="ti ti-brand-notion"></i><span>Notion</span><span class="integration-state connected">Acme Notion</span></div>',
      `<p class="digest-note" id="note-notion">5 items synced &middot; Last sync: ${new Date(BASE.lastSyncedAt).toLocaleString(ctx.localeTag())}</p>`,
      '<div class="integration-actions">',
      '<button class="digest-btn" onclick="syncIntegration(\'notion\', this)"><i class="ti ti-refresh"></i> Sync now</button>',
      '<button class="digest-btn danger" onclick="disconnectIntegration(\'notion\', this)">Disconnect</button>',
      "</div>",
      "</div>",
    ]);
  });

  // THE BACKWARDS-COMPATIBILITY CASE, and the reason the whole line is gated
  // rather than only its middle clause.
  //
  // `connectedAt` is not a field this phase added — it has been on the record
  // since integrations shipped. So a solo user who connected Notion months ago
  // and merely upgrades gets a "Connected 3 Mar 2026" line they never had, with
  // no action of their own. That is new UI on an untouched solo brain, which
  // the phase's compatibility constraint forbids outright. The fixture below is
  // deliberately a FULLY POPULATED record: gating only on "the fields happen to
  // be empty" would pass while the constraint was still broken.
  it("renders a solo brain's card exactly as it did before this phase, even with every provenance field populated", () => {
    const ctx = load(false);
    const html = ctx.renderIntegrationCard({
      ...BASE,
      connectedBy: "Owner",
      mirrorWorkspace: "personal",
      connectedAt: 1772000000000,
    });
    expect(html).not.toContain("Connected by");
    expect(html).not.toContain("Connected ");
    expect(html).not.toContain("Synced memories land in");

    const nonBlankLines = (html as string).split("\n").map((l: string) => l.trim()).filter(Boolean);
    expect(nonBlankLines).toEqual([
      '<div class="integration-row">',
      '<div class="integration-head"><i class="ti ti-brand-notion"></i><span>Notion</span><span class="integration-state connected">Acme Notion</span></div>',
      `<p class="digest-note" id="note-notion">5 items synced &middot; Last sync: ${new Date(BASE.lastSyncedAt).toLocaleString(ctx.localeTag())}</p>`,
      '<div class="integration-actions">',
      '<button class="digest-btn" onclick="syncIntegration(\'notion\', this)"><i class="ti ti-refresh"></i> Sync now</button>',
      '<button class="digest-btn danger" onclick="disconnectIntegration(\'notion\', this)">Disconnect</button>',
      "</div>",
      "</div>",
    ]);
  });

  // The other branch of the same gate, stated so neither can be removed
  // silently: on a TEAM brain all three clauses render together.
  it("renders all three provenance clauses on a team brain", () => {
    const ctx = load(true);
    const html = ctx.renderIntegrationCard({
      ...BASE,
      connectedBy: "Alice",
      mirrorWorkspace: "company",
      connectedAt: 1772000000000,
    });
    expect(html).toContain("Connected by Alice");
    expect(html).toContain("Synced memories land in the shared team layer");
    expect(html).toContain(
      ctx.t("integrations.connectedOn", {
        when: new Date(1772000000000).toLocaleDateString(ctx.localeTag()),
      }),
    );
  });

  it("speaks Italian", () => {
    const ctx = load(true, "it");
    const html = ctx.renderIntegrationCard({
      ...BASE,
      connectedBy: "Alice",
      mirrorWorkspace: "company",
      connectedAt: 1772000000000,
    });
    expect(html).toContain("Collegata da Alice");
    expect(html).toContain("I ricordi sincronizzati finiscono nel livello condiviso del team");
  });
});
