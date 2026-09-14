// The "Advanced Settings" window (#246) - the only place Second Brain's
// behaviour can be tuned. The Worker stores and reads config; this app is its
// only writer, which is why there is deliberately no settings UI in the
// dashboard.
//
// Six controls are named levels rather than sliders: each moves two or three
// config keys that must stay coherent, and two pairs carry invariants the
// Worker resets wholesale if crossed. Offering independent sliders would let a
// user produce a config that silently snaps back.
//
// Edits are STAGED, not written on change. These settings alter how recall
// behaves, so a mis-click must not silently retune the user's brain - nothing
// reaches the Worker until Save, and Cancel discards the batch.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { h } from "./shared";
import { LOCALE_CHANGE_EVENT, getLocale, initI18n, t } from "./i18n";
import "./style.css";

type ControlView = {
  id: string;
  levels: string[];
  /** null when the stored config matches no level - shown as "Custom". */
  level: string | null;
  defaultLevel: string;
  forwardOnly: boolean;
};

type SettingsView = {
  controls: ControlView[];
  llmModel: string;
  /** Used only when reasoning over a pair of memories to draw an insight. */
  insightLlmModel: string;
  /** Shared by both model dropdowns. */
  llmModels: string[];
};

/** A control's staged state: pick a level, or reset it to the shipped default. */
type Staged = { kind: "level"; id: string } | { kind: "reset" };

/**
 * Left-rail sections, mirroring the Connections window. Only the active pane
 * renders - seven controls stacked in one column was a long scroll, and the
 * grouping is what tells a user whether a setting affects recall or capture.
 *
 * "ai" holds the two model dropdowns rather than level controls, so it has no
 * entry in `controls`; "matching" holds the rebuild flow (#248) the same way.
 * "matching" is last because it is the only pane that can start something
 * destructive.
 */
type SectionId = "recall" | "remember" | "ai" | "matching";

const SECTIONS: {
  id: SectionId;
  labelKey: "sectionRecall" | "sectionRemember" | "sectionAi" | "sectionMatching";
  controls: string[];
}[] = [
  { id: "recall", labelKey: "sectionRecall", controls: ["recency", "variety", "connections", "detail"] },
  { id: "remember", labelKey: "sectionRemember", controls: ["duplicates", "compression"] },
  { id: "ai", labelKey: "sectionAi", controls: [] },
  { id: "matching", labelKey: "sectionMatching", controls: [] },
];

/** Recall is the default pane. */
let active: SectionId = "recall";

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Last state read from the Worker - the baseline every diff is taken against. */
let saved: SettingsView | null = null;
/** Staged edits, keyed by control id. Empty means nothing to save. */
let staged = new Map<string, Staged>();
let stagedModel: string | null = null;
let stagedInsightModel: string | null = null;
let busy = false;
let message: { text: string; kind: "ok" | "error" } | null = null;

/** Tauri hands string errors through as strings and everything else as objects. */
function errorText(e: unknown): string {
  return typeof e === "string" ? e : String(e);
}

/** Numbers in copy: 12,480 in English, 12.480 in Italian. */
function num(n: number): string {
  return n.toLocaleString(getLocale());
}

/**
 * Inputs are frozen both while a Save is in flight and while a rebuild (#248)
 * is running. Saving other keys mid-rebuild is harmless on the Worker's side,
 * but a live Cancel button next to a running rebuild reads as "cancel that".
 */
function locked(): boolean {
  return busy || migrationBusy();
}

/** What a control shows right now: its staged value if edited, else saved. */
function effectiveLevel(c: ControlView): string | null {
  const s = staged.get(c.id);
  if (!s) return c.level;
  return s.kind === "reset" ? c.defaultLevel : s.id;
}

function isDirty(): boolean {
  return staged.size > 0 || stagedModel !== null || stagedInsightModel !== null;
}

function stage(controlId: string, next: Staged, c: ControlView): void {
  // Staging back to the saved value is not a change - drop it so Save stays
  // disabled and the count stays honest.
  const backToSaved =
    (next.kind === "level" && next.id === c.level) ||
    (next.kind === "reset" && c.level === c.defaultLevel);
  if (backToSaved) staged.delete(controlId);
  else staged.set(controlId, next);
  message = null;
  render();
}

function discard(): void {
  staged = new Map();
  stagedModel = null;
  stagedInsightModel = null;
  message = null;
  render();
}

async function save(): Promise<void> {
  if (locked() || !isDirty()) return;
  busy = true;
  message = null;
  render();
  try {
    const levels: [string, string][] = [];
    const resets: string[] = [];
    for (const [id, s] of staged) {
      if (s.kind === "reset") resets.push(id);
      else levels.push([id, s.id]);
    }
    // The command returns the freshly re-read view: the Worker clamps and
    // invariant-checks on resolve, so what it stored may differ from what was
    // asked for. Rendering the request would show a state the brain is not in.
    saved = await invoke<SettingsView>("save_brain_settings", {
      levels,
      resets,
      model: stagedModel,
      insightModel: stagedInsightModel,
    });
    staged = new Map();
    stagedModel = null;
    stagedInsightModel = null;
    message = { text: t("settingsPanel.saved"), kind: "ok" };
  } catch (e) {
    // The Worker's message names the offending key or the invariant it
    // crosses; it is the only thing that tells the user what went wrong. The
    // staged edits are kept so nothing chosen is lost on a rejection.
    message = { text: typeof e === "string" ? e : String(e), kind: "error" };
  } finally {
    busy = false;
    render();
  }
}

/* ── Rebuilding how memories are read (#248) ─────────────────────────────────
 *
 * Every other control here is a staged radio pick that Save writes. This one is
 * a sequence of Worker-side operations - create, redeploy, re-read in batches,
 * then free the old search data - and the last of those cannot be undone. So it
 * is deliberately NOT part of `staged`/`stagedModel`: Save must not be able to
 * commit it, Cancel must not look like it can stop it, and the chosen target
 * must never reach `apply_settings`' patch. Only `begin_embedding_migration`
 * writes it, after the new search data exists.
 *
 * All of it lives at module scope because render() calls app.replaceChildren()
 * on every state change - a progress bar held by reference would be thrown away
 * on the next repaint, exactly as `message` and `busy` are handled.
 *
 * Every state has a way out, which is the property the phase list is arranged
 * around. `running` has Pause. A stall that waiting cannot fix, and a loop that
 * stops moving, both have Start over. Both terminal screens have a route back to
 * the picker. A rebuild that leaves search incomplete with no button to press is
 * the failure mode this flow is designed against.
 */

/**
 * One offerable way of reading memories.
 *
 * `level` is a copy key ("standard" | "finer" | "finest"), and it is what the
 * picker shows. Dimensions are deliberately not in the payload: a number like
 * 768 on a decision screen is exactly what the named level replaces.
 */
/** `exceedsFreeStorage` is computed on the Rust side, because the window
 *  deliberately never sees dimension counts. */
type EmbeddingChoice = { model: string; level: string; exceedsFreeStorage: boolean };

type MigrationEstimate = {
  entries: number;
  chunksAtLeast: number;
  currentModel: string;
  /** Already ordered coarsest first by the Worker side; never re-sorted here. */
  models: EmbeddingChoice[];
};

/** A rebuild the Worker has on record, finished or not. */
type MigrationRun = {
  model: string;
  processed: number;
  failed: number;
  totalAtStart: number;
  cursorId: string | null;
  finishedAt?: string | null;
};

type MigrationStatus = { ok: boolean; state: MigrationRun | null; model: string };

type MigrationStep = {
  processed: number;
  failed: number;
  remaining: number;
  total: number;
  done: boolean;
  /** The run stopped with its cursor kept, because a batch achieved nothing. */
  stalled: boolean;
  /**
   * Why it stopped. `"budget"` refills overnight; `"failing"` never will, so the
   * two need different screens - "come back tomorrow" is advice that can never
   * work against a memory that keeps failing.
   */
  stalledReason: "budget" | "failing" | null;
};

type MigrationPhase =
  /** Pane never opened this session - opening it triggers the first load. */
  | "unloaded"
  | "loading"
  | "loadFailed"
  /** Estimate shown, nothing created yet. */
  | "idle"
  /** Target picked, warning shown, waiting for an explicit yes. */
  | "confirm"
  | "starting"
  | "running"
  /** The user asked to stop; progress is kept and resuming is free. */
  | "paused"
  /** The day's AI allowance is spent. It comes back. */
  | "stalledBudget"
  /** One memory keeps failing. Waiting cannot fix it. */
  | "stalledFailing"
  /** Batches keep returning without moving anything. */
  | "stuck"
  | "failed"
  /** A rebuild from an earlier session stopped partway. */
  | "interrupted"
  /** Abandoning a run's record so the next one begins from the first memory. */
  | "resetting"
  /** Re-reading finished; the old search data may still be there. */
  | "done"
  | "freeing"
  | "freed";

const migration = {
  phase: "unloaded" as MigrationPhase,
  estimate: null as MigrationEstimate | null,
  /** The picked target. Not staged - see the note above. */
  target: null as string | null,
  /** Honest k-of-n, straight from the last step's `total - remaining`. */
  progress: null as { done: number; total: number; failed: number } | null,
  error: null as string | null,
  /** Second half of the two-step confirm on the irreversible last step. */
  confirmFree: false,
  /**
   * What is left over to free, as the Worker side recorded it from the binding
   * Cloudflare reported. Nothing here is derived or remembered by this window:
   * the name of something irreversibly deletable must not depend on browser
   * storage, which a reset clears and which cannot be trusted to name the right
   * thing after a restart.
   */
  oldIndex: null as string | null,
  /** Set by Pause. The loop stops after the batch already in flight. */
  pauseRequested: false,
  /** Guards against a second step loop running alongside the first. */
  looping: false,
};

function migrationBusy(): boolean {
  const p = migration.phase;
  return p === "starting" || p === "running" || p === "freeing" || p === "resetting";
}

/**
 * Chunks one batch will embed before it stops - the Worker's
 * MIGRATION_CHUNK_BUDGET. Duplicated here only to turn a piece count into a
 * number of sequential rounds, which is the one honest answer this window can
 * give to "how long will this take". It is shown as "about", so a drift in the
 * Worker's budget changes nothing anyone acts on.
 */
const CHUNKS_PER_ROUND = 20;

function roundsFor(chunks: number): number {
  return Math.max(1, Math.round(chunks / CHUNKS_PER_ROUND));
}

/** The `level` a model is offered under, or null if the Worker doesn't offer it. */
function levelOf(model: string): string | null {
  return migration.estimate?.models.find(m => m.model === model)?.level ?? null;
}

/**
 * The name a user reads. Never the model id: an id was the last thing read
 * before a one-way operation, and it asked the reader to reason about the
 * position of an opaque string in a list.
 *
 * Falls back to the id only for a model the Worker does not offer - a reader set
 * outside the app, which must still show as selected rather than vanish.
 */
function levelName(model: string): string {
  const level = levelOf(model);
  if (!level) return model;
  const key = `settingsPanel.migration.levels.${level}.name` as const;
  const name = t(key);
  // t() returns the path when a key is missing; a dotted path on screen would be
  // worse than the id it replaced.
  return name === key ? model : name;
}

/** The trade-off, in plain language, for whichever level is selected. */
function levelNotice(model: string): string | null {
  const level = levelOf(model);
  if (!level) return null;
  const key = `settingsPanel.migration.levels.${level}.notice` as const;
  const notice = t(key);
  return notice === key ? null : notice;
}

/**
 * Whether there is leftover search data to free, by name.
 *
 * Asked of the Worker side rather than tracked here: it is recorded from what
 * Cloudflare reported as bound, so it survives a restart and cannot name the
 * wrong thing. A failure reads as "nothing to free" - offering the step without
 * a name behind it is how the wrong data gets deleted.
 */
async function refreshOldIndex(): Promise<void> {
  try {
    migration.oldIndex = await invoke<string | null>("outstanding_old_index");
  } catch {
    migration.oldIndex = null;
  }
}

/**
 * Estimate before anything is created, and any rebuild already on record.
 *
 * `forcePicker` is the "Change this again" route: a finished run stays on record,
 * so re-reading status would land straight back on the done screen and the two
 * terminal states would have no way out of the window.
 */
async function loadMigration(forcePicker = false): Promise<void> {
  try {
    const status = await invoke<MigrationStatus>("migration_status");
    // A status the Worker itself calls not-ok must not be read as "no rebuild in
    // progress" - that would offer a fresh start over the top of a live one.
    if (!status.ok) {
      migration.phase = "loadFailed";
      migration.error = null;
      render();
      return;
    }
    const estimate = await invoke<MigrationEstimate>("migration_estimate");
    migration.estimate = estimate;
    migration.error = null;
    const run = status.state;
    if (forcePicker || !run) {
      migration.target = estimate.currentModel;
      migration.progress = null;
      migration.confirmFree = false;
      migration.phase = "idle";
    } else {
      migration.target = run.model;
      migration.progress = { done: run.processed, total: run.totalAtStart, failed: run.failed };
      migration.phase = run.finishedAt ? "done" : "interrupted";
      if (run.finishedAt) await refreshOldIndex();
    }
  } catch (e) {
    migration.phase = "loadFailed";
    migration.error = errorText(e);
  }
  render();
}

async function beginMigration(): Promise<void> {
  const model = migration.target;
  if (!model || migrationBusy()) return;
  // A brain with no memories skips the warning screen, so a failed begin has to
  // land back on the picker rather than on a screen that was never shown.
  const back: MigrationPhase = (migration.estimate?.entries ?? 1) === 0 ? "idle" : "confirm";
  migration.phase = "starting";
  migration.error = null;
  message = null;
  render();
  try {
    // Creates the new search data, points the brain at it, and redeploys. The
    // reader is written here and nowhere else.
    await invoke("begin_embedding_migration", { model });
  } catch (e) {
    // The old search data is still bound, so the brain is exactly as it was.
    // Back with the target kept, so one click retries.
    migration.phase = back;
    migration.error = errorText(e);
    render();
    return;
  }
  migration.phase = "running";
  migration.progress = null;
  migration.pauseRequested = false;
  render();
  await stepLoop();
}

/**
 * Batches until the Worker says done. Subrequest limits make one big request
 * impossible, which is why the app drives the loop rather than the Worker.
 */
async function stepLoop(): Promise<void> {
  if (migration.looping) return;
  migration.looping = true;
  let lastRemaining = -1;
  let idleRounds = 0;
  try {
    for (;;) {
      let step: MigrationStep;
      try {
        step = await invoke<MigrationStep>("migration_step");
      } catch (e) {
        migration.phase = "failed";
        migration.error = errorText(e);
        render();
        return;
      }
      migration.progress = {
        done: Math.max(0, step.total - step.remaining),
        total: step.total,
        failed: step.failed,
      };
      if (step.done) {
        migration.phase = "done";
        migration.error = null;
        migration.confirmFree = false;
        // Whether there is anything left to free is the Worker side's answer, and
        // it decides whether the last step is offered at all.
        await refreshOldIndex();
        render();
        return;
      }
      // Two different stalls behind one flag. A spent allowance refills, so the
      // advice is "come back tomorrow"; a memory that keeps failing never will,
      // and telling that user to wait would send them back to Carry on, which
      // reruns the identical failing batch forever. Anything that is not plainly
      // a budget stall gets the screen with a way out.
      if (step.stalled) {
        migration.phase = step.stalledReason === "budget" ? "stalledBudget" : "stalledFailing";
        migration.error = null;
        render();
        return;
      }
      // An explicit Pause takes effect between batches: the request in flight
      // cannot be recalled, and throwing away its result would lose work the
      // allowance has already been spent on.
      if (migration.pauseRequested) {
        migration.pauseRequested = false;
        migration.phase = "paused";
        migration.error = null;
        render();
        return;
      }
      // A batch that is neither done nor stalled and moves nothing would spin
      // this loop against the Worker forever. Three identical answers is a stop.
      idleRounds = step.remaining === lastRemaining ? idleRounds + 1 : 0;
      lastRemaining = step.remaining;
      if (idleRounds >= 2) {
        // Its own phase rather than an error string stacked under the failed
        // screen, which said the same thing twice in two voices - three lines of
        // calm grey reassurance and then a red sentence arguing with them.
        migration.phase = "stuck";
        migration.error = null;
        render();
        return;
      }
      render();
    }
  } finally {
    migration.looping = false;
  }
}

async function resumeMigration(): Promise<void> {
  if (migrationBusy()) return;
  migration.phase = "running";
  migration.error = null;
  migration.pauseRequested = false;
  render();
  await stepLoop();
}

/**
 * The abandon path: forget where the run got to and read everything again from
 * the first memory.
 *
 * Without it, a rebuild whose cursor sits on a permanently failing memory has no
 * exit at all - every Carry on reruns the same batch. It costs AI allowance for
 * work already paid for once, which is why the screens that offer it say so.
 *
 * It does not land on the picker afterwards. The brain is already reading the new
 * search data, so stopping here would leave search incomplete with nothing
 * running to complete it; starting the batches again is what "start over" means.
 */
async function restartMigration(): Promise<void> {
  if (migrationBusy()) return;
  const back = migration.phase;
  migration.phase = "resetting";
  migration.error = null;
  render();
  try {
    await invoke("migration_reset");
  } catch (e) {
    // Nothing was forgotten, so the screen that offered this still applies.
    migration.phase = back;
    migration.error = errorText(e);
    render();
    return;
  }
  migration.progress = null;
  migration.pauseRequested = false;
  migration.phase = "running";
  render();
  await stepLoop();
}

/** The one irreversible step, always behind its own explicit confirm. */
async function freeOldSearchData(): Promise<void> {
  if (migration.oldIndex === null || migrationBusy()) return;
  migration.phase = "freeing";
  migration.error = null;
  render();
  try {
    // No argument: the Worker side holds the name of what it recorded as bound,
    // so nothing deletable is ever named by this window.
    await invoke("finish_embedding_migration");
    migration.oldIndex = null;
    migration.confirmFree = false;
    migration.phase = "freed";
  } catch (e) {
    // Nothing was freed, so the offer stands.
    migration.phase = "done";
    migration.error = errorText(e);
  }
  render();
}

function migrationNote(text: string, tone: "plain" | "warn" = "plain"): HTMLElement {
  const cls =
    tone === "warn"
      ? "settings-migration-note settings-migration-warn"
      : "settings-migration-note";
  return h("div", { class: cls }, [text]);
}

function migrationTitle(text: string): HTMLElement {
  return h("div", { class: "url-label settings-migration-title" }, [text]);
}

function migrationActions(...buttons: HTMLElement[]): HTMLElement {
  return h("div", { class: "row-actions settings-migration-actions" }, buttons);
}

/**
 * `live` is for the one control that must stay usable while a rebuild runs:
 * Pause. Everything else is disabled for the duration, which is why the default
 * is the locked one.
 */
function migrationButton(
  cls: string,
  label: string,
  onClick: () => void,
  live = false,
): HTMLElement {
  const button = h("button", { class: cls, type: "button" }, [label]);
  (button as HTMLButtonElement).disabled = live ? busy : locked();
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Not rendered on the done screen at all, which is why `failed` never appears
 * there. `failed` is cumulative and a memory that failed one batch is retried in
 * a later one, so finishing with a non-zero count is an ordinary outcome - and
 * "couldn't be read: 3" under the heading "all your memories have been read
 * again" would contradict itself, with the alarming half carrying the number.
 */
function migrationProgress(): HTMLElement {
  const p = migration.progress;
  const wrap = h("div", { class: "settings-migration-progress" });
  wrap.append(
    h("div", { class: "settings-migration-count" }, [
      p && p.total > 0
        ? t("settingsPanel.migration.progress", { done: num(p.done), total: num(p.total) })
        : t("settingsPanel.migration.progressPending"),
    ]),
  );
  if (p && p.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
    // The k-of-n line above says the same thing, so the bar itself is decoration.
    const track = h("div", { class: "settings-progress", "aria-hidden": "true" });
    track.append(h("div", { class: "settings-progress-fill", style: `width: ${pct}%` }));
    wrap.append(track);
  }
  if (p && p.failed > 0) {
    wrap.append(migrationNote(t("settingsPanel.migration.skipped", { failed: num(p.failed) })));
  }
  return wrap;
}

/** Counted in memories, the same unit progress uses, and correct at 0 and 1. */
function estimateCount(e: MigrationEstimate): string {
  if (e.entries === 0) return t("settingsPanel.migration.entriesNone");
  if (e.entries === 1) return t("settingsPanel.migration.entriesOne");
  return t("settingsPanel.migration.entries", { entries: num(e.entries) });
}

function migrationPicker(e: MigrationEstimate): HTMLElement[] {
  const select = h("select", { class: "locale-select" }) as HTMLSelectElement;
  // Already ordered coarsest first, and there is nothing left to sort by:
  // dimensions no longer reach this window at all.
  const label = (model: string) =>
    model === e.currentModel
      ? t("settingsPanel.migration.inUse", { name: levelName(model) })
      : levelName(model);
  for (const choice of e.models) {
    select.append(h("option", { value: choice.model }, [label(choice.model)]));
  }
  // A reader set outside the app must still show as selected rather than
  // silently reading as the first entry.
  if (!e.models.some(m => m.model === e.currentModel)) {
    select.append(h("option", { value: e.currentModel }, [label(e.currentModel)]));
  }
  select.value = migration.target ?? e.currentModel;

  // The one warning that is about a hard limit rather than a cost. On the free
  // plan, running out of stored space makes writes fail - there is no billing to
  // absorb it - and the peak comes during the rebuild, while both the old and new
  // search data are kept so the change can still be undone.
  const storageWarning = () => {
    const target = select.value;
    const chosen = e.models.find(m => m.model === target);
    return chosen?.exceedsFreeStorage && target !== e.currentModel
      ? t("settingsPanel.migration.storageWarning")
      : null;
  };
  select.disabled = locked();
  select.addEventListener("change", () => {
    migration.target = select.value;
    migration.error = null;
    render();
  });

  const sameAsCurrent = migration.target === null || migration.target === e.currentModel;
  // Starting a rebuild locks the action bar, which would strand staged edits
  // with no way to save them. Ask for a clean slate first, and say so.
  const blockedByEdits = isDirty();
  const start = migrationButton("btn-primary", t("settingsPanel.migration.startButton"), () => {
    // Nothing to warn about on an empty brain: there is no search to go
    // incomplete and nothing to read again, and the warning copy is nonsense at
    // zero. The switch itself still has to happen.
    if (e.entries === 0) {
      void beginMigration();
      return;
    }
    migration.phase = "confirm";
    migration.error = null;
    render();
  });
  (start as HTMLButtonElement).disabled = locked() || sameAsCurrent || blockedByEdits;

  const out: HTMLElement[] = [
    h("div", { class: "settings-migration-count" }, [estimateCount(e)]),
    h("div", { class: "url-label settings-migration-pick" }, [
      t("settingsPanel.migration.pickLabel"),
    ]),
    select,
  ];
  // What the selected level actually trades away, so the choice is not made by
  // reading positions in a list.
  const notice = levelNotice(migration.target ?? e.currentModel);
  if (notice) out.push(migrationNote(notice));
  out.push(migrationNote(t("settingsPanel.migration.pickNote")));
  // Placed with the choice rather than on the warning screen: it is a reason to
  // pick differently, not a step to acknowledge on the way past.
  const storage = storageWarning();
  if (storage) out.push(migrationNote(storage, "warn"));
  if (sameAsCurrent) out.push(migrationNote(t("settingsPanel.migration.sameAsCurrent")));
  else if (blockedByEdits) out.push(migrationNote(t("settingsPanel.migration.dirtyNote")));
  out.push(migrationActions(start));
  return out;
}

function migrationConfirm(): HTMLElement[] {
  const e = migration.estimate;
  const chunks = e ? num(e.chunksAtLeast) : t("settingsPanel.migration.unknownValue");
  const rounds = e ? num(roundsFor(e.chunksAtLeast)) : t("settingsPanel.migration.unknownValue");
  const points = h("ul", { class: "settings-migration-points" });
  for (const key of ["point1", "point2", "point3", "point4"] as const) {
    points.append(h("li", {}, [t(`settingsPanel.migration.${key}`, { chunks, rounds })]));
  }
  const go = migrationButton(
    "btn-danger",
    // A failed begin lands back here; the label admits it is a retry.
    migration.error ? t("common.tryAgain") : t("settingsPanel.migration.confirmButton"),
    () => void beginMigration(),
  );
  // The same block as on the picker, repeated here: this screen stays up while
  // the user visits another pane, so edits can appear between the two clicks.
  const blockedByEdits = isDirty();
  (go as HTMLButtonElement).disabled = locked() || blockedByEdits;
  const back = migrationButton("btn-ghost", t("settingsPanel.migration.cancelButton"), () => {
    migration.phase = "idle";
    migration.error = null;
    render();
  });
  const target = migration.target ?? "";
  const out = [
    migrationTitle(t("settingsPanel.migration.confirmTitle")),
    // One sentence at full weight. Everything under it is grey, and a screen
    // that is entirely grey before a one-way operation does not get read.
    h("div", { class: "settings-migration-lead" }, [t("settingsPanel.migration.confirmLead")]),
    migrationNote(t("settingsPanel.migration.confirmBody")),
    points,
    // The named level, not the id: this is the last label before commitment.
    h("div", { class: "settings-migration-target" }, [
      t("settingsPanel.migration.targetLine", { name: levelName(target) }),
    ]),
  ];
  // The id earns its place only here, as secondary text, for anyone who wants to
  // check exactly what they are about to be moved onto.
  if (levelOf(target)) {
    out.push(
      h("div", { class: "settings-migration-model" }, [
        t("settingsPanel.migration.modelLine", { name: target }),
      ]),
    );
  }
  if (blockedByEdits) out.push(migrationNote(t("settingsPanel.migration.dirtyNote")));
  out.push(migrationActions(go, back));
  return out;
}

/**
 * Both terminal screens were dead ends inside this window: the only route back
 * to the picker was closing it and opening it again.
 */
function changeAgainButton(): HTMLElement {
  return migrationButton("btn-ghost", t("settingsPanel.migration.changeAgain"), () => {
    migration.phase = "loading";
    migration.error = null;
    render();
    void loadMigration(true);
  });
}

function startOverButton(): HTMLElement {
  return migrationButton("btn-secondary", t("settingsPanel.migration.startOverButton"), () =>
    void restartMigration(),
  );
}

function migrationDone(): HTMLElement[] {
  const out: HTMLElement[] = [
    migrationTitle(t("settingsPanel.migration.doneTitle")),
    migrationNote(t("settingsPanel.migration.doneBody")),
  ];
  // Nothing recorded as outstanding means nothing to free. Silently, with no
  // apology: there is no leftover data and therefore nothing to explain.
  if (migration.oldIndex === null) {
    out.push(migrationActions(changeAgainButton()));
    return out;
  }
  out.push(
    h("div", { class: "url-label settings-migration-free" }, [
      t("settingsPanel.migration.freeLabel"),
    ]),
    migrationNote(t("settingsPanel.migration.freeDesc")),
  );
  if (!migration.confirmFree) {
    out.push(
      migrationActions(
        migrationButton("btn-danger", t("settingsPanel.migration.freeButton"), () => {
          migration.confirmFree = true;
          render();
        }),
        changeAgainButton(),
      ),
    );
    return out;
  }
  out.push(
    migrationActions(
      migrationButton("btn-danger", t("settingsPanel.migration.freeConfirm"), () =>
        void freeOldSearchData(),
      ),
      migrationButton("btn-ghost", t("settingsPanel.migration.freeKeep"), () => {
        migration.confirmFree = false;
        render();
      }),
    ),
  );
  return out;
}

function migrationBody(): HTMLElement[] {
  const resume = () =>
    migrationButton("btn-secondary", t("settingsPanel.migration.resumeButton"), () =>
      void resumeMigration(),
    );
  switch (migration.phase) {
    case "unloaded":
    case "loading":
      return [migrationNote(t("settingsPanel.migration.loading"))];
    case "loadFailed":
      return [
        migrationNote(t("settingsPanel.migration.loadFailed")),
        migrationActions(
          migrationButton("btn-secondary", t("common.tryAgain"), () => {
            migration.phase = "unloaded";
            migration.error = null;
            render();
          }),
        ),
      ];
    case "idle":
      return migration.estimate
        ? migrationPicker(migration.estimate)
        : [migrationNote(t("settingsPanel.migration.loadFailed"))];
    case "confirm":
      return migrationConfirm();
    case "starting":
      return [
        migrationTitle(t("settingsPanel.migration.startingTitle")),
        migrationNote(t("settingsPanel.migration.startingBody")),
      ];
    case "running": {
      // The copy has always said closing the window is a safe pause, and then
      // beforeunload argued about closing it. A real Pause is the exit that
      // settles the contradiction - and it stays enabled while everything else
      // on the screen is locked.
      const pause = migrationButton(
        "btn-ghost",
        migration.pauseRequested
          ? t("settingsPanel.migration.pausing")
          : t("settingsPanel.migration.pauseButton"),
        () => {
          migration.pauseRequested = true;
          render();
        },
        true,
      );
      (pause as HTMLButtonElement).disabled = migration.pauseRequested;
      return [
        migrationTitle(t("settingsPanel.migration.runningTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.runningBody")),
        migrationActions(pause),
      ];
    }
    case "paused":
      return [
        migrationTitle(t("settingsPanel.migration.pausedTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.pausedBody")),
        migrationActions(resume()),
      ];
    case "stalledBudget":
      return [
        migrationTitle(t("settingsPanel.migration.stalledTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.stalledBody")),
        migrationActions(resume()),
      ];
    case "stalledFailing":
      // The allowance is not the problem here, so Carry on alone would rerun the
      // identical failing batch for as long as the user is willing to click it.
      return [
        migrationTitle(t("settingsPanel.migration.stalledFailingTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.stalledFailingBody")),
        migrationNote(t("settingsPanel.migration.startOverNote")),
        migrationActions(
          migrationButton("btn-secondary", t("common.tryAgain"), () => void resumeMigration()),
          startOverButton(),
        ),
      ];
    case "stuck":
      // Same trap as stalledFailing, reached by the loop's own no-progress guard
      // rather than by the Worker admitting it, so it gets the same way out.
      return [
        migrationTitle(t("settingsPanel.migration.stuckTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.stuck")),
        migrationNote(t("settingsPanel.migration.startOverNote")),
        migrationActions(
          migrationButton("btn-secondary", t("common.tryAgain"), () => void resumeMigration()),
          startOverButton(),
        ),
      ];
    case "interrupted":
      return [
        migrationTitle(t("settingsPanel.migration.interruptedTitle")),
        migrationProgress(),
        migrationNote(
          t("settingsPanel.migration.interruptedBody", {
            done: num(migration.progress?.done ?? 0),
            total: num(migration.progress?.total ?? 0),
          }),
        ),
        migrationNote(t("settingsPanel.migration.startOverNote")),
        migrationActions(resume(), startOverButton()),
      ];
    case "resetting":
      return [
        migrationTitle(t("settingsPanel.migration.resettingTitle")),
        migrationNote(t("settingsPanel.migration.resettingBody")),
      ];
    case "failed":
      return [
        migrationTitle(t("settingsPanel.migration.failedTitle")),
        migrationProgress(),
        migrationNote(t("settingsPanel.migration.failedBody")),
        migrationActions(
          migrationButton("btn-secondary", t("common.tryAgain"), () => void resumeMigration()),
        ),
      ];
    case "done":
      return migrationDone();
    case "freeing":
      return [
        migrationTitle(t("settingsPanel.migration.freeing")),
        migrationNote(t("settingsPanel.migration.freeingBody")),
      ];
    case "freed":
      return [
        migrationTitle(t("settingsPanel.migration.freedTitle")),
        migrationNote(t("settingsPanel.migration.freedBody")),
        migrationActions(changeAgainButton()),
      ];
  }
}

function migrationCard(): HTMLElement {
  if (migration.phase === "unloaded") {
    // Nothing is fetched until the pane is opened. The phase flips before the
    // first await, so a re-render cannot start a second load.
    migration.phase = "loading";
    void loadMigration();
  }
  const card = h("div", { class: "card settings-control settings-migration" });
  card.append(
    h("div", { class: "url-label" }, [t("settingsPanel.migration.label")]),
    h("div", { class: "url-desc" }, [t("settingsPanel.migration.desc")]),
    ...migrationBody(),
  );
  // The Worker's own words: they name what actually went wrong.
  if (migration.error) {
    card.append(h("div", { class: "settings-migration-error" }, [migration.error]));
  }
  return card;
}

function controlCard(c: ControlView): HTMLElement {
  // Typed so the dotted keys below still satisfy t()'s Path type rather
  // than widening to a bare string.
  const base: `settingsPanel.${string}` = `settingsPanel.${c.id}`;
  const shown = effectiveLevel(c);
  const edited = staged.has(c.id);

  const card = h("div", { class: `card settings-control${edited ? " settings-edited" : ""}` });
  card.append(
    h("div", { class: "url-label" }, [t(`${base}.label`)]),
    h("div", { class: "url-desc" }, [t(`${base}.desc`)]),
  );

  const notice = h("div", { class: "settings-notice" });
  const paint = (levelId: string | null) => {
    notice.textContent = levelId
      ? t(`${base}.levels.${levelId}.notice`)
      : t("settingsPanel.customNote");
  };

  const group = h("div", { class: "settings-levels", role: "radiogroup" });
  group.setAttribute("aria-label", t(`${base}.label`));

  for (const levelId of c.levels) {
    const input = h("input", { type: "radio", name: `sb-${c.id}`, value: levelId });
    (input as HTMLInputElement).checked = shown === levelId;
    (input as HTMLInputElement).disabled = locked();
    input.addEventListener("change", () => stage(c.id, { kind: "level", id: levelId }, c));
    const label = h("label", { class: "settings-level" }, [
      input,
      t(`${base}.levels.${levelId}.name`),
    ]);
    // Hovering previews that level's notice; leaving restores the shown one.
    label.addEventListener("mouseenter", () => paint(levelId));
    label.addEventListener("mouseleave", () => paint(shown));
    group.append(label);
  }
  card.append(group);

  if (shown === null) {
    card.append(h("div", { class: "settings-custom" }, [t("settingsPanel.custom")]));
  }
  paint(shown);
  card.append(notice);

  // Forward-only controls cannot rewrite what is already stored. Marked
  // because presenting them as ordinary settings generates support questions.
  if (c.forwardOnly) {
    card.append(h("div", { class: "settings-forward-note" }, [`ⓘ ${t(`${base}.note`)}`]));
  }

  const reset = h("button", { class: "btn-secondary settings-reset", type: "button" }, [
    t("settingsPanel.reset"),
  ]);
  // Reset is itself staged, so it can be cancelled like any other edit.
  (reset as HTMLButtonElement).disabled = locked() || shown === c.defaultLevel;
  reset.addEventListener("click", () => stage(c.id, { kind: "reset" }, c));
  card.append(reset);

  return card;
}

/**
 * Both model dropdowns (LLM_MODEL and INSIGHT_LLM_MODEL) draw from the same
 * curated catalogue and show the id itself - there is no friendly-name layer
 * for these the way the migration picker has for embedding models, so the
 * option text is the id.
 */
function modelSelect(models: string[], current: string, onChange: (value: string) => void): HTMLSelectElement {
  const select = h("select", { class: "locale-select" }) as HTMLSelectElement;
  for (const model of models) {
    select.append(h("option", { value: model }, [model]));
  }
  // A model set outside the app (or dropped from the curated list) must still
  // show as selected rather than silently reading as the first entry.
  if (current && !models.includes(current)) {
    select.append(h("option", { value: current }, [current]));
  }
  select.value = current;
  select.disabled = locked();
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function modelCard(v: SettingsView): HTMLElement {
  const card = h("div", { class: `card settings-control${stagedModel ? " settings-edited" : ""}` });
  card.append(
    h("div", { class: "url-label" }, [t("settingsPanel.model.label")]),
    h("div", { class: "url-desc" }, [t("settingsPanel.model.desc")]),
  );

  const current = stagedModel ?? v.llmModel;
  const select = modelSelect(v.llmModels, current, value => {
    stagedModel = value === v.llmModel ? null : value;
    message = null;
    render();
  });

  card.append(
    select,
    h("div", { class: "settings-notice" }, [t("settingsPanel.model.sizeNote")]),
    h("div", { class: "settings-forward-note" }, [`ⓘ ${t("settingsPanel.model.neuronsNote")}`]),
  );
  return card;
}

/**
 * A second, separate model: the general model above never reasons over a pair
 * of memories, and this one never does anything else. Kept as its own control
 * (rather than a level of `modelCard`) so each can be changed, staged and
 * reset independently.
 */
function insightModelCard(v: SettingsView): HTMLElement {
  const card = h("div", { class: `card settings-control${stagedInsightModel ? " settings-edited" : ""}` });
  card.append(
    h("div", { class: "url-label" }, [t("settingsPanel.insightModel.label")]),
    h("div", { class: "url-desc" }, [t("settingsPanel.insightModel.desc")]),
  );

  const current = stagedInsightModel ?? v.insightLlmModel;
  const select = modelSelect(v.llmModels, current, value => {
    stagedInsightModel = value === v.insightLlmModel ? null : value;
    message = null;
    render();
  });

  card.append(
    select,
    h("div", { class: "settings-notice" }, [t("settingsPanel.insightModel.sizeNote")]),
    h("div", { class: "settings-forward-note" }, [`ⓘ ${t("settingsPanel.insightModel.defaultNote")}`]),
  );
  return card;
}

/** Sticky footer: nothing reaches the Worker except through Save. */
function actionBar(): HTMLElement {
  const count = staged.size + (stagedModel ? 1 : 0) + (stagedInsightModel ? 1 : 0);
  const bar = h("div", { class: "settings-actions" });

  const status = h("div", { class: "settings-actions-status" });
  if (migrationBusy()) {
    // A rebuild started in one pane greys out every other pane. Say why here,
    // where the disabled buttons are, rather than only on the pane that owns it.
    const p = migration.progress;
    status.textContent =
      p && p.total > 0
        ? t("settingsPanel.migration.barRunning", { done: num(p.done), total: num(p.total) })
        : t("settingsPanel.migration.barWorking");
    status.classList.add("settings-status-pending");
  } else if (message) {
    status.textContent = message.text;
    status.classList.add(`settings-status-${message.kind}`);
  } else if (count > 0) {
    status.textContent =
      count === 1
        ? t("settingsPanel.unsavedOne")
        : t("settingsPanel.unsaved", { count: String(count) });
    status.classList.add("settings-status-pending");
  }

  const cancel = h("button", { class: "btn-secondary", type: "button" }, [
    t("settingsPanel.cancel"),
  ]);
  (cancel as HTMLButtonElement).disabled = locked() || !isDirty();
  cancel.addEventListener("click", discard);

  const saveBtn = h("button", { class: "btn-primary", type: "button" }, [
    busy ? t("settingsPanel.saving") : t("settingsPanel.save"),
  ]);
  (saveBtn as HTMLButtonElement).disabled = locked() || !isDirty();
  saveBtn.addEventListener("click", () => void save());

  bar.append(status, cancel, saveBtn);
  return bar;
}

function render(): void {
  const scroll = window.scrollY;
  app.replaceChildren();
  if (!saved) return;

  const rail = h("nav", { class: "rail" });
  for (const section of SECTIONS) {
    const edits = countEdits(section.id);
    const btn = h("button", { class: section.id === active ? "rail-btn on" : "rail-btn", type: "button" }, [
      t(`settingsPanel.${section.labelKey}`),
    ]);
    // A dot on an inactive section, so staged edits are not hidden by the pane
    // the user happens to be looking at.
    if (edits > 0) btn.append(h("span", { class: "rail-dot" }, ["●"]));
    btn.addEventListener("click", () => {
      active = section.id;
      render();
    });
    rail.append(btn);
  }

  const section = SECTIONS.find(s => s.id === active)!;
  const pane = h("section", { class: "pane" });
  pane.append(
    h("h2", { class: "pane-title" }, [t(`settingsPanel.${section.labelKey}`)]),
    h("p", { class: "settings-lede" }, [
      // The shared lede promises "applies to your next search", which is not
      // what a rebuild does. That pane says what it actually does.
      active === "matching" ? t("settingsPanel.migration.lede") : t("settingsPanel.lede"),
    ]),
  );

  const byId = new Map(saved.controls.map(c => [c.id, c]));
  for (const id of section.controls) {
    const c = byId.get(id);
    // Skip silently rather than throwing: a Worker running an older version
    // may not expose every control yet.
    if (c) pane.append(controlCard(c));
  }
  if (active === "ai") pane.append(modelCard(saved), insightModelCard(saved));
  if (active === "matching") pane.append(migrationCard());

  app.append(h("div", { class: "panel" }, [rail, pane]), actionBar());
  // Re-render replaces the whole tree; without this, staging an edit near the
  // bottom would jump the view back to the top.
  window.scrollTo({ top: scroll });
}

/** Staged edits belonging to one section, for the rail indicator. */
function countEdits(id: SectionId): number {
  const section = SECTIONS.find(s => s.id === id);
  if (!section) return 0;
  let n = section.controls.filter(c => staged.has(c)).length;
  if (id === "ai" && stagedModel) n += 1;
  if (id === "ai" && stagedInsightModel) n += 1;
  return n;
}

async function boot(): Promise<void> {
  initI18n();
  document.title = t("settingsPanel.title");
  void getCurrentWindow().setTitle(t("settingsPanel.title"));
  app.replaceChildren(h("p", { class: "settings-lede" }, [t("settingsPanel.saving")]));
  try {
    saved = await invoke<SettingsView>("get_brain_settings");
    render();
  } catch (e) {
    app.replaceChildren(
      h("h1", { class: "settings-title" }, [t("settingsPanel.title")]),
      h("div", { class: "settings-status settings-status-error" }, [
        typeof e === "string" ? e : t("settingsPanel.loadFailed"),
      ]),
    );
  }
}

// Closing the window with staged edits would lose them silently. Closing it
// mid-rebuild stops the batch loop, which leaves the brain searchable but
// incomplete until someone comes back and resumes - also worth a warning.
window.addEventListener("beforeunload", event => {
  if (isDirty() || migrationBusy()) event.preventDefault();
});

window.addEventListener(LOCALE_CHANGE_EVENT, () => {
  document.title = t("settingsPanel.title");
  void getCurrentWindow().setTitle(t("settingsPanel.title"));
  render();
});
void boot();
