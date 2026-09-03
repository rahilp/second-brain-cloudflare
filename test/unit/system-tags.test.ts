import { describe, expect, it } from "vitest";
import {
  applyTagReplacement,
  CAPSULE_SLOT_TAG_PREFIX,
  CAPSULE_TAG_PREFIX,
  isWorkerOwnedTag,
} from "../../src/tags/system";

describe("Prompt Capsule system tags", () => {
  it("reserves capsule namespaces case-insensitively", () => {
    expect(isWorkerOwnedTag(`${CAPSULE_TAG_PREFIX}core`)).toBe(true);
    expect(isWorkerOwnedTag("Capsule:Project:p-123")).toBe(true);
    expect(isWorkerOwnedTag(`${CAPSULE_SLOT_TAG_PREFIX}constraints`)).toBe(true);
    expect(isWorkerOwnedTag("CAPSULE-SLOT:CURRENT-STATE")).toBe(true);
  });

  it("preserves capsule definitions when user-editable tags are replaced", () => {
    expect(applyTagReplacement([
      "capsule:project:p-123",
      "capsule-slot:current-state",
      "status:canonical",
      "old-topic",
    ], ["new-topic"])).toEqual([
      "capsule:project:p-123",
      "capsule-slot:current-state",
      "status:canonical",
      "new-topic",
    ]);
  });
});
