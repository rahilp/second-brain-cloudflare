/**
 * Runtime config layer (#245).
 *
 * `DEFAULTS` is the shipped behaviour. A sparse override blob in KV under
 * `config:overrides` carries only the keys a user has actually changed, so a
 * tuned default in a later release still reaches anyone who never overrode it,
 * and a per-key reset is a `delete` rather than a rewrite.
 *
 * Reads are per-request and uncached on purpose. Recall already makes an
 * embedding call and several D1 queries, so one KV read is noise; a
 * version-counter cache would leave a window where a stale isolate serves the
 * previous value after a save, which presents to the user as a control that
 * does nothing.
 */
import type { Env } from "./env";

// Prefixed to coexist with workers-oauth-provider's token:/grant:/client: keys
// and the integrations: blobs in the same namespace.
export const CONFIG_KEY = "config:overrides";

export const DEFAULTS = {
  // ── Ranking (src/recall/math.ts) ──
  RECENCY_FLOOR: 0.6,
  RECENCY_FLOOR_DURABLE: 0.9,
  RECENCY_FLOOR_VOLATILE: 0.15,
  MMR_LAMBDA: 0.7,

  // ── Duplicate detection (src/capture/duplicate.ts) ──
  DUPLICATE_BLOCK_THRESHOLD: 0.95,
  DUPLICATE_FLAG_THRESHOLD: 0.85,

  // ── Recall widening (src/recall/search.ts) ──
  RECALL_WIDEN_THRESHOLD: 0.85,

  // ── Graph expansion (src/graph/traverse.ts) ──
  GRAPH_MAX_HOPS: 3,
  GRAPH_HOP_DECAY: 0.6,

  // ── Output budgeting (src/recall/snippet.ts) ──
  RECALL_OUTPUT_BUDGET: 12000,
  SNIPPET_MAX_CHARS: 400,
  FULL_MATCH_MAX_CHARS: 4000,
  RECALL_FULL_MATCHES: 2,
  STRONG_MATCH_RATIO: 0.75,

  // ── Compression eligibility (src/compression/eligibility.ts) ──
  COMPRESSION_IMPORTANCE_THRESHOLD: 4,
  COMPRESSION_MIN_RECALL: 2,
  COMPRESSION_MIN_AGE_MS: 60 * 86400000,

  // ── Capture tuning (src/constants.ts) ──
  TAG_BOOST_STEP: 0.15,
  TAG_BOOST_MAX: 1.5,
  CONTRADICTION_IMPORTANCE_STEP: 1.0,

  // ── Models (src/lib/ai.ts) ──
  LLM_MODEL: "@cf/meta/llama-4-scout-17b-16e-instruct",
  EMBEDDING_MODEL: "@cf/baai/bge-small-en-v1.5",
} as const;

// DEFAULTS is `as const` so the shipped values are pinned and a typo shows up
// as a type error. Config must widen those literals back to number/string,
// though — without this, `Partial<Config>` would only accept the exact default
// value and reject every real override.
type Widen<T> = T extends number ? number : T extends string ? string : T;

export type Config = { -readonly [K in keyof typeof DEFAULTS]: Widen<(typeof DEFAULTS)[K]> };
export type ConfigKey = keyof Config;

type Rule =
  | { kind: "number"; min: number; max: number; integer?: boolean }
  | { kind: "string" };

/**
 * Accepted shape and range per key. Enforced at resolve time rather than only
 * at write, because values also arrive from hand-edited KV, from blobs written
 * by an older release, and from ranges tightened in a later one.
 */
export const RULES: Record<ConfigKey, Rule> = {
  RECENCY_FLOOR: { kind: "number", min: 0, max: 1 },
  RECENCY_FLOOR_DURABLE: { kind: "number", min: 0, max: 1 },
  RECENCY_FLOOR_VOLATILE: { kind: "number", min: 0, max: 1 },
  MMR_LAMBDA: { kind: "number", min: 0, max: 1 },

  DUPLICATE_BLOCK_THRESHOLD: { kind: "number", min: 0, max: 1 },
  DUPLICATE_FLAG_THRESHOLD: { kind: "number", min: 0, max: 1 },
  RECALL_WIDEN_THRESHOLD: { kind: "number", min: 0, max: 1 },

  // Hops above 3 explode the fanout without improving results; traverse.ts is
  // written against this ceiling.
  GRAPH_MAX_HOPS: { kind: "number", min: 0, max: 3, integer: true },
  GRAPH_HOP_DECAY: { kind: "number", min: 0, max: 1 },

  RECALL_OUTPUT_BUDGET: { kind: "number", min: 1000, max: 100000, integer: true },
  SNIPPET_MAX_CHARS: { kind: "number", min: 100, max: 4000, integer: true },
  FULL_MATCH_MAX_CHARS: { kind: "number", min: 500, max: 20000, integer: true },
  RECALL_FULL_MATCHES: { kind: "number", min: 0, max: 10, integer: true },
  STRONG_MATCH_RATIO: { kind: "number", min: 0, max: 1 },

  // Importance is a 1–5 band; a threshold outside it protects everything or
  // nothing.
  COMPRESSION_IMPORTANCE_THRESHOLD: { kind: "number", min: 1, max: 5, integer: true },
  COMPRESSION_MIN_RECALL: { kind: "number", min: 0, max: 100, integer: true },
  COMPRESSION_MIN_AGE_MS: { kind: "number", min: 0, max: 10 * 365 * 86400000, integer: true },

  TAG_BOOST_STEP: { kind: "number", min: 0, max: 1 },
  TAG_BOOST_MAX: { kind: "number", min: 1, max: 5 },
  CONTRADICTION_IMPORTANCE_STEP: { kind: "number", min: 0, max: 5 },

  LLM_MODEL: { kind: "string" },
  EMBEDDING_MODEL: { kind: "string" },
};

/**
 * Groups that must stay internally ordered. A violation is not clamped
 * key-by-key — that could satisfy the letter of the range while still leaving
 * the group inverted — so the whole group falls back to its defaults, which
 * satisfy the invariant by construction.
 */
const INVARIANTS: { keys: ConfigKey[]; holds: (c: Config) => boolean; describe: string }[] = [
  {
    keys: ["DUPLICATE_BLOCK_THRESHOLD", "DUPLICATE_FLAG_THRESHOLD"],
    holds: c => c.DUPLICATE_BLOCK_THRESHOLD > c.DUPLICATE_FLAG_THRESHOLD,
    describe: "DUPLICATE_BLOCK_THRESHOLD must exceed DUPLICATE_FLAG_THRESHOLD, or flagging is unreachable",
  },
  {
    keys: ["RECENCY_FLOOR_VOLATILE", "RECENCY_FLOOR", "RECENCY_FLOOR_DURABLE"],
    holds: c => c.RECENCY_FLOOR_VOLATILE <= c.RECENCY_FLOOR && c.RECENCY_FLOOR <= c.RECENCY_FLOOR_DURABLE,
    describe: "RECENCY_FLOOR_VOLATILE <= RECENCY_FLOOR <= RECENCY_FLOOR_DURABLE, or durability tiering inverts",
  },
];

/**
 * Coerces one stored value against its rule. Returns the default when the
 * value is unsalvageable (wrong type, non-finite); clamps when it is merely
 * out of range.
 */
export function coerce(key: ConfigKey, value: unknown): { value: Config[ConfigKey]; note?: string } {
  const rule = RULES[key];
  const fallback = DEFAULTS[key] as Config[ConfigKey];

  if (rule.kind === "string") {
    if (typeof value !== "string" || value.trim() === "") {
      return { value: fallback, note: `${key}: expected a non-empty string, got ${typeof value}` };
    }
    return { value: value as Config[ConfigKey] };
  }

  // typeof NaN and typeof Infinity are both "number", so the finite check is
  // what actually protects arithmetic downstream.
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { value: fallback, note: `${key}: expected a finite number, got ${JSON.stringify(value)}` };
  }

  let n = value;
  if (rule.integer) n = Math.round(n);
  const clamped = Math.min(rule.max, Math.max(rule.min, n));
  const note = clamped !== n ? `${key}: ${n} clamped to ${clamped} (range ${rule.min}–${rule.max})` : undefined;
  return { value: clamped as Config[ConfigKey], note };
}

export const INVARIANT_RULES = INVARIANTS;

/**
 * Reads the sparse override blob and merges it over the defaults.
 *
 * Every failure mode here degrades to the shipped defaults rather than
 * throwing: a KV outage, a hand-edited blob, or a payload written by a future
 * version must never be able to take recall down.
 */
export async function resolveConfig(env: Env): Promise<Readonly<Config>> {
  const resolved: Config = { ...DEFAULTS };

  let stored: unknown;
  try {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY);
    if (!raw) return Object.freeze(resolved);
    stored = JSON.parse(raw);
  } catch {
    // KV unreachable or the blob is unparseable — ship the defaults.
    return Object.freeze(resolved);
  }

  if (!isRecord(stored)) return Object.freeze(resolved);

  const notes: string[] = [];

  for (const [key, value] of Object.entries(stored)) {
    // Unknown keys are ignored rather than carried through: they may be a
    // setting removed in a later release, or a typo in a hand-edited blob.
    if (!(key in DEFAULTS)) continue;
    const { value: safe, note } = coerce(key as ConfigKey, value);
    (resolved as Record<string, unknown>)[key] = safe;
    if (note) notes.push(note);
  }

  for (const invariant of INVARIANTS) {
    if (invariant.holds(resolved)) continue;
    for (const key of invariant.keys) {
      (resolved as Record<string, unknown>)[key] = DEFAULTS[key];
    }
    notes.push(`invariant violated, group reset to defaults — ${invariant.describe}`);
  }

  if (notes.length) console.warn(`[config] ${notes.join("; ")}`);

  return Object.freeze(resolved);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ── Write path ───────────────────────────────────────────────────────────────
//
// Deliberately stricter than resolve. A bad value arriving from KV is repaired,
// because recall must not fail on it. A bad value arriving from a caller is
// rejected with a message naming the conflict, so the settings UI can explain
// what happened rather than appear to accept a change and silently discard it.

export type WriteResult = { ok: true } | { ok: false; error: string };

/** Reads the raw sparse blob. Any failure reads as "no overrides". */
export async function readOverrides(env: Env): Promise<Partial<Config>> {
  try {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) if (k in DEFAULTS) out[k] = v;
    return out as Partial<Config>;
  } catch {
    return {};
  }
}

/** Strict per-key check. Returns an error message, or null when acceptable. */
function validateStrict(key: string, value: unknown): string | null {
  if (!(key in DEFAULTS)) return `${key} is not a known setting`;
  const rule = RULES[key as ConfigKey];

  if (rule.kind === "string") {
    return typeof value === "string" && value.trim() !== ""
      ? null
      : `${key} must be a non-empty string`;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${key} must be a finite number`;
  }
  if (rule.integer && !Number.isInteger(value)) {
    return `${key} must be a whole number`;
  }
  if (value < rule.min || value > rule.max) {
    return `${key} must be between ${rule.min} and ${rule.max} (got ${value})`;
  }
  return null;
}

/**
 * Merges a patch into the stored overrides. Rejects the whole patch if any key
 * is unknown, malformed, or would invert an invariant once merged with what is
 * already stored — a value can be individually valid and still break the pair.
 */
export async function writeOverrides(env: Env, patch: Partial<Config>): Promise<WriteResult> {
  for (const [key, value] of Object.entries(patch)) {
    const error = validateStrict(key, value);
    if (error) return { ok: false, error };
  }

  const merged = { ...(await readOverrides(env)), ...patch } as Record<string, unknown>;
  const effective = { ...DEFAULTS, ...merged } as Config;

  for (const invariant of INVARIANTS) {
    if (!invariant.holds(effective)) return { ok: false, error: invariant.describe };
  }

  // Values equal to the shipped default are dropped rather than stored. Storing
  // them would pin the user to today's number and stop a retuned default in a
  // later release from ever reaching them.
  const sparse: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (value !== DEFAULTS[key as ConfigKey]) sparse[key] = value;
  }

  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(sparse));
  return { ok: true };
}

/**
 * Per-setting reset. A delete rather than a write-back of the default, so the
 * user rejoins the shipped value and picks up any future retune of it.
 */
export async function resetOverride(env: Env, key: ConfigKey): Promise<void> {
  const overrides = { ...(await readOverrides(env)) } as Record<string, unknown>;
  if (!(key in overrides)) return;
  delete overrides[key];
  await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(overrides));
}
