import { describe, it, expect } from "vitest";
import { getStatus, withStatus, STATUS_VALUES } from "../../src/index";

describe("status tags", () => {
  describe("getStatus", () => {
    it("returns null for empty tags array", () => {
      expect(getStatus([])).toBe(null);
    });

    it("extracts status from mixed tags", () => {
      expect(getStatus(["work", "status:canonical"])).toBe("canonical");
    });

    it("returns null for unknown status values", () => {
      expect(getStatus(["status:bogus"])).toBe(null);
    });
  });

  describe("withStatus", () => {
    it("adds status tag to tags array", () => {
      expect(withStatus(["work"], "draft")).toEqual(["work", "status:draft"]);
    });

    it("replaces existing status tag without duplicating", () => {
      expect(withStatus(["status:draft", "work"], "deprecated")).toEqual([
        "work",
        "status:deprecated",
      ]);
    });
  });

  describe("STATUS_VALUES", () => {
    it("exports valid status values", () => {
      expect(STATUS_VALUES).toEqual(["canonical", "draft", "deprecated"]);
    });
  });
});
