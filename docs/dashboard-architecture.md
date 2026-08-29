# Second Brain Dashboard — module layout

Incremental split of the former monolithic `index.html`. Entry point remains `index.html` (Wrangler static assets).

The one-shot migration script that performed this split was removed after use; do not re-run historical split tooling against the modular tree.

## Layers (load order / dependency rules)

| Layer | Path | May depend on |
|-------|------|----------------|
| Pure | `utils.js` | — (DOM optional via injection) |
| Infra | `js/state.js`, `js/api.js` | pure |
| UI kit | `js/theme.js`, `js/ui-chat.js`, `js/toast.js`, `js/confirm-sheet.js` | pure, state |
| Feature | `js/recall.js`, `recent.js`, `remember.js`, `memory-crud.js`, `settings.js`, `integrations.js`, `graph-canvas.js` | infra, UI kit, pure |
| Shell | `js/nav.js`, `js/auth.js`, `js/app.js` | feature, infra |
| Entry | `index.html` | link/script tags only |

**Never:** pure → feature; feature → `app.js`.

## Script load order

```
utils.js → credits.js → state.js → toast.js → confirm-sheet.js → api.js
→ theme.js → ui-chat.js
→ recall.js → recent.js → remember.js → memory-crud.js
→ settings.js → integrations.js → graph-canvas.js
→ nav.js → auth.js → app.js
```

## Module map (original `index.html` sections)

| Section | Module |
|---------|--------|
| Main CSS (head) | `css/main.css` |
| Graph / view CSS | `css/graph.css` |
| Global state | `js/state.js` |
| Toasts | `js/toast.js` |
| Destructive-action sheet (`openDangerConfirm`) | `js/confirm-sheet.js` |
| Fetch helpers | `js/api.js` |
| Theme toggle | `js/theme.js` |
| Chat bubbles, markdown | `js/ui-chat.js` |
| Recall tab | `js/recall.js` |
| Recent tab | `js/recent.js` |
| Remember tab | `js/remember.js` |
| Append/edit/forget/view/related | `js/memory-crud.js` |
| Menu stats, digest, vectorize, classify, export | `js/settings.js` |
| Integrations sheet | `js/integrations.js` |
| Graph canvas | `js/graph-canvas.js` |
| Tab nav, tag/time filters | `js/nav.js` |
| Auth connect / showApp | `js/auth.js` |
| Sheet listeners, `init()` | `js/app.js` |
| Escaping, graph layout, vectorize banner | `utils.js` (existing) |
| About credits | `credits.js` |

## Tests

Vitest covers `utils.js` (`test/ui/utils.test.ts`, `test/ui/graph-clusters.test.ts`) and dashboard module load order / inline-handler contract (`test/ui/dashboard-modules.test.ts`). Feature modules use classic globals; test pure helpers via `utils.js` dual CJS export.

## Deploy

No build step. Wrangler serves `public/` as static assets; `installer/scripts/bundle-worker.mjs` copies the tree recursively into `worker-dist/assets/`.

## Split status

Completed: all CSS and JS extracted from the monolithic inline blocks. `index.html` is markup + external link/script tags only. Duplicate unused `filterRecent` was dropped during the split (dead code; filtering uses `onTagChange` / `applyRecentFilters`).
