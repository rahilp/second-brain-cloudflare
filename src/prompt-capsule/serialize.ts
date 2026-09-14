import {
  PROMPT_CAPSULE_MAX_CHARS,
  PROMPT_CAPSULE_SCHEMA,
  slotsForKind,
  type PromptCapsuleKind,
  type PromptCapsuleSection,
  type PromptCapsuleSlot,
  type SerializedPromptCapsule,
} from "./types";

function normalizeContent(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n").map(line => line.replace(/[ \t]+$/g, ""));
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function render(kind: PromptCapsuleKind, sections: readonly PromptCapsuleSection[]): string {
  return JSON.stringify({
    schema: PROMPT_CAPSULE_SCHEMA,
    kind,
    sections: sections.map(section => ({
      slot: section.slot,
      content: section.content,
    })),
  }, null, 2);
}

/**
 * Serialize a capsule into a byte-stable prompt prefix.
 *
 * Source ids and mutable metadata stay outside the prompt text. Sections are
 * emitted in the contract's fixed slot order, line endings and trailing spaces
 * are normalized, and a section is either included whole or omitted whole.
 */
export function serializePromptCapsule(
  kind: PromptCapsuleKind,
  inputSections: readonly PromptCapsuleSection[],
  maxChars = PROMPT_CAPSULE_MAX_CHARS,
): SerializedPromptCapsule {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new RangeError("maxChars must be a positive safe integer");
  }

  const orderedSlots = slotsForKind(kind);
  const slotOrder = new Map(orderedSlots.map((slot, index) => [slot, index]));
  const seen = new Set<PromptCapsuleSlot>();
  const normalized = inputSections.map(section => {
    if (!slotOrder.has(section.slot)) {
      throw new TypeError(`Slot ${section.slot} is not valid for a ${kind} capsule`);
    }
    if (seen.has(section.slot)) {
      throw new TypeError(`Slot ${section.slot} appears more than once`);
    }
    seen.add(section.slot);
    return { ...section, content: normalizeContent(section.content) };
  }).sort((a, b) => slotOrder.get(a.slot)! - slotOrder.get(b.slot)!);

  const emptyText = render(kind, []);
  if (emptyText.length > maxChars) {
    throw new RangeError("maxChars is smaller than the empty capsule representation");
  }

  // Once a slot does not fit, every later slot is omitted too, even one small
  // enough to fit on its own. The emitted sections are therefore always a
  // prefix of the full priority order, never a subset chosen by size.
  const included: PromptCapsuleSection[] = [];
  let omittedSlots: PromptCapsuleSlot[] = [];
  for (let index = 0; index < normalized.length; index++) {
    const next = [...included, normalized[index]];
    if (render(kind, next).length > maxChars) {
      omittedSlots = normalized.slice(index).map(section => section.slot);
      break;
    }
    included.push(normalized[index]);
  }

  const text = render(kind, included);
  return {
    text,
    sections: included,
    omittedSlots,
    complete: omittedSlots.length === 0,
    charCount: text.length,
    maxChars,
  };
}
