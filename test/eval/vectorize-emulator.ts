type Metadata = Record<string, unknown>;
type Values = number[] | Float32Array | Float64Array;
type Condition = unknown;
type Filter = Record<string, Condition>;
type VectorInput = { id: string; values: Values; metadata?: Metadata; namespace?: string };

interface Entry {
  id: string;
  values: Float32Array;
  norm: number;
  metadata?: Metadata;
}

interface QueryOptions {
  topK?: number;
  filter?: Filter;
  returnMetadata?: boolean | "none" | "indexed" | "all";
  returnValues?: boolean;
  namespace?: string;
}

function norm(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  return Math.sqrt(sum);
}

function validateFilter(filter: Filter | undefined): void {
  if (filter === undefined) return;
  // https://developers.cloudflare.com/vectorize/reference/metadata-filtering/
  if (filter === null || Array.isArray(filter) || typeof filter !== "object" || !Object.keys(filter).length) {
    throw new Error("invalid Vectorize filter: expected a non-empty object");
  }
  const json = JSON.stringify(filter);
  if (!json || new TextEncoder().encode(json).length >= 2048) {
    throw new Error("invalid Vectorize filter: must be smaller than 2048 bytes");
  }
  for (const [field, condition] of Object.entries(filter)) {
    // Dotted keys denote nesting in Vectorize; this product only filters flat fields.
    if (!field || field.startsWith("$") || field.includes(".") || field.includes('"') || field.length > 512) {
      throw new Error(`invalid Vectorize filter key ${field}`);
    }
    if (condition === null || typeof condition !== "object" || Array.isArray(condition)) continue;
    const operators = Object.entries(condition);
    if (!operators.length) throw new Error(`unsupported Vectorize filter for ${field}`);
    for (const [operator, operand] of operators) {
      if (!["$eq", "$ne", "$in", "$nin"].includes(operator)) {
        throw new Error(`unsupported Vectorize filter ${operator} for ${field}`);
      }
      if ((operator === "$in" || operator === "$nin") && !Array.isArray(operand)) {
        throw new Error(`invalid Vectorize filter ${operator} for ${field}`);
      }
    }
  }
}

function filterMatches(metadata: Metadata | undefined, filter: Filter | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([field, condition]) => {
    const value = metadata?.[field];
    if (condition !== null && typeof condition === "object" && !Array.isArray(condition)) {
      const operators = Object.entries(condition);
      return operators.every(([operator, operand]) => {
        switch (operator) {
          case "$eq": return value === operand;
          case "$ne": return value !== undefined && value !== operand;
          case "$in": return (operand as unknown[]).includes(value);
          case "$nin": return value !== undefined && !(operand as unknown[]).includes(value);
          default: return false;
        }
      });
    }
    return value === condition;
  });
}

/** Exact cosine search over float32 vectors. Equal scores sort by ascending ID. */
export class ExactVectorize {
  private readonly entries = new Map<string, Entry>();
  private readonly dimensions: number;
  private readonly maxTopK: number;
  private readonly indexedProperties?: ReadonlySet<string>;
  private mutation = 0;

  constructor(options: { dimensions: number; maxTopK?: number; indexedProperties?: readonly string[] }) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) throw new Error("invalid vector dimension");
    const maxTopK = options.maxTopK ?? 100;
    if (!Number.isInteger(maxTopK) || maxTopK < 1) throw new Error("invalid maxTopK");
    this.dimensions = options.dimensions;
    this.maxTopK = maxTopK;
    // Task 14 checks the production metadata index; unset stays permissive for existing evals.
    this.indexedProperties = options.indexedProperties && new Set(options.indexedProperties);
  }

  /** The same vectors under different metadata indexes, e.g. a brain set up without workspace_id. */
  withMetadataIndexes(indexedProperties: readonly string[]): ExactVectorize {
    const copy = new ExactVectorize({ dimensions: this.dimensions, maxTopK: this.maxTopK, indexedProperties });
    for (const [id, entry] of this.entries) copy.entries.set(id, entry);
    return copy;
  }

  private prepare(vectors: VectorInput[]): Entry[] {
    // https://developers.cloudflare.com/vectorize/platform/limits/
    if (vectors.length > 1000) throw new Error("Vectorize batch exceeds 1000 vectors");
    return vectors.map(vector => {
      if ("namespace" in vector) throw new Error("Vectorize namespace is unsupported by this emulator");
      if (new TextEncoder().encode(vector.id).length > 64) throw new Error(`vector id exceeds 64 bytes`);
      if (vector.metadata && new TextEncoder().encode(JSON.stringify(vector.metadata)).length > 10 * 1024) {
        throw new Error(`vector ${vector.id}: metadata exceeds 10 KiB`);
      }
      if (vector.values.length !== this.dimensions) {
        throw new Error(`vector ${vector.id}: dimension ${vector.values.length} != index ${this.dimensions}`);
      }
      const values = Float32Array.from(vector.values);
      return { id: vector.id, values, norm: norm(values), metadata: vector.metadata && structuredClone(vector.metadata) };
    });
  }

  // Real Vectorize makes writes queryable after an indexing delay; eval reads stay immediate.
  async upsert(vectors: VectorInput[]) {
    for (const entry of this.prepare(vectors)) this.entries.set(entry.id, entry);
    return { mutationId: `m-${++this.mutation}` };
  }

  async insert(vectors: VectorInput[]) {
    const prepared = this.prepare(vectors);
    // https://developers.cloudflare.com/vectorize/reference/client-api/
    // https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/
    for (const entry of prepared) if (!this.entries.has(entry.id)) this.entries.set(entry.id, entry);
    return { mutationId: `m-${++this.mutation}` };
  }

  async deleteByIds(ids: string[]) {
    for (const id of ids) this.entries.delete(id);
    return { mutationId: `m-${++this.mutation}` };
  }

  async getByIds(ids: string[]) {
    return ids.flatMap(id => {
      const entry = this.entries.get(id);
      return entry ? [{ id, values: Array.from(entry.values), ...(entry.metadata && { metadata: structuredClone(entry.metadata) }) }] : [];
    });
  }

  async query(values: Values, options: QueryOptions = {}) {
    if ("namespace" in options) throw new Error("Vectorize namespace is unsupported by this emulator");
    const topK = options.topK ?? 5;
    const ceiling = Math.min(this.maxTopK, options.returnValues || options.returnMetadata === "all" ? 50 : 100);
    if (!Number.isInteger(topK) || topK < 1 || topK > ceiling) {
      throw new Error(`topK ${topK} is outside 1..${ceiling}`);
    }
    if (values.length !== this.dimensions) throw new Error(`query dimension ${values.length} != index ${this.dimensions}`);
    validateFilter(options.filter);
    // Real Vectorize matches nothing on a field with no metadata index rather than erroring (#394).
    if (options.filter && this.indexedProperties && Object.keys(options.filter).some(f => !this.indexedProperties!.has(f))) {
      return { count: 0, matches: [] };
    }
    const probe = Float32Array.from(values);
    const probeNorm = norm(probe);
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of this.entries.values()) {
      if (!filterMatches(entry.metadata, options.filter)) continue;
      let dot = 0;
      for (let i = 0; i < probe.length; i++) dot += probe[i] * entry.values[i];
      scored.push({ entry, score: probeNorm === 0 || entry.norm === 0 ? 0 : dot / (probeNorm * entry.norm) });
    }
    scored.sort((a, b) => b.score - a.score || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    const returnMetadata = options.returnMetadata === true || options.returnMetadata === "all" || options.returnMetadata === "indexed";
    const matches = scored.slice(0, topK).map(({ entry, score }) => ({
      id: entry.id,
      score,
      ...(returnMetadata && entry.metadata && { metadata: options.returnMetadata === "indexed" && this.indexedProperties
        ? Object.fromEntries(Object.entries(entry.metadata).filter(([field]) => this.indexedProperties!.has(field)))
        : structuredClone(entry.metadata) }),
      ...(options.returnValues && { values: Array.from(entry.values) }),
    }));
    return { count: matches.length, matches };
  }

  async describe() { return { dimensions: this.dimensions, vectorCount: this.entries.size }; }
  get size() { return this.entries.size; }
}
