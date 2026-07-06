import { describe, it, expect } from "vitest";

const { assignGraphClusters, packGraphNodes, packGraphCircles } = require("../../public/utils.js");

type N = { id: string; tags: string[]; cluster?: string; sub?: string | null };

const node = (id: string, tags: string[]): N => ({ id, tags });
const byId = (nodes: N[], id: string) => nodes.find((n) => n.id === id)!;

describe("assignGraphClusters — outer category", () => {
  it("groups a memory under the broadest shared tag, not a rare one", () => {
    // 8 memories all tagged travel; a couple carry extra, more specific tags.
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`t${i}`, ["travel"])),
      node("j1", ["travel", "japan"]),
      node("j2", ["travel", "japan"]),
      node("jr", ["travel", "japan", "ryokan"]), // ryokan is unique -> must not strand
    ];
    assignGraphClusters(nodes);
    // travel is on the whole store (near-universal), so japan-tagged memories surface
    // as their own focused category; the unique ryokan tag never forms a cluster.
    expect(byId(nodes, "j1").cluster).toBe("japan");
    expect(byId(nodes, "jr").cluster).toBe("japan");
    // memories with only the near-universal tag still group under it
    expect(byId(nodes, "t0").cluster).toBe("travel");
  });

  it("demotes a dominant tag so it cannot swallow the whole graph", () => {
    // 'inbox' is on 9 of 10 memories; focused topics must win for those that have them.
    const nodes = [
      ...Array.from({ length: 3 }, (_, i) => node(`g${i}`, ["inbox", "gardening"])),
      node("g3", ["gardening"]),
      ...Array.from({ length: 3 }, (_, i) => node(`c${i}`, ["inbox", "cooking"])),
      ...Array.from({ length: 3 }, (_, i) => node(`p${i}`, ["inbox"])),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "g0").cluster).toBe("gardening");
    expect(byId(nodes, "g3").cluster).toBe("gardening");
    expect(byId(nodes, "c0").cluster).toBe("cooking");
    // inbox-only memories fall back to inbox rather than Other
    expect(byId(nodes, "p0").cluster).toBe("inbox");
  });

  it("buckets auto-pattern entries separately, regardless of other tags", () => {
    const nodes = [
      node("a", ["auto-pattern"]),
      node("b", ["auto-pattern", "status:canonical"]),
      node("c", ["auto-pattern", "travel"]),
      node("d", ["travel"]),
      node("e", ["travel"]),
      node("f", ["travel"]), // 3 direct travel members so the category survives the tiny-fold
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "a").cluster).toBe("__autopattern__");
    expect(byId(nodes, "b").cluster).toBe("__autopattern__");
    expect(byId(nodes, "c").cluster).toBe("__autopattern__");
    expect(byId(nodes, "d").cluster).toBe("travel");
  });

  it("sends reserved/system-only memories to Untagged and unique-only ones to Other", () => {
    const nodes = [
      node("res", ["kind:episodic", "status:canonical", "synthesized"]),
      node("uni", ["one-of-a-kind"]),
      node("t1", ["travel"]),
      node("t2", ["travel"]),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "res").cluster).toBe("__untagged__");
    expect(byId(nodes, "uni").cluster).toBe("__other__");
  });

  it("never lets a literal sentinel-named tag define or hijack a cluster", () => {
    const nodes = [node("x", ["__other__"]), node("y", ["__untagged__"]), node("z", ["__autopattern__"])];
    assignGraphClusters(nodes);
    // sentinel-named tags are filtered out, so these have no candidate tags at all
    expect(byId(nodes, "x").cluster).toBe("__untagged__");
    expect(byId(nodes, "y").cluster).toBe("__untagged__");
    expect(byId(nodes, "z").cluster).toBe("__untagged__");
  });

  it("folds tiny categories into a larger alternative, or Other", () => {
    const nodes = [
      ...Array.from({ length: 10 }, (_, i) => node(`a${i}`, ["alpha"])),
      ...Array.from({ length: 8 }, (_, i) => node(`b${i}`, ["beta"])),
      // gamma is shared by only 2 memories; both also carry alpha -> re-home to alpha
      node("g0", ["gamma", "alpha"]),
      node("g1", ["gamma", "alpha"]),
      // epsilon is shared by only 2 memories with no alternative -> Other
      node("e0", ["epsilon"]),
      node("e1", ["epsilon"]),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "g0").cluster).toBe("alpha");
    expect(byId(nodes, "g1").cluster).toBe("alpha");
    expect(byId(nodes, "e0").cluster).toBe("__other__");
    expect(byId(nodes, "e1").cluster).toBe("__other__");
  });

  it("is deterministic", () => {
    const make = () => [
      ...Array.from({ length: 6 }, (_, i) => node(`a${i}`, ["alpha", i % 2 ? "x" : "y"])),
      ...Array.from({ length: 5 }, (_, i) => node(`b${i}`, ["beta"])),
      node("m", ["alpha", "beta", "x"]),
    ];
    const one = assignGraphClusters(make());
    const two = assignGraphClusters(make());
    expect(one.map((n: N) => [n.id, n.cluster, n.sub])).toEqual(two.map((n: N) => [n.id, n.cluster, n.sub]));
  });
});

describe("assignGraphClusters — sub-topics", () => {
  // travel and cooking categories, each well under half the store; 'sync' is a
  // cross-cutting tag that lives mostly in cooking.
  const makeStore = () => [
    ...Array.from({ length: 8 }, (_, i) => node(`t${i}`, ["travel"])),
    node("j0", ["travel", "japan"]),
    node("j1", ["travel", "japan"]),
    node("j2", ["travel", "japan"]),
    node("j3", ["travel", "japan", "tokyo"]),
    node("i0", ["travel", "italy"]),
    node("i1", ["travel", "italy"]),
    node("i2", ["travel", "italy"]),
    node("solo", ["travel", "one-off"]),
    node("ts0", ["travel", "sync"]),
    node("ts1", ["travel", "sync"]),
    ...Array.from({ length: 13 }, (_, i) => node(`c${i}`, ["cooking"])),
    ...Array.from({ length: 5 }, (_, i) => node(`cs${i}`, ["cooking", "sync"])),
    ...Array.from({ length: 8 }, (_, i) => node(`g${i}`, ["garden"])),
  ];

  it("forms sub-groups from shared, category-contained tags", () => {
    const nodes = assignGraphClusters(makeStore());
    expect(byId(nodes, "j0").cluster).toBe("travel");
    expect(byId(nodes, "j0").sub).toBe("japan");
    expect(byId(nodes, "j3").sub).toBe("japan"); // dominant shared tag beats its unique tokyo
    expect(byId(nodes, "i0").sub).toBe("italy");
  });

  it("rejects cross-cutting tags that mostly live in other categories", () => {
    const nodes = assignGraphClusters(makeStore());
    // sync: 2 of 7 uses are in travel (under half) -> not a travel sub-topic...
    expect(byId(nodes, "ts0").sub).toBeNull();
    // ...but 5 of 7 uses are in cooking -> a genuine cooking sub-topic
    expect(byId(nodes, "cs0").sub).toBe("sync");
  });

  it("leaves members without a shared sub-topic loose", () => {
    const nodes = assignGraphClusters(makeStore());
    expect(byId(nodes, "solo").sub).toBeNull(); // its extra tag is unique
    expect(byId(nodes, "t0").sub).toBeNull(); // no extra tags at all
    expect(byId(nodes, "g0").sub).toBeNull(); // category with no sub-topics
  });
});

describe("packGraphNodes", () => {
  it("centers a single node and returns empty for zero", () => {
    expect(packGraphNodes(0, 50)).toEqual([]);
    expect(packGraphNodes(1, 50)).toEqual([{ x: 0, y: 0 }]);
  });

  it("keeps k nodes inside the disc radius", () => {
    const R = 40;
    const pts = packGraphNodes(25, R);
    expect(pts).toHaveLength(25);
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(R + 1e-9);
    // points are distinct
    const uniq = new Set(pts.map((p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
    expect(uniq.size).toBe(25);
  });
});

describe("packGraphCircles", () => {
  const assertNoOverlap = (radii: number[], gap: number) => {
    const { centers, R } = packGraphCircles(radii, gap);
    expect(centers).toHaveLength(radii.length);
    let maxEdge = 0;
    for (let i = 0; i < radii.length; i++) {
      expect(Number.isFinite(centers[i].x)).toBe(true);
      expect(Number.isFinite(centers[i].y)).toBe(true);
      maxEdge = Math.max(maxEdge, Math.hypot(centers[i].x, centers[i].y) + radii[i]);
      for (let j = i + 1; j < radii.length; j++) {
        const d = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y);
        expect(d + 1e-6).toBeGreaterThanOrEqual(radii[i] + radii[j] + gap);
      }
    }
    // the reported bounding radius covers every circle
    expect(R + 1e-6).toBeGreaterThanOrEqual(maxEdge);
    return { centers, R };
  };

  it("handles empty and single inputs", () => {
    expect(packGraphCircles([], 10)).toEqual({ centers: [], R: 0 });
    expect(packGraphCircles([42], 10)).toEqual({ centers: [{ x: 0, y: 0 }], R: 42 });
  });

  it("packs mixed sizes with no overlap and honors input order", () => {
    const radii = [80, 15, 40, 200, 22, 60, 9, 120];
    assertNoOverlap(radii, 24);
  });

  it("packs a huge circle among small ones without overlap", () => {
    assertNoOverlap([600, 20, 30, 25, 40, 18, 22], 24);
  });

  it("stays tight and finite for many circles", () => {
    const radii = Array.from({ length: 200 }, (_, i) => 10 + (i % 17) * 3);
    const { R } = assertNoOverlap(radii, 7);
    // tight-ish: the bounding circle should be far smaller than laying circles in a line
    const worst = radii.reduce((a, r) => a + 2 * r, 0);
    expect(R).toBeLessThan(worst / 4);
  });

  it("is deterministic", () => {
    const radii = [30, 55, 10, 80, 44, 12, 66];
    const a = packGraphCircles(radii, 12);
    const b = packGraphCircles(radii, 12);
    expect(a).toEqual(b);
  });
});
