/**
 * Behaviour-preservation guard for #245.
 *
 * The config layer only stays honest if every DEFAULT equals the constant that
 * currently governs the same behaviour. A silent drift here changes recall or
 * capture for every user who never touched a setting — the exact failure this
 * refactor must not introduce. This test is the tripwire.
 */
import { describe, it, expect } from "vitest";
import { DEFAULTS, RULES } from "../../src/config";
import * as constants from "../../src/constants";
import { RECENCY_FLOOR, RECENCY_FLOOR_DURABLE, RECENCY_FLOOR_VOLATILE, MMR_LAMBDA } from "../../src/recall/math";
import { GRAPH_MAX_HOPS, GRAPH_HOP_DECAY } from "../../src/graph/traverse";
import {
  RECALL_OUTPUT_BUDGET,
  SNIPPET_MAX_CHARS,
  FULL_MATCH_MAX_CHARS,
  RECALL_FULL_MATCHES,
  STRONG_MATCH_RATIO,
} from "../../src/recall/snippet";
import {
  COMPRESSION_IMPORTANCE_THRESHOLD,
  COMPRESSION_MIN_RECALL,
  COMPRESSION_MIN_AGE_MS,
} from "../../src/compression/eligibility";

describe("DEFAULTS parity with shipped constants", () => {
  const cases: [string, unknown, unknown][] = [
    ["RECENCY_FLOOR", DEFAULTS.RECENCY_FLOOR, RECENCY_FLOOR],
    ["RECENCY_FLOOR_DURABLE", DEFAULTS.RECENCY_FLOOR_DURABLE, RECENCY_FLOOR_DURABLE],
    ["RECENCY_FLOOR_VOLATILE", DEFAULTS.RECENCY_FLOOR_VOLATILE, RECENCY_FLOOR_VOLATILE],
    ["MMR_LAMBDA", DEFAULTS.MMR_LAMBDA, MMR_LAMBDA],
    ["DUPLICATE_BLOCK_THRESHOLD", DEFAULTS.DUPLICATE_BLOCK_THRESHOLD, constants.DUPLICATE_BLOCK_THRESHOLD],
    ["DUPLICATE_FLAG_THRESHOLD", DEFAULTS.DUPLICATE_FLAG_THRESHOLD, constants.DUPLICATE_FLAG_THRESHOLD],
    ["GRAPH_MAX_HOPS", DEFAULTS.GRAPH_MAX_HOPS, GRAPH_MAX_HOPS],
    ["GRAPH_HOP_DECAY", DEFAULTS.GRAPH_HOP_DECAY, GRAPH_HOP_DECAY],
    ["RECALL_OUTPUT_BUDGET", DEFAULTS.RECALL_OUTPUT_BUDGET, RECALL_OUTPUT_BUDGET],
    ["SNIPPET_MAX_CHARS", DEFAULTS.SNIPPET_MAX_CHARS, SNIPPET_MAX_CHARS],
    ["FULL_MATCH_MAX_CHARS", DEFAULTS.FULL_MATCH_MAX_CHARS, FULL_MATCH_MAX_CHARS],
    ["RECALL_FULL_MATCHES", DEFAULTS.RECALL_FULL_MATCHES, RECALL_FULL_MATCHES],
    ["STRONG_MATCH_RATIO", DEFAULTS.STRONG_MATCH_RATIO, STRONG_MATCH_RATIO],
    ["COMPRESSION_IMPORTANCE_THRESHOLD", DEFAULTS.COMPRESSION_IMPORTANCE_THRESHOLD, COMPRESSION_IMPORTANCE_THRESHOLD],
    ["COMPRESSION_MIN_RECALL", DEFAULTS.COMPRESSION_MIN_RECALL, COMPRESSION_MIN_RECALL],
    ["COMPRESSION_MIN_AGE_MS", DEFAULTS.COMPRESSION_MIN_AGE_MS, COMPRESSION_MIN_AGE_MS],
    ["KEYWORD_CANDIDATE_LIMIT", DEFAULTS.KEYWORD_CANDIDATE_LIMIT, constants.KEYWORD_CANDIDATE_LIMIT],
    ["SUBSTRING_MATCH_WEIGHT", DEFAULTS.SUBSTRING_MATCH_WEIGHT, constants.SUBSTRING_MATCH_WEIGHT],
    ["TAG_BOOST_STEP", DEFAULTS.TAG_BOOST_STEP, constants.TAG_BOOST_STEP],
    ["TAG_BOOST_MAX", DEFAULTS.TAG_BOOST_MAX, constants.TAG_BOOST_MAX],
    ["CONTRADICTION_IMPORTANCE_STEP", DEFAULTS.CONTRADICTION_IMPORTANCE_STEP, constants.CONTRADICTION_IMPORTANCE_STEP],
    ["LLM_MODEL", DEFAULTS.LLM_MODEL, constants.LLM_MODEL],
    ["EMBEDDING_MODEL", DEFAULTS.EMBEDDING_MODEL, constants.EMBEDDING_MODEL],
  ];

  for (const [name, fromConfig, fromModule] of cases) {
    it(`${name} matches the shipped constant`, () => {
      expect(fromConfig).toBe(fromModule);
    });
  }

  // The split introduced by #245: recall widening used to read
  // DUPLICATE_FLAG_THRESHOLD. It must start life at the same value, or recall
  // widening changes for every existing user.
  it("RECALL_WIDEN_THRESHOLD starts equal to DUPLICATE_FLAG_THRESHOLD", () => {
    expect(DEFAULTS.RECALL_WIDEN_THRESHOLD).toBe(constants.DUPLICATE_FLAG_THRESHOLD);
  });
});

describe("config rule coverage", () => {
  it("every default has a validation rule", () => {
    const missing = Object.keys(DEFAULTS).filter(k => !(k in RULES));
    expect(missing).toEqual([]);
  });

  it("every rule corresponds to a real default", () => {
    const orphans = Object.keys(RULES).filter(k => !(k in DEFAULTS));
    expect(orphans).toEqual([]);
  });

  it("every shipped default satisfies its own rule", () => {
    const violations: string[] = [];
    for (const [key, rule] of Object.entries(RULES)) {
      const v = (DEFAULTS as Record<string, unknown>)[key];
      if (rule.kind === "string") {
        if (typeof v !== "string" || !v.trim()) violations.push(`${key}: not a non-empty string`);
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v)) { violations.push(`${key}: not finite`); continue; }
      if (v < rule.min || v > rule.max) violations.push(`${key}: ${v} outside ${rule.min}–${rule.max}`);
      if (rule.integer && !Number.isInteger(v)) violations.push(`${key}: ${v} is not an integer`);
    }
    expect(violations).toEqual([]);
  });

  it("platform limits are absent from the config surface", () => {
    // Exposing these guarantees breakage rather than risking it: Vectorize
    // rejects >20 ids per call, D1 caps bound params at 100 and refuses an
    // expression tree deeper than 100 (#276).
    for (const forbidden of ["VECTORIZE_GET_BY_IDS_BATCH", "D1_MAX_BOUND_PARAMS", "EDGE_QUERY_BATCH", "KEYWORD_MAX_TOKENS"]) {
      expect(DEFAULTS).not.toHaveProperty(forbidden);
    }
  });
});
