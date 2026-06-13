import { describe, it, expect } from "vitest";
import { getKind, withKind, KIND_VALUES } from "../../src/index";

describe("kind tags", () => {
  describe("getKind", () => {
    it("returns null for empty tags array", () => {
      expect(getKind([])).toBe(null);
    });

    it("extracts kind from mixed tags", () => {
      expect(getKind(["work", "kind:episodic"])).toBe("episodic");
    });

    it("returns null for unknown kind values", () => {
      expect(getKind(["kind:bogus"])).toBe(null);
    });
  });

  describe("withKind", () => {
    it("adds kind tag to tags array", () => {
      expect(withKind(["work"], "semantic")).toEqual(["work", "kind:semantic"]);
    });

    it("replaces existing kind tag without duplicating", () => {
      expect(withKind(["kind:episodic", "work"], "semantic")).toEqual([
        "work",
        "kind:semantic",
      ]);
    });
  });

  describe("KIND_VALUES", () => {
    it("exports valid kind values", () => {
      expect(KIND_VALUES).toEqual(["episodic", "semantic"]);
    });
  });
});
