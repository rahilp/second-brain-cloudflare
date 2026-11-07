import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Recall queries Vectorize with a workspace_id filter (src/vectorize/scope.ts). Vectorize answers a
// filter on a property without a metadata index with zero matches, not an error, so a brain set up
// without the index silently loses meaning-based recall.
describe("vectors:create", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

  it("creates the workspace_id metadata index recall filters on", () => {
    expect(scripts["vectors:create"]).toContain("npm run vectors:metadata-index");
    expect(scripts["vectors:metadata-index"]).toBe(
      "wrangler vectorize create-metadata-index second-brain-vectors --propertyName=workspace_id --type=string",
    );
  });

  it("indexes the same property the scoped query filters on", () => {
    const scope = readFileSync("src/vectorize/scope.ts", "utf8");
    expect(scope).toContain("filter: { workspace_id: { $in:");
  });
});
