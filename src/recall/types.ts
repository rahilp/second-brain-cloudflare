import type { EdgeProvenance, EdgeType } from "../graph/types";

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number;
  // Set only on graph-expanded matches (hop > 0): why / when / whence the edge that surfaced this memory.
  viaProvenance?: EdgeProvenance; // "explicit" (you linked) / "inferred" (auto) / "system"
  viaType?: EdgeType;
  viaLinkedAt?: number;           // when the edge was formed
  viaFrom?: string;               // id of the memory this one was reached from
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
  semanticUnavailable: boolean;
  queryUsed?: string;
  // Distilled query terms, reused to pick a query-relevant excerpt when a long
  // memory has to be shortened for the response.
  queryTokens?: string[];
}

export interface KeywordRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

export type { VectorizeMatch } from "./math";
