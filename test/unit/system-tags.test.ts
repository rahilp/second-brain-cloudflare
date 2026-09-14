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

  it("drops the old capsule tags when a replacement re-slots the entry", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
      "kind:semantic",
      "old-topic",
    ], ["Capsule:Core", "capsule-slot:preferences", "new-topic"])).toEqual([
      "status:canonical",
      "kind:semantic",
      "Capsule:Core",
      "capsule-slot:preferences",
      "new-topic",
    ]);
  });

  it("drops both capsule namespaces when the replacement names only one of them", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
    ], [" capsule:project:p-1 "])).toEqual([
      "status:canonical",
      "capsule:project:p-1",
    ]);
  });

  it("keeps the capsule tags when the replacement names none", () => {
    expect(applyTagReplacement([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
    ], ["new-topic"])).toEqual([
      "capsule:core",
      "capsule-slot:identity",
      "status:canonical",
      "new-topic",
    ]);
  });
});
