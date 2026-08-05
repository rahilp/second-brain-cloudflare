/**
 * Second Brain — Calendar provider (iCal .ics).
 *
 * Read-only. Connects each provider's SECRET iCal subscription URL (Gmail's
 * "Secret address in iCal format", Outlook's published ICS link, iCloud's
 * shared webcal URL) — not CalDAV, not OAuth. One HTTPS GET per sync; ical.js
 * expands recurrences; qualifying occurrences mirror into memory. Upcoming
 * events are live-mirrored (cancellations delete); past events freeze into a
 * bounded historical log.
 */

import ICAL from "ical.js";
import type {
  IntegrationEnv,
  IntegrationProvider,
  IntegrationRecord,
  ItemMapEntry,
  MirrorStore,
  SyncOutcome,
} from "./framework";
import { loadIntegration, saveIntegration } from "./framework";

// ── Tunable constants ──────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
export const FUTURE_WINDOW_MS = 30 * DAY_MS; // how far ahead to mirror
export const PAST_LOOKBACK_MS = 2 * DAY_MS;  // shallow: the log builds forward from connect
export const RETENTION_MS = 180 * DAY_MS;    // hard bound on kept history
// P1: past recurring instances (e.g. a daily standup) age out as soon as they're
// past, so they don't accumulate as low-value memories; one-off past events still
// keep the full RETENTION_MS as historical memory.
export const RECURRING_RETENTION_MS: number | null = 0;
// Create/update ceiling per batch. The budget that binds here is D1's — 50
// queries per Worker invocation on the free plan — not the one outbound fetch
// per sync this used to be justified by, which is how the real cost went
// unnoticed (#290). Each mirrored occurrence costs the mirror store two D1
// queries to create (insert, then vector_ids) and three to update (read, content
// write, vector_ids), on top of its classify, embed and Vectorize calls. So ten
// items is 20–30 D1 queries: comfortable in an HTTP sync, which owns its whole
// invocation, and the most the nightly cron can afford in the one it shares with
// three other jobs (see CRON_SYNC_MAX_BATCHES in mirror.ts).
export const SYNC_EVENT_BATCH = 10;
export const MAX_OCCURRENCES_PER_EVENT = 200;
const MAX_ITER = 100_000;                     // guards pathological RRULEs. Note: ev.iterator() walks from DTSTART, so this budget is also spent reaching the window; 100k covers realistic old/frequent series (e.g. hourly for ~10y, daily for centuries). Sub-hourly rules running many years may exhaust it and yield no occurrences — acceptable.
const MAX_DESCRIPTION_CHARS = 4000;

// A single concrete calendar occurrence (a non-recurring event, or one expanded
// instance of a recurring one).
export interface Occurrence {
  key: string;        // uid (single) or `${uid}::${startISO}` (recurring instance)
  uid: string;
  isRecurring: boolean;
  summary: string;
  start: number;      // epoch ms
  end: number;        // epoch ms
  allDay: boolean;
  location: string;
  description: string;
  version: string;    // change marker; instances append their occurrence start
}

function cleanText(s: unknown): string {
  if (s == null) return "";
  return String(s).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function eventVersion(ev: any): string {
  const c = ev.component;
  const lm = c.getFirstPropertyValue("last-modified");
  if (lm) return lm.toString();
  const ds = c.getFirstPropertyValue("dtstamp");
  if (ds) return ds.toString();
  return String(c.getFirstPropertyValue("sequence") ?? "0");
}

function isCancelled(ev: any): boolean {
  return String(ev.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
}

function pushSingle(ev: any, startMs: number, endMs: number, out: Occurrence[]): void {
  if (!ev.uid || isCancelled(ev)) return;
  const s = ev.startDate.toJSDate().getTime();
  const e = (ev.endDate ?? ev.startDate).toJSDate().getTime();
  if (e < startMs || s > endMs) return; // no overlap with the window
  out.push({
    key: ev.uid,
    uid: ev.uid,
    isRecurring: false,
    summary: cleanText(ev.summary) || "(no title)",
    start: s,
    end: e,
    allDay: ev.startDate.isDate === true,
    location: cleanText(ev.location),
    description: cleanText(ev.description).slice(0, MAX_DESCRIPTION_CHARS),
    version: eventVersion(ev),
  });
}

/**
 * Slack added to every reach bound, to cover UTC-offset changes.
 *
 * The bound below is measured in absolute milliseconds, but ical.js builds an
 * occurrence by adding the master's WALL-CLOCK duration in the occurrence's own
 * timezone. Those two disagree across a DST transition, in both directions:
 *
 *  - A two-hour event whose end lands in a repeated hour takes THREE absolute
 *    hours, so a bound measured off a master that spans no transition is short
 *    by the offset change.
 *  - A master whose own DTSTART/DTEND straddles a spring-forward gap measures
 *    ONE absolute hour while being two on the wall — and since the master is
 *    what the bound is derived from, that under-measurement would poison every
 *    occurrence of the series forever, including ones nowhere near a transition.
 *
 * Reproducing ical.js's timezone arithmetic per occurrence would mean building
 * the occurrence, which is the exact work the bound exists to avoid. A day of
 * slack sidesteps it: every transition in current tzdata is an hour or less
 * (Lord Howe's is thirty minutes), so this is not a close call. It costs almost
 * nothing, because the bound is compared against a window that opens two days
 * back — a year-old weekly series still rejects 51 of its 52 occurrences.
 */
const REACH_DST_SLACK_MS = DAY_MS;

/**
 * The furthest past its nominal start that an occurrence of this series can
 * still be running — its longest possible (end − recurrence time), plus the
 * slack above.
 *
 * This is what lets the walk below reject a spent occurrence from the iterator's
 * own time, without building the occurrence first. It has to bound overrides as
 * well as the master, because a RECURRENCE-ID instance can be both moved later
 * and made longer; `end − recurrence-id` covers those two in one number. An
 * override we cannot read returns Infinity, which disables the shortcut for this
 * series rather than risking a wrong skip.
 */
function seriesReachMs(ev: any, exceptions: any[]): number {
  let reach = ev.endDate.toJSDate().getTime() - ev.startDate.toJSDate().getTime();
  for (const ex of exceptions) {
    try {
      const rid = ex.getFirstPropertyValue("recurrence-id");
      if (!rid) continue;
      const end = new ICAL.Event(ex).endDate.toJSDate().getTime();
      reach = Math.max(reach, end - rid.toJSDate().getTime());
    } catch {
      return Infinity;
    }
  }
  return Math.max(reach, 0) + REACH_DST_SLACK_MS;
}

function expandRecurring(ev: any, startMs: number, endMs: number, out: Occurrence[], reachMs: number): void {
  if (!ev.uid) return;
  const it = ev.iterator();
  let next: any;
  let iter = 0;
  let emitted = 0;
  while ((next = it.next())) {
    if (++iter > MAX_ITER) break;
    const occStartMs = next.toJSDate().getTime();
    if (occStartMs > endMs) break; // iterator is chronological — nothing further is in-window
    // Cheap rejection before the expensive one. ev.iterator() walks from DTSTART,
    // so on a series that has been running for a year the great majority of the
    // occurrences visited here ended long before the window opens — measured at
    // 91% for weekly series a year old, and getOccurrenceDetails is where
    // essentially all of the expansion's CPU goes (#290). Deciding it from the
    // iterator's own time skips building the occurrence at all. The reach bound
    // is what keeps this exact for events still running when the window opens,
    // including across a DST transition — see seriesReachMs.
    if (occStartMs + reachMs < startMs) continue;
    const details = ev.getOccurrenceDetails(next);
    const e = details.endDate.toJSDate().getTime();
    if (e < startMs) continue;                 // occurrence already ended before window
    if (isCancelled(details.item)) continue;   // an override cancelled this instance
    const s = details.startDate.toJSDate().getTime();
    if (s > endMs) continue;
    const startISO = new Date(s).toISOString();
    out.push({
      key: `${ev.uid}::${startISO}`,
      uid: ev.uid,
      isRecurring: true,
      summary: cleanText(details.item.summary) || "(no title)",
      start: s,
      end: e,
      allDay: details.startDate.isDate === true,
      location: cleanText(details.item.location),
      description: cleanText(details.item.description).slice(0, MAX_DESCRIPTION_CHARS),
      version: `${eventVersion(details.item)}::${startISO}`,
    });
    if (++emitted >= MAX_OCCURRENCES_PER_EVENT) break;
  }
}

// Parse an .ics document and expand it into concrete occurrences within
// [windowStartMs, windowEndMs]. Registers embedded VTIMEZONEs so TZID-based
// times resolve to the right absolute instants.
export function parseAndExpand(icsText: string, windowStartMs: number, windowEndMs: number): Occurrence[] {
  const root = new ICAL.Component(ICAL.parse(icsText));

  for (const vtz of root.getAllSubcomponents("vtimezone")) {
    try {
      const tz = new ICAL.Timezone(vtz);
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(vtz);
    } catch { /* a bad VTIMEZONE shouldn't sink the whole calendar */ }
  }

  // Group VEVENT components by UID: one master (no RECURRENCE-ID) plus any
  // RECURRENCE-ID overrides. Each master is constructed with its OWN overrides
  // via the constructor's `exceptions` option — this scopes exceptions to this
  // series (ical.js would otherwise auto-relate EVERY override in the whole
  // calendar to EVERY master) AND avoids calling relateException on an orphan
  // exception, which throws "cannot relate exception to exceptions".
  const groups = new Map<string, { master: any; exceptions: any[] }>();
  for (const ve of root.getAllSubcomponents("vevent")) {
    const uid = ve.getFirstPropertyValue("uid");
    if (typeof uid !== "string" || !uid) continue;
    let g = groups.get(uid);
    if (!g) { g = { master: null, exceptions: [] }; groups.set(uid, g); }
    if (ve.hasProperty("recurrence-id")) g.exceptions.push(ve);
    else g.master = ve; // last one wins on a duplicate master (malformed feed)
  }

  const out: Occurrence[] = [];
  for (const g of groups.values()) {
    try {
      if (g.master) {
        const ev = new ICAL.Event(g.master, { exceptions: g.exceptions });
        if (ev.isRecurring()) {
          expandRecurring(ev, windowStartMs, windowEndMs, out, seriesReachMs(ev, g.exceptions));
        } else pushSingle(ev, windowStartMs, windowEndMs, out);
      } else {
        // No master in the feed (e.g. Google exports only the modified instances
        // of a series whose master is out of range): emit each override as a
        // standalone single occurrence — the best we can do without the master.
        for (const exComp of g.exceptions) {
          pushSingle(new ICAL.Event(exComp), windowStartMs, windowEndMs, out);
        }
      }
    } catch (e) {
      console.error(`Calendar: skipped a malformed event group (non-fatal):`, e);
    }
  }
  return out;
}

// ── Memory content ─────────────────────────────────────────────────────────
// Times render in UTC with an explicit marker — the occurrence already resolved
// to an absolute instant during parsing; display-timezone localization is a
// deliberate v1 simplification.
function pad(n: number): string { return String(n).padStart(2, "0"); }
function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// Lead with title + when so the embedding keys on them (mirrors Notion leading
// with title + URL).
export function buildEventContent(occ: Occurrence): string {
  const when = occ.allDay
    ? `${fmtDate(occ.start)} (all day)`
    : `${fmtDate(occ.start)} ${fmtTime(occ.start)}–${fmtTime(occ.end)}`;
  const lines: string[] = [`# ${occ.summary}`, when];
  if (occ.location) lines.push(`📍 ${occ.location}`);
  if (occ.description) lines.push("", occ.description);
  return lines.join("\n").trim();
}

// ── Sync planning (pure) ───────────────────────────────────────────────────
// Per-occurrence start/end live in a side map (persisted in the record's
// config), because ItemMapEntry only carries { entryId, version }. The sweep
// needs `start` (cancelled-upcoming vs aged-past) and retention needs `end`.
export interface CalendarMetaEntry { start: number; end: number; isRecurring: boolean }
export interface CalendarPlan { changed: Occurrence[]; deletedKeys: string[] }

export function computeCalendarPlan(
  occurrences: Occurrence[],
  itemMap: Record<string, ItemMapEntry>,
  metaByKey: Record<string, CalendarMetaEntry>,
  nowMs: number,
): CalendarPlan {
  const present = new Set(occurrences.map((o) => o.key));
  const changed = occurrences
    .filter((o) => itemMap[o.key]?.version !== o.version)
    .sort((a, b) => a.start - b.start); // oldest first → partial batches converge

  const deletedKeys: string[] = [];
  for (const key of Object.keys(itemMap)) {
    if (present.has(key)) continue;
    const meta = metaByKey[key];
    // Vanished from the feed: delete only if it was UPCOMING (cancelled before
    // it happened). A past occurrence just aged out of the window → keep it.
    if (meta && meta.start > nowMs) deletedKeys.push(key);
  }
  return { changed, deletedKeys };
}

// Keys whose occurrence is old enough to prune. One-offs (and, in v1, recurring
// instances) use retentionMs. When recurringRetentionMs is non-null (P1),
// recurring instances use that shorter horizon instead.
export function computeRetentionPrune(
  metaByKey: Record<string, CalendarMetaEntry>,
  nowMs: number,
  opts: { retentionMs: number; recurringRetentionMs: number | null },
): string[] {
  const prune: string[] = [];
  for (const [key, meta] of Object.entries(metaByKey)) {
    const age = nowMs - meta.end;
    if (age <= 0) continue; // hasn't happened yet
    const horizon =
      meta.isRecurring && opts.recurringRetentionMs != null
        ? opts.recurringRetentionMs
        : opts.retentionMs;
    if (age > horizon) prune.push(key);
  }
  return prune;
}

// ── Connection + sync ──────────────────────────────────────────────────────
export interface CalendarService {
  id: string;
  name: string;
  connectLabel: string;
  connectPlaceholder: string;
  connectHint: string;
}

function normalizeUrl(raw: string): string {
  const swapped = raw.trim().replace(/^webcal:\/\//i, "https://");
  const u = new URL(swapped); // throws on garbage
  if (u.protocol !== "https:") throw new Error("Calendar link must be an https:// or webcal:// URL.");
  return u.toString();
}

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "text/calendar" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Validate a pasted secret iCal URL and return a display label for the UI.
export async function validateCalendarUrl(rawUrl: string): Promise<string> {
  const url = normalizeUrl(rawUrl);
  let body: string;
  try {
    body = await fetchIcs(url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Couldn't reach that calendar link (${msg}). Double-check the secret iCal URL.`);
  }
  let root: any;
  try {
    root = new ICAL.Component(ICAL.parse(body));
  } catch {
    throw new Error("That link didn't return a calendar. Make sure it's the secret iCal (.ics) address, not the calendar's web page.");
  }
  if (root.name !== "vcalendar") {
    throw new Error("That link didn't return a calendar (no VCALENDAR found).");
  }
  return (root.getFirstPropertyValue("x-wr-calname") as string) || new URL(url).host;
}

function getMeta(record: IntegrationRecord): Record<string, CalendarMetaEntry> {
  const m = (record.config as any)?.calendarMeta;
  return m && typeof m === "object" ? (m as Record<string, CalendarMetaEntry>) : {};
}

async function runCalendarSync(env: IntegrationEnv, store: MirrorStore, providerId: string): Promise<SyncOutcome> {
  const record = await loadIntegration(env, providerId);
  if (!record) return { ok: false, error: "Calendar is not connected" };

  const now = Date.now();

  let occurrences: Occurrence[];
  try {
    const body = await fetchIcs(normalizeUrl(record.credentials.token));
    occurrences = parseAndExpand(body, now - PAST_LOOKBACK_MS, now + FUTURE_WINDOW_MS);
  } catch (e) {
    record.status = "error";
    record.lastSyncError = e instanceof Error ? e.message : String(e);
    record.updatedAt = now;
    await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  }

  const meta = getMeta(record);
  const plan = computeCalendarPlan(occurrences, record.itemMap, meta, now);
  // Don't create occurrences that retention would prune this same run (e.g. with
  // RECURRING_RETENTION_MS=0, already-past recurring instances). Otherwise every
  // sync re-creates then immediately re-deletes them — wasting the subrequest
  // budget and, past ~SYNC_EVENT_BATCH of them, keeping `remaining` above 0
  // forever so genuinely-new upcoming events never get reached.
  const creatable = plan.changed.filter((occ) => {
    const horizon = occ.isRecurring && RECURRING_RETENTION_MS != null ? RECURRING_RETENTION_MS : RETENTION_MS;
    return now - occ.end <= horizon;
  });
  const batch = creatable.slice(0, SYNC_EVENT_BATCH);

  let created = 0, updated = 0, failed = 0;
  for (const occ of batch) {
    try {
      const content = buildEventContent(occ);
      const existing = record.itemMap[occ.key];
      if (existing && (await store.updateEntry(existing.entryId, content))) {
        record.itemMap[occ.key] = { entryId: existing.entryId, version: occ.version };
        updated++;
      } else {
        // New occurrence — or its mirror was deleted out-of-band; (re-)create it.
        const entryId = await store.createEntry(content, ["calendar", providerId], providerId);
        record.itemMap[occ.key] = { entryId, version: occ.version };
        created++;
      }
      meta[occ.key] = { start: occ.start, end: occ.end, isRecurring: occ.isRecurring };
    } catch (e) {
      // Non-fatal: the map doesn't advance for this occurrence, so the next run retries it.
      console.error(`Calendar sync failed for ${occ.key} (non-fatal):`, e);
      failed++;
    }
  }

  // Delete cancelled-upcoming occurrences + retention-pruned history.
  const toDelete = new Set<string>(plan.deletedKeys);
  for (const key of computeRetentionPrune(meta, now, {
    retentionMs: RETENTION_MS,
    recurringRetentionMs: RECURRING_RETENTION_MS,
  })) {
    toDelete.add(key);
  }

  let deleted = 0;
  for (const key of toDelete) {
    const mapped = record.itemMap[key];
    try {
      if (mapped) await store.deleteEntry(mapped.entryId);
      delete record.itemMap[key];
      delete meta[key];
      if (mapped) deleted++;
    } catch (e) {
      console.error(`Calendar mirror delete failed for ${key} (non-fatal):`, e);
    }
  }

  (record.config as any).calendarMeta = meta;
  record.status = "connected";
  record.lastSyncedAt = now;
  record.lastSyncError = null;
  record.updatedAt = now;
  await saveIntegration(env, record);

  return {
    ok: true,
    created,
    updated,
    deleted,
    failed,
    remaining: creatable.length - batch.length,
    total: occurrences.length,
  };
}

// Build a provider bound to one calendar service. All three services share
// this implementation; only id/name/hints differ.
export function makeCalendarProvider(svc: CalendarService): IntegrationProvider {
  return {
    id: svc.id,
    name: svc.name,
    category: "calendar",
    connectLabel: svc.connectLabel,
    connectPlaceholder: svc.connectPlaceholder,
    connectHint: svc.connectHint,
    validateToken: validateCalendarUrl,
    sync: (env, store) => runCalendarSync(env, store, svc.id),
  };
}
