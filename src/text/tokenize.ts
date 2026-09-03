import { CJK_STOPWORDS, KEYWORD_MIN_TOKEN_LEN, KEYWORD_STOPWORDS } from "../constants";

// A chunk that is 7-bit ASCII never reaches the segmenter: it runs the pre-#326
// pipeline verbatim, which is what keeps every existing query's tokens
// byte-identical. Only text that needs Unicode handling gets Unicode handling.
const ASCII_ONLY = /^[\x00-\x7F]*$/;
const HAN = /\p{Script=Han}/u;
const LIKE_WILDCARDS = /[%_]/g;

let segmenter: Intl.Segmenter | undefined;
function wordsOf(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out: string[] = [];
  for (const s of segmenter.segment(text)) if (s.isWordLike) out.push(s.segment);
  return out;
}

// The pre-#326 pipeline for one whitespace-delimited chunk: lowercase, trim
// surrounding punctuation, strip LIKE wildcards, drop stopwords and 1-char
// tokens. Identifier-shaped chunks ("v1.9", "#149", URLs, paths) survive whole
// because only their edges are trimmed.
function asciiToken(chunk: string): string | null {
  const t = chunk.toLowerCase().replace(/^[^\w#.]+|[^\w#.]+$/g, "").replace(LIKE_WILDCARDS, "");
  return t.length >= KEYWORD_MIN_TOKEN_LEN && !KEYWORD_STOPWORDS.has(t) ? t : null;
}

// Split a query into lexical search tokens (#326). Canonical tokens first, in
// source order; raw-surface probes last, so every capped consumer drops a probe
// before it drops a real term.
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  const singleHan: string[] = [];
  const probes: string[] = [];
  for (const chunk of query.split(/\s+/)) {
    if (!chunk) continue;
    if (ASCII_ONLY.test(chunk)) {
      const t = asciiToken(chunk);
      if (t) tokens.push(t);
      continue;
    }
    const folded = chunk.normalize("NFKC");
    if (folded !== chunk) {
      // D1 stores the original surface and SQLite's LIKE folds ASCII case only,
      // so the chunk exactly as typed is the one term that can reach content
      // saved in its compatibility form. Lowercased by every in-process matcher
      // (fusion, coverage, snippets), never here.
      const probe = chunk.replace(LIKE_WILDCARDS, "");
      if (probe.length >= KEYWORD_MIN_TOKEN_LEN) probes.push(probe);
    }
    if (ASCII_ONLY.test(folded)) {
      const t = asciiToken(folded);
      if (t) tokens.push(t);
      continue;
    }
    for (const word of wordsOf(folded)) {
      const t = word.toLowerCase().replace(LIKE_WILDCARDS, "");
      if (!t || KEYWORD_STOPWORDS.has(t) || CJK_STOPWORDS.has(t)) continue;
      if (t.length >= KEYWORD_MIN_TOKEN_LEN) tokens.push(t);
      else if (HAN.test(t)) singleHan.push(t);
    }
  }
  // A query that is nothing but a lone ideograph (夢) still has to reach the
  // keyword arm. Anywhere else a lone ideograph is a counter or date particle
  // (年, 月) that would only flood the candidate window.
  const ordered = tokens.length ? tokens : singleHan;
  return [...new Set([...ordered, ...probes])];
}
