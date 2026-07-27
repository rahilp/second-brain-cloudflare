# Second Brain Worker — module layout

Incremental split of the former monolithic `index.ts`. Entry point remains `src/index.ts` (Wrangler `main`).

## Layers (import rules)

| Layer | Path | May import from |
|-------|------|-----------------|
| Pure | `memory/`, `text/`, `recall/math.ts`, `recall/rrf.ts` | `constants.ts` only |
| Infra | `env.ts`, `constants.ts`, `lib/`, `db/` | pure, same layer |
| Domain | `capture/`, `recall/`, `graph/`, `compression/`, `integrations/` | infra, pure, domain peers |
| Edge | `routes/`, `mcp/`, `oauth/` | domain, infra |
| Entry | `index.ts` | edge only (+ wiring) |

**Never:** pure/infra → domain/edge; domain → routes/mcp.

## Module map (original `index.ts` sections)

| Section | Module |
|---------|--------|
| Env, SB_VERSION | `env.ts` |
| Thresholds, models, chunk/vectorize/recall constants | `constants.ts` |
| CORS, json, auth | `lib/http.ts` |
| embed, readStreamText, graceMs | `lib/ai.ts` |
| initializeDatabase | `db/init.ts` |
| status/kind tags | `memory/status.ts`, `memory/kind.ts` |
| compression eligibility | `compression/eligibility.ts` |
| chunk, hashtags, temporal, tokenize | `text/*` |
| cosineSim, rerank, mmr | `recall/math.ts` |
| rrfFuse | `recall/rrf.ts` |
| vectorize health | `vectorize/health.ts` |
| graph edges/traverse/pass | `graph/*` |
| recall search pipeline | `recall/*` |
| capture write path | `capture/*` |
| compression nightly/digest | `compression/*` |
| integration mirror | `integrations/mirror.ts` |
| OAuth pages/register/authorize | `oauth/*` |
| MCP server + sanitize | `mcp/*` |
| REST routes | `routes/*` |
| dbReady | `runtime/state.ts` |

## Tests

Tests import the worker default export only from `src/index`. Functions and types import from domain modules (e.g. `src/capture/entry`, `src/env`).
