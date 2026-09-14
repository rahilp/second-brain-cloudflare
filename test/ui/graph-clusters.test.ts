import { describe, it, expect } from "vitest";

const { assignGraphClusters, packGraphNodes, packGraphCircles, filterGraphByActor } = require("../../public/utils.js");

type N = { id: string; tags: string[]; cluster?: string; sub?: string | null };
type E = { source: string; target: string; weight?: number };

const node = (id: string, tags: string[]): N => ({ id, tags });
const byId = (nodes: N[], id: string) => nodes.find((n) => n.id === id)!;

describe("assignGraphClusters — outer category", () => {
  // These fixtures all sit a vague tag *just under* half the store on purpose. That
  // is the case the old rule got wrong and the only case that discriminates: a tag
  // over the halfway line was already skipped, so a fixture built that way passes
  // whichever rule is in force and proves nothing.

  it("clusters on the characteristic tag, not the broadest one", () => {
    // 'inbox' is on 9 of 20 — under the halfway line, and the most common thing left.
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`g${i}`, ["inbox", "gardening"])),
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["inbox", "cooking"])),
      ...Array.from({ length: 11 }, (_, i) => node(`r${i}`, ["reading"])),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "g0").cluster).toBe("gardening");
    expect(byId(nodes, "c0").cluster).toBe("cooking");
    expect(nodes.some((n) => n.cluster === "inbox")).toBe(false);
  });

  it("prefers a topic tag over one of the shipped axis tags", () => {
    // 'work' is an axis tag from AI_Instructions/*.md, on 9 of 20 here.
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`c${i}`, ["work", "cycling"])),
      ...Array.from({ length: 4 }, (_, i) => node(`b${i}`, ["work", "baking"])),
      ...Array.from({ length: 11 }, (_, i) => node(`r${i}`, ["reading"])),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "c0").cluster).toBe("cycling");
    expect(byId(nodes, "b0").cluster).toBe("baking");
  });

  it("still labels a memory that has nothing but an axis tag", () => {
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`c${i}`, ["work", "cycling"])),
      ...Array.from({ length: 4 }, (_, i) => node(`w${i}`, ["work"])),
      ...Array.from({ length: 11 }, (_, i) => node(`r${i}`, ["reading"])),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "c0").cluster).toBe("cycling");
    // no topic to prefer, so the axis tag is the honest answer
    expect(byId(nodes, "w0").cluster).toBe("work");
  });

  it("never lets an axis tag win just because it is more common than every topic", () => {
    // 'task' is on 9 of 20; each topic is rarer, so the old rule handed it all of them.
    const nodes = [
      ...Array.from({ length: 5 }, (_, i) => node(`p${i}`, ["task", "pottery"])),
      ...Array.from({ length: 4 }, (_, i) => node(`s${i}`, ["task", "sailing"])),
      ...Array.from({ length: 11 }, (_, i) => node(`r${i}`, ["reading"])),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "p0").cluster).toBe("pottery");
    expect(byId(nodes, "s0").cluster).toBe("sailing");
    expect(nodes.some((n) => n.cluster === "task")).toBe(false);
  });

  it("ignores the brain's own bookkeeping when choosing a category", () => {
    // rolled-up and a bare issue number are the Worker's words, not the person's.
    const nodes = [
      node("res", ["kind:episodic", "status:canonical", "rolled-up", "5118"]),
      node("uni", ["one-of-a-kind"]),
      node("t1", ["travel"]),
      node("t2", ["travel"]),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "res").cluster).toBe("__loose__");
    expect(byId(nodes, "uni").cluster).toBe("__loose__");
  });

  it("never lets a literal sentinel-named tag define or hijack a cluster", () => {
    const nodes = [node("x", ["__loose__"]), node("y", ["__loose__"])];
    assignGraphClusters(nodes);
    // the sentinel-named tag is filtered out, so these have no candidate tags at all
    expect(byId(nodes, "x").cluster).toBe("__loose__");
    expect(byId(nodes, "y").cluster).toBe("__loose__");
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
    expect(byId(nodes, "e0").cluster).toBe("__loose__");
    expect(byId(nodes, "e1").cluster).toBe("__loose__");
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

describe("assignGraphClusters — structural fallback", () => {
  // Tags cannot place every memory: on a real brain roughly a quarter share no tag
  // with anything else, and on a young one almost nothing has been tagged twice.
  // Rather than pool those into a bucket that describes nothing, the graph places
  // them — a memory linked mostly to cycling memories belongs with them whatever
  // its own tags say.
  it("places an untaggable memory with the neighbours it is linked to", () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["cycling"])),
      ...Array.from({ length: 4 }, (_, i) => node(`b${i}`, ["baking"])),
      node("orphan", ["one-of-a-kind"]),
    ];
    const edges = [
      { source: "orphan", target: "c0", weight: 0.9 },
      { source: "orphan", target: "c1", weight: 0.8 },
      { source: "orphan", target: "b0", weight: 0.2 },
    ];
    assignGraphClusters(nodes, edges);
    expect(byId(nodes, "orphan").cluster).toBe("cycling");
  });

  it("resolves a chain of untaggable memories inward from its clustered end", () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["cycling"])),
      node("a", ["unique-a"]),
      node("b", ["unique-b"]),
    ];
    const edges = [
      { source: "a", target: "c0", weight: 0.9 },
      { source: "b", target: "a", weight: 0.9 },
    ];
    assignGraphClusters(nodes, edges);
    expect(byId(nodes, "a").cluster).toBe("cycling");
    expect(byId(nodes, "b").cluster).toBe("cycling");
  });

  it("leaves a memory with no clustered neighbour loose", () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["cycling"])),
      node("alone", ["nothing-shared"]),
    ];
    assignGraphClusters(nodes, []);
    expect(byId(nodes, "alone").cluster).toBe("__loose__");
  });

  it("does not depend on the order nodes arrive in", () => {
    const make = () => [
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["cycling"])),
      ...Array.from({ length: 4 }, (_, i) => node(`b${i}`, ["baking"])),
      node("orphan", ["one-of-a-kind"]),
    ];
    // a deliberate tie: whichever side wins must win from both directions
    const edges = [
      { source: "orphan", target: "c0", weight: 0.5 },
      { source: "orphan", target: "b0", weight: 0.5 },
    ];
    const forward = assignGraphClusters(make(), edges);
    const reversed = assignGraphClusters(make().reverse(), edges);
    expect(byId(forward, "orphan").cluster).toBe(byId(reversed, "orphan").cluster);
  });

  it("works with no edges supplied at all", () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => node(`c${i}`, ["cycling"])),
      node("orphan", ["one-of-a-kind"]),
    ];
    assignGraphClusters(nodes);
    expect(byId(nodes, "c0").cluster).toBe("cycling");
    expect(byId(nodes, "orphan").cluster).toBe("__loose__");
  });
});

describe("assignGraphClusters — sub-topics", () => {
  // 36 memories, so a category of about six is the ideal size and the tags nearest
  // it win the outer ring: bluesky, mastodon, gardening, reading.
  //
  // Note which tags end up where. 'social-media' is on 22 of 36 and is *not* the
  // outer category for any of them — under this rule a broad tag is a candidate
  // sub-topic, not a category, which is the reverse of how the two levels used to
  // fill up. 'microblog' spans two categories but sits mostly in one.
  const makeStore = () => [
    ...Array.from({ length: 8 }, (_, i) => node(`b${i}`, ["bluesky", "social-media", "microblog"])),
    ...Array.from({ length: 8 }, (_, i) =>
      node(`m${i}`, i < 2 ? ["mastodon", "social-media", "microblog"] : ["mastodon", "social-media"]),
    ),
    ...Array.from({ length: 6 }, (_, i) => node(`g${i}`, ["gardening", "social-media"])),
    ...Array.from({ length: 14 }, (_, i) => node(`r${i}`, ["reading"])),
  ];

  it("forms sub-groups from shared, category-contained tags", () => {
    const nodes = assignGraphClusters(makeStore());
    expect(byId(nodes, "b0").cluster).toBe("bluesky");
    // 8 of microblog's 10 uses are inside bluesky, so it groups them
    expect(byId(nodes, "b0").sub).toBe("microblog");
  });

  it("rejects cross-cutting tags that mostly live in other categories", () => {
    const nodes = assignGraphClusters(makeStore());
    // microblog: 2 of its 10 uses are in mastodon, well under half -> not a sub-topic
    expect(byId(nodes, "m0").sub).toBeNull();
    // social-media: 8 of its 22 uses are in bluesky -> cross-cutting, never a sub-topic
    expect(byId(nodes, "b0").sub).not.toBe("social-media");
  });

  it("leaves members without a shared sub-topic loose", () => {
    const nodes = assignGraphClusters(makeStore());
    expect(byId(nodes, "g0").sub).toBeNull(); // only a cross-cutting extra tag
    expect(byId(nodes, "r0").sub).toBeNull(); // no extra tags at all
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

describe("filterGraphByActor", () => {
  // Regression: /graph nodes carry actor_name, never actor_id (src/graph/
  // types.ts), the client filter used to compare against actor_id and so
  // never matched anything, hiding the whole canvas behind the empty state
  // for every author selection.
  const nodes = [
    { id: "a", actor_name: "You" },
    { id: "b", actor_name: "Grace Hopper" },
    { id: "c", actor_name: "You" },
    { id: "d", actor_name: null },
  ];
  const edges = [
    { source: "a", target: "b" }, // crosses authors: must not survive either filter
    { source: "a", target: "c" }, // both You: survives the "You" filter
    { source: "b", target: "d" }, // crosses authors: must not survive
  ];

  it("keeps only the named author's nodes and prunes edges that no longer join two survivors", () => {
    const { nodes: n, edges: e } = filterGraphByActor(nodes, edges, "You");
    expect(n.map((x: any) => x.id).sort()).toEqual(["a", "c"]);
    expect(e).toEqual([{ source: "a", target: "c" }]);
  });

  it("matches a teammate's real name the same way", () => {
    const { nodes: n, edges: e } = filterGraphByActor(nodes, edges, "Grace Hopper");
    expect(n.map((x: any) => x.id)).toEqual(["b"]);
    expect(e).toEqual([]);
  });

  it("returns everything unchanged when no name is given", () => {
    expect(filterGraphByActor(nodes, edges, null)).toEqual({ nodes, edges });
    expect(filterGraphByActor(nodes, edges, "")).toEqual({ nodes, edges });
  });

  it("is truly empty, not a crash, when nobody matches", () => {
    const { nodes: n, edges: e } = filterGraphByActor(nodes, edges, "Nobody Here");
    expect(n).toEqual([]);
    expect(e).toEqual([]);
  });
});
