export const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

export const DUPLICATE_BLOCK_THRESHOLD = 0.95;
export const DUPLICATE_FLAG_THRESHOLD = 0.85;
export const CANDIDATE_SCORE_THRESHOLD = 0.45;
export const TAG_BOOST_STEP = 0.15;
export const TAG_BOOST_MAX = 1.5;
// Each net contradiction (win or loss) shifts a memory's effective importance by
// log1p(|net|) * this step, clamped to the [1,5] importance band. Tunable.
export const CONTRADICTION_IMPORTANCE_STEP = 1.0;

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export const CHUNK_MAX_CHARS = 1600;
export const CHUNK_OVERLAP_CHARS = 200;

export const CLASSIFY_MAX_TOKENS = 80;
export const CONTRADICTION_MAX_TOKENS = 80;
export const SMART_MERGE_MAX_TOKENS = 250;
export const INSIGHT_MAX_TOKENS = 300;
export const PATTERN_MAX_TOKENS = 100;
export const DIGEST_MAX_TOKENS = 400;

export const VECTORIZE_FIX_HINT =
  "run `npx wrangler vectorize create second-brain-vectors --dimensions=384 --metric=cosine`, or grant the build token Vectorize Edit and redeploy";

export const VECTORIZE_TOP_K_MULTIPLIER = 3;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
export const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
export const D1_MAX_BOUND_PARAMS = 100;

export const RRF_K = 60;
export const KEYWORD_CANDIDATE_LIMIT = 100;
export const KEYWORD_MIN_TOKEN_LEN = 2;
export const QUERY_SATURATION_FRACTION = 0.3;
export const MAX_QUERY_TERMS = 3;
export const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);
