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
openDangerConfirm({
  title, body, confirmLabel,          // already translated
  checkboxLabel,                      // optional modifier; '' or omitted hides the row
  onConfirm: async (checked, done) => { /* … */ done() },
  onClose: () => { /* reset the caller's own state */ },
})
```

Four rules. Rules 1 and 2 are about the sheet; rules 3 and 4 are the ones that
have actually bitten, and both are about the order you touch your own state in.

**1. The sheet does not close on accept.** The action decides when it is done,
which is what lets it show progress copy on the accept button (`confirmForget`
writes `t('memories.forgetting')` there). Close it yourself, with `done()`.

**2. Close with the `done()` you were handed — never with `closeConfirm()`.**
`done` is the second argument to `onConfirm`. It is bound by lexical scope to
the question your action is answering, and it does nothing once that question
has been dismissed and replaced. That matters because your POST can resolve
long after the user moved on: without it, a slow disconnect closes — and fires
the `onClose` of — whatever sheet is on screen by then.

`closeConfirm()` takes no argument and closes whatever is currently open. It is
for the two genuinely ambient dismissals only: the Cancel button in
`index.html` and the backdrop listener in `app.js`. Do not call it from inside
an action. It is not scoped, and nothing in the sheet can make it so — an
action can be suspended at an `await` while another action runs, so there is no
"currently running action" for a module-level variable to hold.

**3. Snapshot your state BEFORE you close.** Closing fires your `onClose`, and
`onClose` is where your state reset lives, so anything you read *after* your own
`done()` reads `null`. `confirmForget` copies `pendingForgetId` and
`pendingForgetCard` into locals as its first act, and depends on that.

**4. Set your pending state AFTER calling `openDangerConfirm`, not before.**
Opening dismisses the sheet it replaces, and that dismissal runs the outgoing
caller's `onClose`. If the sheet being replaced was one of your own, its
`onClose` clears exactly the state you just set. `openConfirm` opens first and
assigns afterwards for this reason.

Two hazards the sheet handles for you, both created by replacing a modal
`confirm()`: a second `runConfirmAction()` while your action is in flight is
dropped and the accept button is held down for the duration (no double POST),
and the button is released again if your action throws. Your action's errors
propagate — the sheet does not swallow them.

`openDangerConfirm` returns the question's generation number. It is there for
tests and logging; it is not how you close, and nothing is load-bearing on it.

## Tests

Vitest covers `utils.js` (`test/ui/utils.test.ts`, `test/ui/graph-clusters.test.ts`) and dashboard module load order / inline-handler contract (`test/ui/dashboard-modules.test.ts`). Feature modules use classic globals; test pure helpers via `utils.js` dual CJS export.

## Deploy

No build step. Wrangler serves `public/` as static assets; `installer/scripts/bundle-worker.mjs` copies the tree recursively into `worker-dist/assets/`.

## Split status

Completed: all CSS and JS extracted from the monolithic inline blocks. `index.html` is markup + external link/script tags only. Duplicate unused `filterRecent` was dropped during the split (dead code; filtering uses `onTagChange` / `applyRecentFilters`).
