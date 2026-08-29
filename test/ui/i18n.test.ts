/**
 * Dashboard i18n: catalogs, DOM apply, and locale boot.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

function loadI18n(locale?: "en" | "it") {
  const store = new Map<string, string>();
  const els: any[] = [];
  const makeEl = (attrs: Record<string, string> = {}) => {
    const el: any = {
      attrs: { ...attrs },
      textContent: "",
      innerHTML: "",
      hasAttribute(name: string) {
        return name in this.attrs || (name === "data-i18n-html" && "data-i18n-html" in this.attrs);
      },
      getAttribute(name: string) {
        return this.attrs[name] ?? null;
      },
      setAttribute(name: string, value: string) {
        this.attrs[name] = value;
      },
    };
    els.push(el);
    return el;
  };
  const ctx: any = {
    console,
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
    navigator: { language: "en-US" },
    document: {
      documentElement: { lang: "en" },
      querySelectorAll(sel: string) {
        if (sel === "[data-i18n]") return els.filter((e) => e.getAttribute("data-i18n"));
        return [];
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(resolve(ROOT, "public/js/i18n.js"), "utf8"), ctx);
  if (locale) ctx.initI18n(locale);
  else ctx.initI18n();
  return { ctx, makeEl, store };
}

describe("dashboard i18n", () => {
  it("translates dotted keys and falls back to English", () => {
    const { ctx } = loadI18n("it");
    expect(ctx.t("menu.appearance")).toBe("Aspetto");
    expect(ctx.t("menu.disconnect")).toBe("Disconnetti");
    expect(ctx.t("no.such.key")).toBe("no.such.key");
  });

  it("interpolates and picks plurals", () => {
    const { ctx } = loadI18n("en");
    expect(ctx.tPlural("nav.statusCount", 1)).toBe("1 memory stored");
    expect(ctx.tPlural("nav.statusCount", 5)).toBe("5 memories stored");
    expect(ctx.t("auth.serverError", { status: "503" })).toBe("Server error: 503");
  });

  it("applies data-i18n to the DOM", () => {
    const { ctx, makeEl } = loadI18n("it");
    const label = makeEl({ "data-i18n": "menu.appearance" });
    const input = makeEl({
      "data-i18n": "auth.tokenPlaceholder",
      "data-i18n-attr": "placeholder",
    });
    const hint = makeEl({ "data-i18n": "home.hintHtml", "data-i18n-html": "" });
    ctx.applyI18nDom();
    expect(label.textContent).toBe("Aspetto");
    expect(input.getAttribute("placeholder")).toMatch(/password/i);
    expect(hint.innerHTML).toContain("#tag");
  });

  it("persists sb-locale and sets documentElement.lang", () => {
    const { ctx, store } = loadI18n("it");
    expect(store.get("sb-locale")).toBe("it");
    expect(ctx.document.documentElement.lang).toBe("it");
    expect(ctx.getLocale()).toBe("it");
    expect(ctx.localeTag()).toBe("it-IT");
  });

  it("resolves integration connect copy by provider id (kebab-case)", () => {
    const { ctx: en } = loadI18n("en");
    const { ctx: it } = loadI18n("it");
    const registry = readFileSync(resolve(ROOT, "src/integrations/index.ts"), "utf8");
    const providers = [...registry.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(providers.length).toBeGreaterThan(0);
    const fields = ["label", "placeholder", "hint"] as const;
    for (const id of providers) {
      for (const field of fields) {
        const key = `integrations.connect.${id}.${field}`;
        const enVal = en.t(key);
        const itVal = it.t(key);
        expect(enVal).not.toBe(key);
        expect(itVal).not.toBe(key);
      }
      expect(it.t(`integrations.connect.${id}.label`)).not.toBe(
        en.t(`integrations.connect.${id}.label`),
      );
      expect(it.t(`integrations.connect.${id}.hint`)).not.toBe(
        en.t(`integrations.connect.${id}.hint`),
      );
    }
  });

  it("every key exists in both catalogs", () => {
    const { ctx } = loadI18n("en");
    const en = vm.runInContext("I18N_EN", ctx);
    const it = vm.runInContext("I18N_IT", ctx);

    function flatten(obj: any, prefix: string, out: string[]): string[] {
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const path = prefix ? `${prefix}.${key}` : key;
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          flatten(value, path, out);
        } else {
          out.push(path);
        }
      }
      return out;
    }

    const enKeys = flatten(en, "", []).sort();
    const itKeys = flatten(it, "", []).sort();
    const enSet = new Set(enKeys);
    const itSet = new Set(itKeys);

    expect(enKeys.length).toBeGreaterThan(400);
    expect(enKeys.filter((k) => !itSet.has(k)), "keys missing from I18N_IT").toEqual([]);
    expect(itKeys.filter((k) => !enSet.has(k)), "keys missing from I18N_EN").toEqual([]);
  });

  it("every translated string a call site asks for exists in both catalogs", () => {
    // The previous test compares catalog to catalog: I18N_EN's key set against I18N_IT's.
    // That structurally cannot see a call site whose key was deleted from BOTH catalogs at
    // once — which is exactly what happens when one group removes a key it owns while
    // another group's call site (in a different file) still uses it. Both catalogs stay
    // symmetric, parity passes, and t() falls back to returning the raw key path, so a user
    // sees a literal "team.shareConfirm" instead of a translated string. This test walks
    // every real call site and checks it against both catalogs directly.

    const PUBLIC_ROOT = resolve(ROOT, "public");

    function listPublicFiles(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) out.push(...listPublicFiles(full));
        else if (/\.(js|html)$/.test(entry.name)) out.push(full);
      }
      return out;
    }

    function lineOf(content: string, index: number): number {
      return content.slice(0, index).split("\n").length;
    }

    // Scans forward from just after "t(" / "tPlural(" to find the end of the FIRST
    // argument, respecting nested strings/template literals and nested (), [], {}. Returns
    // null if the call never closes (shouldn't happen in well-formed source).
    function extractFirstArg(content: string, startArgs: number): string | null {
      let depth = 1;
      let i = startArgs;
      let inStr: string | null = null;
      while (i < content.length) {
        const ch = content[i];
        if (inStr) {
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          i++;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
          depth++;
          i++;
          continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) return content.slice(startArgs, i).trim();
          i++;
          continue;
        }
        if (ch === "," && depth === 1) return content.slice(startArgs, i).trim();
        i++;
      }
      return null;
    }

    // A template literal with exactly one `${...}` splits cleanly into a static prefix,
    // the interpolated expression, and a static suffix — as long as there's no second
    // interpolation in what's left. Returns null for anything messier than that (multiple
    // interpolations), which is left as an opaque dynamic call site.
    function parseTemplateLiteral(
      raw: string,
    ): { prefix: string; expr: string; suffix: string } | null {
      if (!raw.startsWith("`") || !raw.endsWith("`")) return null;
      const inner = raw.slice(1, -1);
      const idx = inner.indexOf("${");
      if (idx === -1) return null;
      const prefix = inner.slice(0, idx);
      let depth = 1;
      let i = idx + 2;
      let inStr: string | null = null;
      while (i < inner.length && depth > 0) {
        const ch = inner[i];
        if (inStr) {
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
          i++;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          i++;
          continue;
        }
        if (ch === "{") {
          depth++;
          i++;
          continue;
        }
        if (ch === "}") {
          depth--;
          if (depth === 0) break;
          i++;
          continue;
        }
        i++;
      }
      if (depth !== 0) return null;
      const expr = inner.slice(idx + 2, i);
      const suffix = inner.slice(i + 1);
      if (suffix.includes("${")) return null;
      return { prefix, expr, suffix };
    }

    // Finds the TOP-LEVEL `?` and its matching `:` in a ternary expression (so nested
    // ternaries in the falsy branch, e.g. `a ? b : c ? d : e`, split at the outer one).
    function splitTopLevelTernary(expr: string): { truthy: string; falsy: string } | null {
      let depth = 0;
      let inStr: string | null = null;
      let qIdx = -1;
      let qCount = 0;
      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (inStr) {
          if (ch === "\\") {
            i++;
            continue;
          }
          if (ch === inStr) inStr = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") {
          depth++;
          continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          continue;
        }
        if (depth !== 0) continue;
        if (ch === "?" && expr[i + 1] !== "." && expr[i + 1] !== "?") {
          if (qIdx === -1) qIdx = i;
          qCount++;
        } else if (ch === ":") {
          qCount--;
          if (qCount === 0 && qIdx !== -1) {
            return { truthy: expr.slice(qIdx + 1, i), falsy: expr.slice(i + 1) };
          }
        }
      }
      return null;
    }

    // Resolves an expression to every literal string it can produce, IF it is built
    // entirely out of quoted-string literals and ternaries over them (any condition is
    // allowed — only the branches must bottom out in literals). A bare identifier like
    // `shape` returns null and stays dynamic; `a ? 'x' : b ? 'y' : 'z'` resolves to
    // ['x', 'y', 'z']. This is what lets `auth.${cond ? 'accountSuspended' : cond2 ?
    // 'accountRemoved' : 'invalidToken'}` be checked directly instead of treated as opaque.
    function resolveLiteralBranches(expr: string): string[] | null {
      const trimmed = expr.trim();
      const lit = trimmed.match(/^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/);
      if (lit) return [lit[2]];
      const split = splitTopLevelTernary(trimmed);
      if (split) {
        const left = resolveLiteralBranches(split.truthy);
        const right = resolveLiteralBranches(split.falsy);
        if (left && right) return [...left, ...right];
      }
      return null;
    }

    type StaticHit = { file: string; line: number; key: string };
    type DynamicHit = { file: string; line: number; fn: string; snippet: string };

    const staticHits: StaticHit[] = [];
    const dynamicHits: DynamicHit[] = [];

    for (const file of listPublicFiles(PUBLIC_ROOT)) {
      if (file.endsWith("/public/js/i18n.js")) continue; // the catalogs/engine, not a caller
      const rel = relative(ROOT, file);
      const content = readFileSync(file, "utf8");

      const callRe = /\b(t|tPlural)\(/g;
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(content))) {
        const startArgs = m.index + m[0].length;
        const arg = extractFirstArg(content, startArgs);
        if (arg == null) continue;
        const line = lineOf(content, m.index);
        const lit = arg.match(/^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/);
        if (lit) {
          staticHits.push({ file: rel, line, key: lit[2] });
          continue;
        }
        const tmpl = parseTemplateLiteral(arg);
        if (tmpl) {
          const branches = resolveLiteralBranches(tmpl.expr);
          if (branches) {
            for (const b of branches) {
              staticHits.push({ file: rel, line, key: `${tmpl.prefix}${b}${tmpl.suffix}` });
            }
            continue;
          }
        }
        // Neither a literal nor a ternary-of-literals: a genuinely dynamic key (built by
        // interpolating a runtime value) or an indirect one (a local variable/lookup we
        // don't trace). Either way it can't be checked against the catalogs here, so it
        // must be accounted for explicitly below instead of silently vanishing.
        dynamicHits.push({ file: rel, line, fn: m[1], snippet: arg });
      }

      // data-i18n-attr's VALUE is an attribute name ("placeholder", "title|aria-label",
      // ...) to copy the translation INTO, not an i18n key itself — the key always comes
      // from the data-i18n attribute on the same element (see applyI18nDom in i18n.js).
      // So only data-i18n carries keys to extract.
      const dataI18nRe = /data-i18n="([^"]*)"/g;
      let dm: RegExpExecArray | null;
      while ((dm = dataI18nRe.exec(content))) {
        staticHits.push({ file: rel, line: lineOf(content, dm.index), key: dm[1] });
      }
    }

    // Guard against vacuous success: a broken extractor that silently matches nothing
    // must not pass. Real count on the merged tree when this test was written: 542 call
    // sites resolving to 408 unique keys (405 direct literals/data-i18n + 3 more from
    // resolving the auth ternary below). 300 is comfortably below that.
    expect(staticHits.length).toBeGreaterThan(300);

    const { ctx } = loadI18n("en");
    const en = vm.runInContext("I18N_EN", ctx);
    const it_ = vm.runInContext("I18N_IT", ctx);

    function resolvesToTranslation(catalog: any, path: string): boolean {
      const node = path
        .split(".")
        .reduce((o: any, k: string) => (o == null ? undefined : o[k]), catalog);
      if (typeof node === "string") return true;
      return !!node && typeof node === "object" && typeof node.one === "string" && typeof node.other === "string";
    }

    const failures: string[] = [];
    for (const hit of staticHits) {
      const okEn = resolvesToTranslation(en, hit.key);
      const okIt = resolvesToTranslation(it_, hit.key);
      if (!okEn || !okIt) {
        const missing = [!okEn && "en", !okIt && "it"].filter(Boolean).join("+");
        failures.push(`${hit.file}:${hit.line} ${hit.key} (missing in: ${missing})`);
      }
    }
    expect(failures, "call sites whose key is missing from a catalog").toEqual([]);

    // Dynamic (unresolvable) call sites, as of the tree this test was written against.
    // These build their key from a runtime value rather than a literal, so they can't be
    // checked here — `patterns.shapes.${shape}` and `integrations.connect.${id}.*` (built
    // one level up, in integrationConnectI18n) are exercised by the registry-driven test
    // above ("resolves integration connect copy by provider id"); the rest resolve through
    // a small local lookup table that's visible in a diff of the file it lives in. This
    // list is a closed set on purpose: a NEW dynamic call site — whether a fresh
    // interpolation or a fresh indirection — must land here deliberately, not vanish
    // between this check and the catalog-parity check above.
    const EXPECTED_DYNAMIC_CALL_SITES = [
      "public/js/brief.js:142 t(`patterns.shapes.${shape}`)",
      // Both of these resolve through captureDefaultKey() in public/utils.js, which
      // returns one of exactly four literals — home.auto{Shared,Personal}{Yours,Org}.
      // The composer and the Team screen's member readout share it precisely so one
      // profile cannot be described two ways, which is also why neither site can spell
      // the keys out. All four are asserted verbatim in ui/composer-policy-hint.test.ts
      // and reached again in ui/team-panel.test.ts.
      "public/js/home.js:80 t(key)",
      "public/js/team.js:234 t(defaultKey)",
      "public/js/integrations.js:29 t(keys[id] || 'integrations.categoryOther')",
      "public/js/integrations.js:39 tPlural(integrationNounKey(provider))",
      "public/js/integrations.js:44 t(key)",
      "public/js/integrations.js:47 t(fallbackKey)",
      "public/js/memory-crud.js:348 t(keys[event])",
      "public/js/patterns.js:78 t(`patterns.shapes.${shape}`)",
      "public/utils.js:225 t(key)",
    ].sort();

    const actualDynamicCallSites = dynamicHits
      .map((d) => `${d.file}:${d.line} ${d.fn}(${d.snippet})`)
      .sort();

    expect(actualDynamicCallSites).toEqual(EXPECTED_DYNAMIC_CALL_SITES);
  });
});
