import { KEYWORD_MIN_TOKEN_LEN, KEYWORD_STOPWORDS } from "../constants";

// Split a query into lexical search tokens: lowercase, strip surrounding punctuation,
// drop stopwords / 1-char tokens, and remove SQL LIKE wildcards so each token is a literal
// substring. Identifier-shaped tokens (e.g. "v1.9", "#149") are preserved intact.
export function tokenizeQuery(query: string): string[] {
  return [...new Set(
    query.toLowerCase().split(/\s+/)
      .map(t => t.replace(/^[^\w#.]+|[^\w#.]+$/g, "").replace(/[%_]/g, ""))
      .filter(t => t.length >= KEYWORD_MIN_TOKEN_LEN && !KEYWORD_STOPWORDS.has(t))
  )];
}
