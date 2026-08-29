import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * The dashboard's scripts, in the order the page loads them.
 *
 * Scraped from index.html rather than listed here. This was a hand-written copy
 * and it drifted the first time a module was added: the page loaded the new
 * file, this list did not, and the guard below reported the new file's handlers
 * as undefined — a failure in the test rather than in the code it guards. The
 * page is the only thing that decides what a browser actually runs, so it is the
 * only honest source for this list, and load ORDER matters, which is another
 * thing a hand-written copy gets to be wrong about silently.
 */
const DASHBOARD_SCRIPTS = [
  ...readFileSync(resolve(ROOT, "public/index.html"), "utf8")
    .matchAll(/<script\s+src="([^"]+)"/g),
].map(m => `public/${m[1].replace(/^\//, "")}`);

/** Keywords / literals that appear in onclick expressions but are not handlers. */
const INLINE_CALL_DENYLIST = new Set(["return", "false", "true"]);

function extractInlineHandlerNames(html: string): string[] {
  const names = new Set<string>();
  const attrPattern = /\bon\w+\s*=\s*"([^"]+)"/g;
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (const [, expr] of html.matchAll(attrPattern)) {
    for (const [, fn] of expr.matchAll(callPattern)) {
      if (!INLINE_CALL_DENYLIST.has(fn)) names.add(fn);
    }
  }
  return [...names].sort();
}

function loadDashboardSource({ runInit = false }: { runInit?: boolean } = {}) {
  let src = DASHBOARD_SCRIPTS.map((rel) => readFileSync(resolve(ROOT, rel), "utf8")).join("\n");
  if (!runInit) src = src.replace(/\ninit\(\)\s*$/, "");
  return src;
}

function makeFakeDocument() {
  const el = () => ({
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    value: "",
    textContent: "",
    innerHTML: "",
    onclick: null,
    setAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    appendChild() {},
    querySelector: () => el(),
    querySelectorAll: () => [],
    remove() {},
    focus() {},
    closest: () => null,
    dataset: {},
    disabled: false,
    scrollHeight: 0,
    offsetHeight: 24,
  });
  return {
    documentElement: { lang: "en", setAttribute() {}, getAttribute: () => null },
    querySelector: () => el(),
    querySelectorAll: () => [],
    getElementById: (_id?: string) => el(),
    createElement: () => el(),
    // Document-level listeners are real: v2.3 registers outside-click and
    // Escape handlers to dismiss row overflow menus at load time, and a
    // document without these throws before any handler is defined.
    addEventListener() {},
    removeEventListener() {},
    body: { style: {}, appendChild() {} },
  };
}

describe("dashboard modules", () => {
  const html = readFileSync(resolve(ROOT, "public/index.html"), "utf8");
  const requiredGlobals = extractInlineHandlerNames(html);

  it("loads all scripts in index.html order without parse errors", () => {
    expect(() => new Function(loadDashboardSource())).not.toThrow();
  });

  it("derives a non-trivial set of inline handlers from index.html", () => {
    expect(requiredGlobals.length).toBeGreaterThanOrEqual(31);
  });

  it("exposes handlers required by inline HTML attributes", () => {
    const sandbox: Record<string, unknown> = {
      document: makeFakeDocument(),
      localStorage: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
      fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "" }),
      module: undefined,
      exports: undefined,
    };
    sandbox.window = {
      location: { origin: "http://localhost" },
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    };
    vm.createContext(sandbox);
    vm.runInContext(loadDashboardSource(), sandbox);
    for (const name of requiredGlobals) {
      expect(typeof sandbox[name], `${name} should be a function`).toBe("function");
    }
  });

  it("renderAboutCredits populates #about-credits without throwing", () => {
    const creditsRoot = {
      innerHTML: "",
    };
    const sandbox: Record<string, unknown> = {
      document: {
        ...makeFakeDocument(),
        documentElement: { lang: "en" },
        getElementById: (id?: string) => (id === "about-credits" ? creditsRoot : makeFakeDocument().getElementById(id)),
      },
      localStorage: {
        getItem: () => null,
        setItem() {},
      },
      navigator: { language: "en-US" },
      module: undefined,
      exports: undefined,
    };
    sandbox.window = sandbox;
    sandbox.escHtml = (s: string) => String(s);
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(resolve(ROOT, "public/js/i18n.js"), "utf8"), sandbox);
    (sandbox as any).initI18n("en");
    vm.runInContext(readFileSync(resolve(ROOT, "public/credits.js"), "utf8"), sandbox);
    expect(typeof sandbox.renderAboutCredits).toBe("function");
    (sandbox.renderAboutCredits as () => void)();
    expect(creditsRoot.innerHTML).toMatch(/Created by/);
    expect(creditsRoot.innerHTML).toMatch(/Maintainers/);
    expect(creditsRoot.innerHTML).toMatch(/Rahil Pirani/);
  });
});

/**
 * docs/dashboard-architecture.md against the page it describes.
 *
 * The document is load-bearing, not decorative: it is what a reader consults
 * before adding a script or reasoning about what is defined by the time
 * something runs. Its chain omitted SEVEN files, `home.js` among them — the
 * file that sets TEAM_MODE, and therefore the one ordering hazard nav.js
 * warns about. A hand-maintained copy of a list the page owns drifts, and this
 * one had; DASHBOARD_SCRIPTS above is scraped from the page for exactly that
 * reason, so the document gets held to the same source.
 */
describe("docs/dashboard-architecture.md", () => {
  const DOC = readFileSync(resolve(ROOT, "docs/dashboard-architecture.md"), "utf8");
  /** Bare file names, so `js/home.js` and `home.js` compare as the same module. */
  const bare = (path: string) => path.replace(/^.*\//, "");
  const LOADED = DASHBOARD_SCRIPTS.map(bare);

  it("states the page's load order, in the page's order", () => {
    const fence = DOC.match(/## Script load order\s*\n+```\n([\s\S]*?)```/);
    expect(fence, "the load-order code fence was not found").not.toBeNull();
    const documented = (fence as RegExpMatchArray)[1]
      .split("→")
      .map((name) => name.trim())
      .filter(Boolean)
      .map(bare);
    expect(documented).toEqual(LOADED);
  });

  it("places every script the page loads in the layers table", () => {
    // The table ROWS, not the section: prose around the table names modules
    // too, and a paragraph mentioning `home.js` would otherwise excuse the row
    // that no longer lists it — the same shape of stale excuse this check was
    // written to end.
    const section = DOC.match(/## Layers[\s\S]*?(?=\n## )/);
    expect(section, "the layers table was not found").not.toBeNull();
    const rows = (section as RegExpMatchArray)[0]
      .split("\n")
      .filter((line) => line.startsWith("|") && !line.startsWith("|---"));
    expect(rows.length, "the layers table parsed to nothing").toBeGreaterThan(3);
    const named = new Set(
      [...rows.join("\n").matchAll(/`([^`]+\.js)`/g)].map((m) => bare(m[1])),
    );
    expect(LOADED.filter((f) => !named.has(f)), "scripts the page loads that no layer claims")
      .toEqual([]);
  });
});
