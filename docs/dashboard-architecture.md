# Second Brain Dashboard — module layout

Incremental split of the former monolithic `index.html`. Entry point remains `index.html` (Wrangler static assets).

The one-shot migration script that performed this split was removed after use; do not re-run historical split tooling against the modular tree.

## Layers (load order / dependency rules)

| Layer | Path | May depend on |
|-------|------|----------------|
| Pure | `utils.js`, `credits.js` | — (DOM optional via injection) |
| Infra | `js/i18n.js`, `js/state.js`, `js/api.js` | pure |
| UI kit | `js/theme.js`, `js/ui-chat.js`, `js/toast.js`, `js/coach.js`, `js/confirm-sheet.js` | pure, state |
| Feature | `js/recall.js`, `js/recent.js`, `js/remember.js`, `js/memory-crud.js`, `js/settings.js`, `js/patterns.js`, `js/stale.js`, `js/integrations.js`, `js/team.js`, `js/activity.js`, `js/graph-canvas.js`, `js/brief.js`, `js/home.js` | infra, UI kit, pure |
| Shell | `js/nav.js`, `js/refresh.js`, `js/auth.js`, `js/download-app.js`, `js/app.js` | feature, infra |
| Entry | `index.html` | link/script tags only |

Every script `index.html` loads appears above, and the chain below is the page's
own order. Both are pinned against `public/index.html` by
`test/ui/dashboard-modules.test.ts` — a table that omits a module is how
`home.js`, the file that sets `TEAM_MODE`, went undocumented while `nav.js`
warned about the ordering hazard it creates.

**Never:** pure → feature; feature → `app.js`.

## Script load order

```
i18n.js → utils.js → credits.js → state.js → toast.js → coach.js
→ confirm-sheet.js → api.js → theme.js → ui-chat.js
→ recall.js → recent.js → remember.js → memory-crud.js
→ settings.js → patterns.js → stale.js → integrations.js → team.js → activity.js
→ graph-canvas.js → brief.js → home.js
→ nav.js → refresh.js → auth.js → download-app.js → app.js
```

`home.js` is the file that sets `TEAM_MODE`, and it loads BEFORE `nav.js` — the
ordering `nav.js` depends on when it reveals the team surfaces. It was missing
from this chain, along with six others, which is why the chain is now checked
against the page rather than maintained by hand.

## Module map (original `index.html` sections)

| Section | Module |
|---------|--------|
| Main CSS (head) | `css/main.css` |
| Graph / view CSS | `css/graph.css` |
| Global state | `js/state.js` |
| Toasts | `js/toast.js` |
| First-run coach marks (`renderCoachMark`) | `js/coach.js` |
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
| Team activity feed (`loadTeamActivity`) | `js/activity.js` |
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
  onConfirm: async (checked, done, progress) => { /* … */ done() },
  onClose: () => { /* reset the caller's own state */ },
})
```

Four rules. Rules 1 and 2 are about the sheet; rules 3 and 4 are the ones that
have actually bitten, and both are about the order you touch your own state in.

**1. The sheet does not close on accept.** The action decides when it is done,
which is what lets it show progress copy on the accept button (`confirmForget`
writes `t('memories.forgetting')` there). Close it yourself, with `done()`.

So every path through your action has to reach `done()`. If none does, nothing
closes the sheet: it stays on screen with its accept button still disabled,
because the sheet releases the double-submit guard when your action resolves
but only re-enables the button when your action *throws*. The user can then
neither accept nor retry — only Cancel or the backdrop gets them out. Leaving
the sheet open on a failure path is a legitimate choice, and `confirmForget`
makes it deliberately so the user can retry after a failed forget;
`disconnectIntegration` takes the other option and closes on both paths,
reporting the failure in a toast. What is never right is falling off the end of
an action without having done either.

**2. Close with the `done()` you were handed — never with `closeConfirm()`.**
`done` is the second argument to `onConfirm`. It is bound by lexical scope to
the question your action is answering, and it does nothing once that question
has been dismissed and replaced. That matters because your POST can resolve
long after the user moved on: without it, a slow disconnect closes — and fires
the `onClose` of — whatever sheet is on screen by then.

The same applies to the words on the accept button, which is why `onConfirm`
gets a third argument. `progress(text)` writes `#confirm-accept-btn` and is
scoped by the same lexical generation, so it goes quiet once your question has
been superseded. **Anything you write to the sheet AFTER an `await` has to go
through it**; a write before your first `await` is on your own question by
definition, which is why `confirmForget`'s single "Forgetting…" is safe written
directly. The bulk layer move is the caller that proves the rule: it writes
"Moving 3 of 3…" from inside a loop, and writing the element directly meant a
batch the user had dismissed went on labelling the *forget* question that
replaced it — "Forget this memory?" under a button reading "Moving 3 of 3…".

`closeConfirm()` takes no argument and closes whatever is currently open. The
rule is about where it is called FROM, not about how many places call it: it is
for ambient dismissals — a caller that genuinely means "close what is on
screen" — and it must never be called from inside an action. It is not scoped,
and nothing in the sheet can make it so: an action can be suspended at an
`await` while another action runs, so there is no "currently running action"
for a module-level variable to hold.

In tree the sheet has seven callers — memory forget and link removal
(`memory-crud.js`), integration disconnect (`integrations.js`), token
rotation, suspension and removal (`team.js`), and the memories list's bulk
layer move (`recent.js`) — and every one of them closes with its `done()`. The
bulk move is the one whose action is long enough for the double-submit guard to
matter in practice: it posts one `/share` per selected row, sequentially, and
closes with the `done()` it was handed after the last of them, never with
`closeConfirm()`. `closeConfirm` itself has four callers, all ambient. Three
are the user dismissing what they can see: the Cancel button in `index.html`,
the backdrop listener in `app.js`, and the Escape handler in
`confirm-sheet.js`. The fourth is `confirmForget`'s `done || closeConfirm`
fallback (`memory-crud.js`), which only takes effect when something invokes
`confirmForget()` directly rather than through the sheet — a test, or Phase 1
code — so it is not an action-internal call either.

The three `team.js` callers were written against an earlier draft of this API
that passed a generation token, and closed ambiently for a release; the bug
that produced was a rotation resolving after its sheet had been replaced,
closing the forget question that replaced it and nulling `pendingForgetId`.
`test/ui/sheet-caller-isolation.test.ts` loads `team.js` and `memory-crud.js`
over one sheet specifically to keep that from coming back: a per-module suite
asserting its own outcomes cannot see damage done to another module's question.

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

**The double-submit guard is per QUESTION, not per caller**, and dismissing a
sheet does not cancel the action it started. So an action long enough to be
dismissed mid-flight owns two things the sheet cannot: stopping itself, and
refusing to start twice. The bulk layer move does both — an `onClose` that sets
a `cancelled` flag its loop checks at the top of every turn, and a
`bulkMoveInFlight` flag it returns early on (and renders its two buttons
disabled from, so it is a held control rather than a dead one). Without them,
Escape mid-batch and a re-confirm ran two loops over the same ids: six POSTs
for three rows, and with opposite targets, two `/share` calls racing over one
row with its final layer decided by whichever response landed last.

`openDangerConfirm` returns the question's generation number. It is there for
tests and logging; it is not how you close, and nothing is load-bearing on it.

**Keyboard and screen reader.** The sheet replaced `confirm()`, which was
Escape-dismissable and announced as a dialog for free, so it restores both
rather than losing them in the swap. `#confirm-dialog` carries `role="dialog"`,
`aria-modal="true"`, `aria-labelledby="confirm-title"`,
`aria-describedby="confirm-body"` and `tabindex="-1"`; opening moves focus onto
it and closing returns focus to whatever invoked it; Escape closes through
`closeConfirm` (the ambient path, same as Cancel) and Tab cycles inside the
sheet. Callers get all of this by using the sheet — there is nothing to opt
into. Covered by `test/ui/confirm-sheet-a11y.test.ts`.

## Tests

Vitest covers `utils.js` (`test/ui/utils.test.ts`, `test/ui/graph-clusters.test.ts`) and dashboard module load order / inline-handler contract (`test/ui/dashboard-modules.test.ts`). Feature modules use classic globals; test pure helpers via `utils.js` dual CJS export.

## Deploy

No build step. Wrangler serves `public/` as static assets; `installer/scripts/bundle-worker.mjs` copies the tree recursively into `worker-dist/assets/`.

## Split status

Completed: all CSS and JS extracted from the monolithic inline blocks. `index.html` is markup + external link/script tags only. Duplicate unused `filterRecent` was dropped during the split (dead code; filtering uses `onTagChange` / `applyRecentFilters`).
