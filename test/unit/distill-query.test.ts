import { describe, it, expect } from "vitest";
import { distillToRareTerms } from "../../src/index";

// A minimal env whose D1 aggregation returns crafted document-frequencies. The columns
// d0..dN map to the query's unique content tokens in order (as distillToRareTerms builds
// them), so `dfByToken` lets each test declare how common each token is.
function envWith(total: number, dfByToken: Record<string, number>, tokenOrder: string[]) {
  const row: Record<string, number> = { total };
  tokenOrder.forEach((t, i) => { row[`d${i}`] = dfByToken[t] ?? 0; });
  return {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => row }) }),
    },
  } as any;
}

describe("distillToRareTerms", () => {
  it("drops corpus-saturating terms and keeps the rare, discriminative ones", async () => {
    // "second"/"brain" saturate the corpus (>30%); "dictawiz"/"reddit" are rare.
    const order = ["second", "brain", "dictawiz", "reddit"];
    const env = envWith(100, { second: 80, brain: 85, dictawiz: 2, reddit: 6 }, order);
    const out = await distillToRareTerms("second brain dictawiz reddit", env);
    expect(out).toBe("dictawiz reddit");
  });

  it("caps the query at the rarest MAX_QUERY_TERMS (3)", async () => {
    // None saturating; keep the 3 rarest, drop the most common ("review").
    const order = ["quarterly", "review", "budget", "finance"];
    const env = envWith(100, { quarterly: 4, review: 25, budget: 3, finance: 2 }, order);
    const out = await distillToRareTerms("quarterly review budget finance", env);
    // "review" (df 25) is the most common of the four → dropped; order preserved.
    expect(out).toBe("quarterly budget finance");
  });

  it("strips grammatical stopwords, then drops saturating content words", async () => {
    // "what/on/the/to" are grammatical stopwords (removed first); "happened" is a content
    // word but saturates the corpus (>30%) so it's dropped, leaving the rare subject.
    const order = ["happened", "trip", "cleveland"];
    const env = envWith(100, { happened: 45, trip: 12, cleveland: 3 }, order);
    const out = await distillToRareTerms("what happened on the trip to cleveland", env);
    expect(out).toBe("trip cleveland");
  });

  it("returns a single content word unchanged without touching the DB", async () => {
    const env = { DB: { prepare: () => { throw new Error("should not query"); } } } as any;
    expect(await distillToRareTerms("dictawiz", env)).toBe("dictawiz");
  });

  it("falls back to the content words if the frequency scan fails", async () => {
    const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("db down"); } }) }) } } as any;
    const out = await distillToRareTerms("alpha beta gamma", env);
    expect(out).toBe("alpha beta gamma");
  });
});
