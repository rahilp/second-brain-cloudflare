export const KIND_VALUES = ["episodic", "semantic"] as const;
export type MemoryKind = (typeof KIND_VALUES)[number];
export const KIND_PREFIX = "kind:";

export function getKind(tags: string[]): MemoryKind | null {
  const tag = tags.find(t => t.startsWith(KIND_PREFIX));
  if (!tag) return null;
  const value = tag.slice(KIND_PREFIX.length) as MemoryKind;
  return (KIND_VALUES as readonly string[]).includes(value) ? value : null;
}

export function withKind(tags: string[], kind: MemoryKind): string[] {
  const cleaned = tags.filter(t => !t.startsWith(KIND_PREFIX));
  return [...cleaned, `${KIND_PREFIX}${kind}`];
}
