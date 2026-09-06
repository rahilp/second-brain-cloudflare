/**
 * CI runs the suite in Node; production runs in workerd. Both ship ICU, but not
 * the same ICU, and Intl.Segmenter / NFKC are exactly the surfaces where they
 * can disagree. This executes the real tokenizer inside a Miniflare worker at
 * the pinned compatibility date and requires the same output as Node — the
 * tripwire for a future workerd or ICU bump.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { resolve } from "node:path";
import { tokenizeQuery } from "../../src/text/tokenize";

const CASES = [
  "認証方式を変更した理由",
  "Ｖ１．９ の変更",
  "ｷｬﾘｱ",
  "これは認証方式についてのメモです",
  "2025年3月の認証方式",
  "夢",
  "𠮷野家",
  "release v1.9 foo_bar 100%",
];

describe("tokenizeQuery inside workerd matches Node (#326 ICU pin)", () => {
  let mf: Miniflare;

  beforeAll(async () => {
    const bundle = await build({
      entryPoints: [resolve(import.meta.dirname, "../../src/text/tokenize.ts")],
      bundle: true,
      format: "esm",
      write: false,
      platform: "browser",
      target: "esnext",
    });
    const lib = bundle.outputFiles[0].text;
    mf = new Miniflare({
      modules: true,
      compatibilityDate: "2026-06-17",
      compatibilityFlags: ["nodejs_compat"],
      script: `${lib}
export default {
  async fetch(request) {
    const { queries } = await request.json();
    return Response.json({ segmenter: typeof Intl.Segmenter, tokens: queries.map(q => tokenizeQuery(q)) });
  },
};`,
    });
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("segments and normalizes identically", async () => {
    const res = await mf.dispatchFetch("http://pin/", { method: "POST", body: JSON.stringify({ queries: CASES }) });
    const body = await res.json() as { segmenter: string; tokens: string[][] };
    expect(body.segmenter).toBe("function");
    expect(body.tokens).toEqual(CASES.map(q => tokenizeQuery(q)));
  });
});
