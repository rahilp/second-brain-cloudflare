import type { EdgeProvenance, EdgeType } from "../graph/types";
import type { Identity } from "../lib/identity";
import type { EmbeddingQueryMode } from "./query-profile";
import type { RootView } from "./root-selector";

export interface CompoundStaleSignal {
  count: number;
  oldestUpdatedAt: number;
}

export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number;
  staleAsOf?: boolean;
  /** Which layer this memory lives in, so clients can show or act on it. */
  workspace?: "personal" | "company" | "system";
  /** Resolved author label on company-layer matches (shared memories). */
  actorName?: string;
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
  compoundStale?: CompoundStaleSignal;
}

export interface RecallDiagnostics {
  embeddingMode?: EmbeddingQueryMode;
  denseIds?: string[];
  keywordIds?: string[];
  candidateIds?: string[];
  fusedIds?: string[];
  rootSelections?: { id: string; selectedBy: RootView }[];
  expandedIds?: string[];
  eligibleRelatedIds?: string[];
  selectedRelatedIds?: string[];
  finalIds?: string[];
  rejections?: { id: string; reason: string }[];
  operations?: RecallOperationDiagnostics;
  stageMs?: Partial<Record<RecallStage, number>>;
}

export type RecallStage = "setup" | "querySignals" | "candidateGeneration" | "candidateHydration"
  | "graphExpansion" | "finalHydration" | "selection" | "synthesis" | "total";

export interface RecallOperationDiagnostics {
  aiCalls: number;
  embeddingCalls: number;
  vectorizeQueries: number;
  vectorizeGets: number;
  d1Statements: number;
  d1RowsRead: number | null;
  d1RowsWritten: number | null;
  kvReads: number;
  kvWrites: number;
}

export interface RecallInternalOptions {
  embeddingQueryMode?: EmbeddingQueryMode;
  diagnostics?: RecallDiagnostics;
  /**
   * When present, every entries read in the pipeline is scoped to the caller's
   * readable workspaces (personal ∪ company). Absent — internal callers and the
   * pre-tenancy tests — the SQL is exactly what it was before v3.
   */
  identity?: Identity;
  /**
   * Narrows the read to ONE layer of the readable set ("personal" or "company")
   * instead of the union. Only ever narrows: the ids still come from the
   * identity, so this cannot name a workspace the caller does not belong to.
   */
  workspaceFilter?: "personal" | "company";
}

export interface KeywordRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

export type { VectorizeMatch } from "./math";
