export const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Model for `reasonOverPair` (src/insight/reason.ts) only — every other call
 * (classification, contradiction detection, smart merge, digests, recall
 * synthesis) keeps using `LLM_MODEL` above. Insight reasoning is a harder
 * judgment task than any of those: it has to read two memories written
 * months apart and decide whether there is a real, specific tension or
 * connection between them, not just extract or summarize. That deserves a
 * stronger model, but repointing the shared `LLM_MODEL` would change cost
 * and behaviour for five unrelated features for every user, so this is a
 * separate setting instead.
 *
 * Cost, worked from Cloudflare's published Workers AI neuron pricing (one
 * neuron per ~$0.011, at time of writing):
 *
 *   - LLM_MODEL default, @cf/meta/llama-4-scout-17b-16e-instruct:
 *     24,545 neurons/M input tokens, 77,273 neurons/M output tokens.
 *   - @cf/openai/gpt-oss-120b: 31,818 neurons/M input, 68,182 neurons/M output.
 *
 * gpt-oss-120b costs MORE per input token and LESS per output token. This
 * pass's shape (~550 input tokens, 200 output tokens per candidate, from the
 * ENTRY_EXCERPT_CHARS-bounded prompt in reason.ts) is output-light, so the
 * two effects mostly cancel:
 *
 *   scout:   550 * 24545/1e6 + 200 * 77273/1e6 ≈ 13.5 + 15.5 ≈ 29.0 neurons
 *   gpt-oss: 550 * 31818/1e6 + 200 * 68182/1e6 ≈ 17.5 + 13.6 ≈ 31.1 neurons
 *
 * ~7% more neurons for a model with roughly seven times the parameters. The
 * weekly pass reasons over at most WEEKLY_CANDIDATE_LIMIT (10) candidates —
 * see src/insight/weekly.ts — so a full week costs ~311 neurons, about 0.44%
 * of the 10,000-neuron/day free allocation. Re-derive rather than trust this
 * if either model's price or `ENTRY_EXCERPT_CHARS` / `INSIGHT_PASS_MAX_TOKENS`
 * below change.
 */
export const INSIGHT_LLM_MODEL = "@cf/openai/gpt-oss-120b";

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

// Sources that mirror an external system rather than record a thought.
//
// Lives here, not in `integrations/`, because `capture/store.ts` reads it and
// `integrations/mirror.ts` already imports `capture/store.ts` — the dependency
// must not run both ways. `test/unit/store-mirrored-chunks.test.ts` asserts this
// covers every id in INTEGRATION_PROVIDERS, which a test may import from both
// sides freely; that guard exists because the equivalent hand-written list in
// `insight/eligibility.ts` had silently fallen three providers behind.
//
// `git-hook` and `obsidian` are external clients that write memories rather than
// registered providers, so they are named here and cannot be derived.
export const MIRRORED_SOURCES: ReadonlySet<string> = new Set([
  "calendar-google", "calendar-outlook", "calendar-icloud",
  "email-gmail", "email-icloud",
  "notion", "git-hook", "obsidian",
]);
// ── Embedding migration (#248) ───────────────────────────────────────────────
// Budgeted in chunks rather than entries because storeEntry fires one model call
// per chunk, all concurrently: 25 single-chunk entries is already ~75 binding
// calls, and a handful of long memories in one batch would be far more. The
// entry cap is a second ceiling so a page of tiny entries cannot balloon either.
export const MIGRATION_CHUNK_BUDGET = 20;
export const MIGRATION_MAX_ENTRIES_PER_BATCH = 25;

export const CHUNK_OVERLAP_CHARS = 200;

export const CLASSIFY_MAX_TOKENS = 80;
export const CONTRADICTION_MAX_TOKENS = 80;
export const SMART_MERGE_MAX_TOKENS = 250;
export const INSIGHT_MAX_TOKENS = 300;
// max_tokens is a CEILING, not a target. A non-reasoning model stops at its
// own natural answer length well under this cap, so raising it costs that
// model nothing extra. But INSIGHT_LLM_MODEL's default, @cf/openai/gpt-oss-120b,
// is a reasoning model: it spends tokens on chain-of-thought (streamed as
// `delta.reasoning` / `delta.reasoning_content`, see readStreamText in
// src/lib/ai.ts) before it ever emits an answer. At 200 it could burn the
// entire budget thinking and reach the cap without emitting an answer at
// all — the pass would then silently return nothing. 1200 gives it enough
// headroom to finish reasoning and still answer.
export const INSIGHT_PASS_MAX_TOKENS = 1200;
export const DIGEST_MAX_TOKENS = 400;

export const VECTORIZE_FIX_HINT =
  "run `npx wrangler vectorize create second-brain-vectors --dimensions=384 --metric=cosine`, or grant the build token Vectorize Edit and redeploy";

// Durable marker written once, by src/recall/search.ts and src/capture/duplicate.ts,
// the first time this isolate's workspace-filter latch (src/vectorize/scope.ts)
// trips to unsupported. GET /health reads it back so the signal survives isolate
// churn — the in-memory latch alone would look healthy again on every cold start.
export const VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY = "vectorize:workspace-filter-unsupported";

export const VECTORIZE_TOP_K_MULTIPLIER = 3;
// getByIds batch size for tag-scoped recall — Vectorize rejects more than 20 IDs
// per call (VECTOR_GET_ERROR, code 40007)
export const VECTORIZE_GET_BY_IDS_BATCH = 20;
// D1 allows at most 100 bound parameters per query
export const D1_MAX_BOUND_PARAMS = 100;

export const RRF_K = 60;
// Candidate fetch window for the keyword arm. The query is still newest-first
// (LIKE has no relevance ordering), so this bounds how far back a keyword match
// can be found at all — 100 proved able to bury a genuine old match under
// fresher substring noise once a term crossed 100 occurrences.
export const KEYWORD_CANDIDATE_LIMIT = 500;
// IDF fraction granted to a token that matches only as a substring of a longer
// word ("cat" inside "concatenate"). Re-weighting rather than filtering: plural
// and hyphenated near-matches stay retrievable, they just stop outranking
// genuine word-boundary matches.
export const SUBSTRING_MATCH_WEIGHT = 0.25;
export const KEYWORD_MIN_TOKEN_LEN = 2;
// The most LIKE terms this codebase will put into a single D1 statement: the
// frequency scan's SUM columns (distill.ts) and the keyword arm's OR chain
// (search.ts). The keyword arm needs the ceiling because distillToRareTerms
// normally hands it MAX_QUERY_TERMS but two of its exits return the query
// whole, and one of those needs nothing worse than an empty corpus to fire — so
// a fresh install's first long query built a clause D1 rejected outright
// (#276). Both of D1's limits bind at 99 terms: one parameter per term plus the
// row limit against a budget of D1_MAX_BOUND_PARAMS, and an OR chain one
// expression node deep per term against a tree-depth ceiling of 100 (measured:
// 99 terms accepted, 100 rejected on depth first). 16 leaves 6x margin for a
// future predicate, and keeps the two call sites agreeing by construction — the
// widest set the scan ranks is the widest set the clause can carry, so no query
// distillation can rank is ever truncated by the backstop.
export const KEYWORD_MAX_TOKENS = 16;
export const QUERY_SATURATION_FRACTION = 0.3;
export const MAX_QUERY_TERMS = 3;
export const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);
