export const LLM_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/**
 * Escape a literal value before placing it inside a SQL LIKE pattern.
 * Pair the result with LIKE_ESCAPE: without it, backslashes are literal and
 * the pattern matches nothing instead of too much.
 */
export function escapeLikeMeta(value: string): string {
  return value.replace(/([%_\\])/g, "\\$1");
}

/**
 * Pair with every LIKE pattern built using escapeLikeMeta. Without ESCAPE,
 * backslashes are literal and the pattern matches nothing instead of too much.
 */
export const LIKE_ESCAPE = `ESCAPE '\\'`;

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
// Vectorize's per-call ceiling for a Worker upsert.
export const VECTORIZE_UPSERT_BATCH = 1000;
// A write-path neighbor query asks for this many chunk hits and keeps the 5 best distinct notes: one long note can be several hits.
export const WRITE_PATH_TOPK = 20;

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

// Sources that record a conversation rather than a thought — a client pasting
// in the tail of a session. A transcript restates whatever was said, including
// memories the same session stored deliberately, so it will score as a near
// duplicate or a contradiction of them. It must never be the thing that
// rewrites or deprecates a memory another source wrote. Same-source collisions
// (a resumed session superseding its own earlier capture) are still allowed.
//
// Not MIRRORED_SOURCES: those index the first chunk only because the record
// leads with signal and trails with boilerplate; a transcript is the inverse.
// codex-session and cursor-session are the Codex CLI / Cursor session-end
// hooks (integrations/codex-cli-hooks, integrations/cursor-hooks). Deliberate
// MCP writes from those same clients use the plain "codex" / "cursor" source
// and are NOT in this set: sharing a label with the automatic hook would let
// an unattended transcript capture supersede a deliberate memory under the
// same-source exemption below.
export const TRANSCRIPT_SOURCES: ReadonlySet<string> = new Set(["claude-code", "codex-session", "cursor-session"]);

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
// Same reasoning-model headroom as INSIGHT_PASS_MAX_TOKENS above: WHEN_LLM_MODEL
// defaults to the same gpt-oss-120b, which spends tokens on chain-of-thought
// before it answers, and this pass's JSON answer is tiny either way.
export const WHEN_PASS_MAX_TOKENS = 1200;
export const DIGEST_MAX_TOKENS = 400;

// Recall filters on workspace_id, which matches nothing without its metadata index (#394).
export const VECTORIZE_FIX_HINT =
  "run `npx wrangler vectorize create second-brain-vectors --dimensions=384 --metric=cosine` and then `npx wrangler vectorize create-metadata-index second-brain-vectors --propertyName=workspace_id --type=string`, or grant the build token Vectorize Edit and redeploy";

// Shared by REST and MCP recall so the two never diverge in what they claim:
// a failed Vectorize call does not establish WHY it failed, so the assertion
// is neutral and the missing-index diagnosis is offered only as a possibility.
export const SEMANTIC_UNAVAILABLE_DETAIL =
  `This is often temporary; if it persists, the Vectorize index may be missing (fix: ${VECTORIZE_FIX_HINT}).`;

// Durable marker written once, by src/recall/search.ts and src/capture/duplicate.ts,
// the first time this isolate's workspace-filter latch (src/vectorize/scope.ts)
// trips to unsupported. GET /health reads it back so the signal survives isolate
// churn — the in-memory latch alone would look healthy again on every cold start.
export const VECTORIZE_WORKSPACE_FILTER_UNSUPPORTED_KV_KEY = "vectorize:workspace-filter-unsupported";

export const VECTORIZE_TOP_K_MULTIPLIER = 3;
// Dense candidate pool for every recall, whatever topK is asked for, so a larger
// topK only extends the ranked list and never reorders its head. It is what a
// default topK 5 call always used (3 x 5). A weak best match still widens the
// dense query to 50.
export const RECALL_POOL_SIZE = 15;
// The deeper dense list a call draws on when the diversified one is shorter than its topK, and what a weak best
// match widens to. 50 is the most Vectorize returns with values and metadata today (it was 20 until March 2026; this code
// moved to the ceiling with T-0081).
export const RECALL_DEEP_POOL_SIZE = 50;
// Results are ordered by score within blocks of this many MMR picks.
export const RECALL_BLOCK = 5;
// The most results one recall call can ask for (MCP tool and GET /recall both cap topK here).
export const RECALL_MAX_TOP_K = 20;
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

// FTS5 lexical arm. Ready flag set once the backfill has covered every
// pre-FTS row; until then recall stays on the LIKE fallback.
export const FTS_READY_KV_KEY = "fts:ready";
export const FTS_BACKFILL_CURSOR_KV_KEY = "fts:backfill-cursor";
// Per-night ceiling: bounds FTS shadow-row writes against the 100k/day cap.
export const FTS_BACKFILL_BATCH = 2000;
// Trigram tokenizer floor: shorter tokens can never match.
export const FTS_MIN_TOKEN_LENGTH = 3;
// Readiness cache lifetime. Bounds both the KV read rate and how long a warm
// isolate keeps using FTS after the integrity check clears the flag.
export const FTS_READY_CACHE_MS = 5 * 60 * 1000;
// Cross-encoder reranker (src/recall/model-reranker.ts). The readiness latch is
// written only by the model probe: "1" once the model answers in the documented
// shape and ranks a known relevant passage first, "0" after a failed probe.
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
export const RERANK_READY_KV_KEY = "reranker:ready:bge-base-v1";
// A ready verdict is re-proved after a week, a failed one retried after six hours.
export const RERANK_READY_TTL_S = 7 * 24 * 3600;
export const RERANK_NOT_READY_TTL_S = 6 * 3600;
// Warm-isolate cache for the latch, both directions, like FTS_READY_CACHE_MS.
export const RERANK_READY_CACHE_MS = 5 * 60 * 1000;
// One batch: up to 25 direct parents plus up to 5 extra graph-root parents.
export const RERANK_MAX_CANDIDATES = 30;
export const RERANK_MAX_DIRECT = 25;
export const RERANK_EXCERPT_CHARS = 400;
export const RERANK_QUERY_MAX_CHARS = 256;
// Unverified against Workers AI (no account here). The reranker sits on the recall critical path, and the rest of
// a recall (embedding, D1, Vectorize) finishes well under a second, so a batch that has not answered in 1.5 s
// costs more in waiting than a reordering is worth. The circuit breaker below stops paying that wait repeatedly.
export const RERANK_TIMEOUT_MS = 1500;
// Consecutive timeouts or errors in one isolate that latch the reranker off (for RERANK_NOT_READY_TTL_S).
export const RERANK_BREAKER_FAILURES = 3;
// The probe runs off the hot path and may hit a cold model, so it waits longer than a recall does.
export const RERANK_PROBE_TIMEOUT_MS = 15000;
// `auto` reranks only when the runner-up is within this fraction of the leader.
export const RERANK_AMBIGUITY_MARGIN = 0.15;
// A scored parent's heuristic score is scaled by max(floor, 1 + weight * (2p - 1)), p the model's rank percentile
// (1 = best), so nothing is ever multiplied by zero. Only candidates the model saw are reordered: they stay above
// every candidate it did not see (see blendRerankerScores). Weight and floor were chosen on core-1k from the grid
// {0.5, 0.75, 1.0} x {0.25, 0.5} pre-registered in the blend commit.
export const RERANK_BLEND_WEIGHT = 1.0;
export const RERANK_BLEND_FLOOR = 0.25;

// Rows spot-checked nightly for rowid-mapping drift; newest rows move first.
export const FTS_INTEGRITY_SPOT_CHECK = 5;
// Rotating content check: rowid window compared nightly (both directions)
// behind its own cursor, covering every row within ceil(N / window) nights.
export const FTS_CONTENT_CHECK_WINDOW = 200;
// Above this many estimated matches, bm25 must score them all while LIKE
// stops at KEYWORD_CANDIDATE_LIMIT recency-ordered hits, so LIKE is cheaper.
export const FTS_MATCH_BUDGET = 2000;
// Newest rows sampled to estimate a too-short token's df: the index cannot
// count it and the exact LIKE count reads the whole partition.
export const FTS_SHORT_TOKEN_SAMPLE = 200;
export const FTS_CONTENT_CHECK_CURSOR_KV_KEY = "fts:content-check-cursor";
export const KEYWORD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "been",
  "i", "me", "my", "we", "you", "it", "this", "that", "these", "those", "with", "about", "from", "at", "as", "by",
  "do", "did", "does", "what", "when", "where", "who", "whom", "how", "why", "which",
]);

// The scaffolding an agent wraps around a subject ("User wants to X about Y — what should I know?", "tell me all about Y",
// "what have we tried before", "remind me", "help me", "show me", "find"). It says how to ask, not what to find, and a
// brain full of notes about sessions, users and requests holds these words in many rows. Kept out of the keyword terms
// whenever the query has other terms, so a row that only echoes the scaffolding never outranks the one about the subject;
// a query made only of them ("help", "user") still searches for them.
export const QUERY_FRAME_WORDS = new Set([
  "user", "wants", "want", "should", "know", "tried", "tell", "show", "find", "help", "remind", "recommended", "please", "have", "has", "had", "done",
]);

// Function words for the scripts Intl.Segmenter splits without spaces (#326).
// KEYWORD_STOPWORDS never matches them, and without this a Japanese question
// spends its keyword slots on auxiliaries and particles (した, ている, ため)
// that occur in nearly every note. One-character particles (は, を, の) need no
// entry: they fall to KEYWORD_MIN_TOKEN_LEN. Segmenter mis-splits of the most
// common request forms (教えて → 教え|て, ください → くだ|さい) are listed so
// they do not surface as content words.
export const CJK_STOPWORDS = new Set([
  // Japanese
  "した", "して", "する", "します", "しました", "され", "された", "される", "です", "でした", "ます", "ません",
  "ない", "なく", "ある", "あり", "いる", "いた", "ている", "ていた", "なる", "なった", "できる",
  "こと", "もの", "これ", "それ", "あれ", "この", "その", "あの", "ここ", "そこ", "どこ",
  "ため", "から", "まで", "など", "より", "また", "でも", "けど", "ので", "のに", "について", "という",
  "ください", "くだ", "さい", "教えて", "教え", "なぜ", "どう", "どの", "いつ", "だれ", "なに", "ような", "ように",
  // Chinese
  "什么", "怎么", "为什么", "没有", "可以", "一个", "我们", "你们", "他们", "这个", "那个", "这些", "那些",
  "因为", "所以", "但是", "如果", "已经", "还是", "或者", "以及", "关于",
]);

/** The `source` the digest and weekly-insight jobs write; with an empty actor it is how their rows are told from a client's. */
export const SYSTEM_SOURCE = "system";

// ── Sampled recall log (T-0089.5.2 Part A, src/recall/log.ts) ──
// Opt-in via config RECALL_LOG, off by default everywhere (D5.2). At most this many
// recall_log rows written per workspace per day, enforced inside the INSERT's own WHERE
// clause (no KV counter — R12, budget auditor). At 2 D1 rows written per logged recall
// (the insert plus its lazy purge), 200/day is about 400 rows, 0.4% of the 100k/day
// free-plan write cap.
export const RECALL_LOG_PER_DAY = 200;
// How long a logged query is kept before its lazy purge deletes it.
export const RECALL_LOG_RETENTION_DAYS = 30;
// Oldest-expired rows deleted per insert (bounded, not a full-table scan).
export const RECALL_LOG_PURGE_BATCH = 20;
// Part B: a get/append/update/link on an id within this long of a recall that returned it
// counts as implicit feedback on that recall (feeds the golden set only, D5.4).
export const RECALL_LOG_FOLLOW_WINDOW_MS = 30 * 60 * 1000;
// Part C (05-proof.md, T-0089.5.3): the receipt's fallback hash buckets `now` to this width,
// so the same query cited moments apart still hashes to the same short receipt.
export const RECEIPT_TIME_BUCKET_MS = 60 * 1000;

// ── Content versions and trash (4.0, Track 1) ──
/** KV key holding when entry_versions came into being; history before it does not exist. Read through getVersionsSince. */
export const VERSIONS_SINCE_KV_KEY = "versions:since";
/** Versions kept for a mirrored (integration-synced) row that no user has edited. */
export const MIRROR_VERSION_KEEP = 3;
/** Ceiling on trash rows purged after one forget; the version-count read may choose fewer. */
export const TRASH_PURGE_ON_FORGET = 10;
/** Ceiling on trash rows in one nightly purge batch. */
export const TRASH_PURGE_NIGHTLY = 400;
export const TRASH_PURGE_NIGHTLY_MAX_BATCHES = 5;
/** Rows-written target for one purge batch. */
export const TRASH_PURGE_BATCH_ROWS = 5000;
/** Rows-written target for the one purge batch a forget runs. */
export const FORGET_PURGE_ROWS = 1000;
/** One rows-written budget per night, shared by the trash purge and the member-removal resume. */
export const NIGHTLY_CLEANUP_ROWS = 15000;
/** The purge's share of NIGHTLY_CLEANUP_ROWS; the resume gets the rest. */
export const TRASH_PURGE_NIGHTLY_ROWS = 10000;
/** Bottom-up version deletes per chunk for one oversized trash row. */
export const VERSION_DELETE_CHUNK = 2000;
/** Compare-and-set retries for content writers. */
export const WRITE_CAS_ATTEMPTS = 3;
/** Disconnect purge: ids per call, and ids per batch. */
export const DISCONNECT_PURGE_PAGE = 200;
export const DISCONNECT_PURGE_CHUNK = 50;
/** D1's hard row limit, and the budgets that leave 200 KB for growth between a size read and its batch. */
export const D1_ROW_MAX_BYTES = 2_000_000;
export const VERSION_ROW_BUDGET_BYTES = 1_800_000;
export const TRASH_ROW_BUDGET_BYTES = 1_800_000;
/** Member removal: history rows deleted per chunk, chunks per call, removals resumed per night. */
export const MEMBER_HISTORY_CHUNK = 1000;
/** Entry ids per history delete during member removal. */
export const MEMBER_HISTORY_SLICE = 1000;
export const MEMBER_HISTORY_MAX_CHUNKS = 10;
export const MEMBER_REMOVAL_NIGHTLY_MAX = 1;
/**
 * Vector ids deleteEntryVectors checks and deletes in one call, when a caller opts into the cap
 * (FX3 finding 2). At VECTORIZE_GET_BY_IDS_BATCH that is at most 30 getByIds calls plus one
 * deleteByIds — comfortably under the platform's 1,000-subrequest ceiling with room left for
 * everything else the same invocation does, for a removed member's vectors that can run into the
 * tens of thousands.
 */
export const VECTORIZE_DELETE_MAX_IDS_PER_CALL = 600;
/** Undo: a to_version rollback re-creates one row per merge it crosses, but only re-embeds this
 * many inline (AI + Vectorize, one call each) — at VERSION_KEEP's ceiling that could otherwise be
 * hundreds of merges in one request, over the platform's per-invocation service subrequest limit.
 * The rest are written with vector_ids = '[]' for POST /vectorize-pending to backfill. */
export const UNDO_MERGE_REEMBED_INLINE = 25;

// ── Standing memory (4.0, Track 7, T-0089.7.1) ──
// Fixed caps (never user tunables — see src/config.ts for STANDING_THRESHOLD and STANDING_MAX,
// which are eval-tuned / capacity settings and belong in DEFAULTS instead).
/** Firing selection keeps at most this many results (Design 2.7, 2.9). */
export const STANDING_MAX_FIRES = 2;
/** A longer instruction is saved as an ordinary memory instead (Design 2.1, P7.10). */
export const STANDING_MAX_CHARS = 500;
/** A cache older than this is served stale and a rebuild is scheduled (Design 2.4 "Revalidation"). */
export const STANDING_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** KV key prefix; "-" stands for the pre-tenancy "" workspace (Design 2.3). */
export const STANDING_KV_PREFIX = "standing:v1:";
/** Isolate-level read memo and rebuild-scheduling throttle, both windowed the same (Design 2.5). */
export const STANDING_ISOLATE_MEMO_MS = 60_000;
