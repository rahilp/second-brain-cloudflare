import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "public/utils.js"],
      reporter: ["text", "html", "json-summary", "json"],
      reportsDirectory: "coverage",
    },
  },
});
