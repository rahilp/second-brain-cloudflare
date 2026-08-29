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

## The destructive-action sheet (`js/confirm-sheet.js`)

One `#confirm-dialog` element, parameterised. Every irreversible action in the
dashboard goes through it; there is deliberately no second sheet, because two
would diverge the first time either was restyled.

```js
const token = openDangerConfirm({
  title, body, confirmLabel,          // already translated
  checkboxLabel,                      // optional modifier; '' or omitted hides the row
  onConfirm: async (checked, token) => { /* … */ closeConfirm(token) },
  onClose: () => { /* reset the caller's own state */ },
})
```

Three rules a caller has to know. The first two are enforced by the sheet, so
forgetting them is safe; the third is not, and is the one that bites.

**1. The sheet does not close on accept.** The action decides when it is done,
which is what lets it show progress copy on the accept button (`confirmForget`
writes `t('memories.forgetting')` there). Call `closeConfirm(token)` yourself.

**2. Pass the token, and treat a close as scoped.** `openDangerConfirm` returns
a generation, and `onConfirm` receives the same value as its second argument.
`closeConfirm(token)` is a **no-op** if that question has since been dismissed
and replaced — without this, a slow POST resolving after the user moved on
closes, and fires the `onClose` of, whatever question is on screen now. A close
with no token made from inside a running action is scoped to that action
anyway, so a caller that forgets is still safe; `closeConfirm()` from the
backdrop or the Cancel button is unscoped, which is what a user dismissing what
they can see means.

**3. Snapshot caller state BEFORE you close.** `closeConfirm` fires your
`onClose`, and `onClose` is where your state reset lives — so anything you read
*after* your own close reads `null`. `confirmForget` copies `pendingForgetId`
and `pendingForgetCard` into locals as its first act, and depends on that.
For the same reason, set your pending state **after** calling
`openDangerConfirm`, not before: opening dismisses the sheet it replaces, and
if that was a sheet of the same kind, its `onClose` would clear the state you
just set (see `openConfirm`).

Two hazards the sheet handles for you, both created by replacing a modal
`confirm()`: a second `runConfirmAction()` while your action is in flight is
dropped and the accept button is held down for the duration (no double POST),
and the button is released again if your action throws. Your action's errors
propagate — the sheet does not swallow them.

## Tests

Vitest covers `utils.js` (`test/ui/utils.test.ts`, `test/ui/graph-clusters.test.ts`) and dashboard module load order / inline-handler contract (`test/ui/dashboard-modules.test.ts`). Feature modules use classic globals; test pure helpers via `utils.js` dual CJS export.

## Deploy

No build step. Wrangler serves `public/` as static assets; `installer/scripts/bundle-worker.mjs` copies the tree recursively into `worker-dist/assets/`.

## Split status

Completed: all CSS and JS extracted from the monolithic inline blocks. `index.html` is markup + external link/script tags only. Duplicate unused `filterRecent` was dropped during the split (dead code; filtering uses `onTagChange` / `applyRecentFilters`).
