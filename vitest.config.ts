import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // .worktrees/ is where this repo's .gitignore expects git worktrees to live.
    // Without this, a checkout with any worktree present runs the whole suite once
    // per worktree — the counts multiply, and in-progress work in a sibling branch
    // reports as a failure of the branch you are actually on. Excluded rather than
    // relocated because the ignore rule already establishes the location.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "public/utils.js"],
      reporter: ["text", "html", "json-summary", "json"],
      reportsDirectory: "coverage",
    },
  },
});
