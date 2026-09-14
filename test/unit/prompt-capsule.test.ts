import { describe, expect, it } from "vitest";
import { ifNoneMatchMatches, sha256Hex, strongEtag } from "../../src/prompt-capsule/etag";
import { selectPromptCapsuleEntries } from "../../src/prompt-capsule/select";
import { serializePromptCapsule } from "../../src/prompt-capsule/serialize";
import {
  capsuleTag,
  type PromptCapsuleCandidate,
  type PromptCapsuleSection,
} from "../../src/prompt-capsule/types";

const candidate = (
  id: string,
  content: unknown,
  tags: unknown,
): PromptCapsuleCandidate => ({ id, content, tags });

describe("prompt capsule selection", () => {
  it("keeps one canonical entry per slot in fixed order and ignores drafts", () => {
    const selected = selectPromptCapsuleEntries("core", [
      candidate("principles", "Prefer evidence.", ["capsule:core", "capsule-slot:principles", "status:canonical"]),
      candidate("draft", "Not approved.", ["capsule:core", "capsule-slot:identity", "status:draft"]),
      candidate("draft-multi-base", "Still not approved.", [
        "capsule:core", "capsule:project:p1", "capsule-slot:not-a-slot", "status:draft",
      ]),
      candidate("deprecated-wrong-slot", "Old state.", [
        "capsule:core", "capsule-slot:not-a-slot", "status:deprecated",
      ]),
      candidate("identity", "The user prefers concise answers.", ["CAPSULE:CORE", "CAPSULE-SLOT:IDENTITY", "STATUS:CANONICAL"]),
    ]);

    expect(selected.invalidEntries).toEqual([]);
    expect(selected.duplicateSlots).toEqual([]);
    expect(selected.sections.map(section => section.slot)).toEqual(["identity", "principles"]);
    expect(selected.sections.map(section => section.sourceEntryId)).toEqual(["identity", "principles"]);
  });

  it("reports malformed canonical definitions instead of guessing", () => {
    const selected = selectPromptCapsuleEntries("core", [
      candidate("bad-tags", "x", null),
      candidate("multi-base", "x", ["capsule:core", "capsule:project:p1", "capsule-slot:identity", "status:canonical"]),
      candidate("unknown-base", "x", ["capsule:core", "capsule:typo", "capsule-slot:preferences", "status:canonical"]),
      candidate("wrong-base", "x", ["capsule:project:p1", "capsule-slot:identity", "status:canonical"]),
      candidate("two-statuses", "x", ["capsule:core", "capsule-slot:identity", "status:canonical", "status:draft"]),
      candidate("wrong-slot", "x", ["capsule:core", "capsule-slot:current-state", "status:canonical"]),
      candidate("empty", "  ", ["capsule:core", "capsule-slot:constraints", "status:canonical"]),
      // Not trimmed: the SQL prefilter matches the exact quoted tag, so the
      // selector must not accept a padded one the query would have skipped.
      candidate("padded-slot", "x", ["capsule:core", " capsule-slot:identity", "status:canonical"]),
    ]);

    expect(selected.invalidEntries).toEqual([
      { entryId: "bad-tags", reason: "malformed-tags" },
      { entryId: "empty", reason: "empty-content" },
      { entryId: "multi-base", reason: "base-tag-mismatch" },
      { entryId: "padded-slot", reason: "invalid-slot" },
      { entryId: "two-statuses", reason: "invalid-status" },
      { entryId: "unknown-base", reason: "base-tag-mismatch" },
      { entryId: "wrong-base", reason: "base-tag-mismatch" },
      { entryId: "wrong-slot", reason: "invalid-slot" },
    ]);
  });

  it("reports duplicate slots and supports project capsule tags", () => {
    const selected = selectPromptCapsuleEntries("project", [
      candidate("a", "state a", ["capsule:project:p-123", "capsule-slot:current-state", "status:canonical"]),
      candidate("b", "state b", ["capsule:project:p-123", "capsule-slot:current-state", "status:canonical"]),
    ], "p-123");

    expect(selected.sections).toEqual([]);
    expect(selected.duplicateSlots).toEqual([{ slot: "current-state", entryIds: ["a", "b"] }]);
    expect(capsuleTag("project", "p-123")).toBe("capsule:project:p-123");
    expect(() => capsuleTag("project")).toThrow("projectId is required");
  });
});

describe("prompt capsule serialization", () => {
  const identity: PromptCapsuleSection = {
    slot: "identity",
    sourceEntryId: "mem-private-id",
    content: "  First line  \r\nSecond line\t\r\n\r\n",
  };
  const constraints: PromptCapsuleSection = {
    slot: "constraints",
    sourceEntryId: "mem-other-id",
    content: "Never disclose credentials.",
  };

  it("is byte-stable, normalizes line endings, and excludes source metadata from prompt text", () => {
    const a = serializePromptCapsule("core", [constraints, identity]);
    const b = serializePromptCapsule("core", [identity, constraints]);

    expect(a.text).toBe(b.text);
    expect(a.text).not.toContain("mem-private-id");
    expect(a.text).not.toContain("mem-other-id");
    expect(JSON.parse(a.text)).toEqual({
      schema: "prompt-capsule.v1",
      kind: "core",
      sections: [
        { slot: "identity", content: "  First line\nSecond line" },
        { slot: "constraints", content: "Never disclose credentials." },
      ],
    });
    expect(a.complete).toBe(true);
    expect(a.omittedSlots).toEqual([]);
  });

  it("preserves the byte prefix before a changed later slot", () => {
    const before = serializePromptCapsule("core", [identity, constraints]);
    const after = serializePromptCapsule("core", [identity, {
      ...constraints,
      content: "Never disclose credentials or private memory.",
    }]);
    const laterSlot = before.text.indexOf('"slot": "constraints"');

    expect(laterSlot).toBeGreaterThan(0);
    expect(after.text.slice(0, laterSlot)).toBe(before.text.slice(0, laterSlot));
  });

  it("omits whole lower-priority sections instead of cutting an entry", () => {
    const firstOnly = serializePromptCapsule("core", [identity]);
    const bounded = serializePromptCapsule("core", [identity, constraints], firstOnly.charCount);

    expect(bounded.sections.map(section => section.slot)).toEqual(["identity"]);
    expect(bounded.omittedSlots).toEqual(["constraints"]);
    expect(bounded.complete).toBe(false);
    expect(bounded.text).not.toContain("Never disclose credentials");
    expect(bounded.charCount).toBeLessThanOrEqual(firstOnly.charCount);
  });

  it("omits every slot after the first one that does not fit, even a later one that would", () => {
    const withoutMiddle = serializePromptCapsule("core", [identity, constraints]);
    const preferences: PromptCapsuleSection = {
      slot: "preferences",
      sourceEntryId: "mem-preferences",
      content: "p".repeat(withoutMiddle.charCount),
    };
    const bounded = serializePromptCapsule("core", [identity, preferences, constraints], withoutMiddle.charCount);

    expect(bounded.sections.map(section => section.slot)).toEqual(["identity"]);
    expect(bounded.omittedSlots).toEqual(["preferences", "constraints"]);
    expect(bounded.complete).toBe(false);
    expect(bounded.text).not.toContain("Never disclose credentials");
  });

  it("rejects invalid budgets, slots, and duplicate slots", () => {
    expect(() => serializePromptCapsule("core", [], 0)).toThrow(RangeError);
    expect(() => serializePromptCapsule("core", [], 1)).toThrow("smaller than the empty capsule");
    expect(() => serializePromptCapsule("core", [{
      slot: "current-state",
      sourceEntryId: "wrong",
      content: "x",
    }])).toThrow("not valid for a core capsule");
    expect(() => serializePromptCapsule("core", [identity, { ...identity, sourceEntryId: "duplicate" }]))
      .toThrow("appears more than once");
  });
});

describe("prompt capsule hashes", () => {
  it("produces stable SHA-256 hashes and accepts strong, weak, list, and wildcard validators", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const etag = await strongEtag("pcv1", "body");
    expect(etag).toMatch(/^"pcv1-[0-9a-f]{64}"$/);
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
  });
});
