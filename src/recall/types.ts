export interface RecallMatch {
  id: string;
  content: string;
  score: number;
  createdAt: number;
  tags: string[];
  source: string;
  isUpdate: boolean;
  hop: number;
}

export interface RecallSearchResult {
  matches: RecallMatch[];
  insight: string;
  semanticUnavailable: boolean;
  queryUsed?: string;
}

export interface KeywordRow {
  id: string;
  content: string;
  tags: string;
  source: string;
  created_at: number;
}

export type { VectorizeMatch } from "./math";
