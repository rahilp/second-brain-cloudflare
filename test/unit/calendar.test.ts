import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseAndExpand,
  buildEventContent,
  computeCalendarPlan,
  computeRetentionPrune,
  validateCalendarUrl,
  makeCalendarProvider,
} from "../../src/integrations";
import type { Occurrence, CalendarMetaEntry, ItemMapEntry, IntegrationRecord } from "../../src/integrations";
import { makeMemoryKV } from "../helpers/make-env";

const DAY_MS = 86_400_000;
const ms = (iso: string) => Date.parse(iso);

// ── ICS fixture helpers ─────────────────────────────────────────────────────
function calendar(...veventBlocks: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", ...veventBlocks, "END:VCALENDAR"].join(
    "\r\n",
  );
}
function vevent(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

describe("parseAndExpand", () => {
  it("returns a single timed event inside the window", () => {
    const ics = calendar(
      vevent([
        "UID:single-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T140000Z",
        "DTEND:20260710T150000Z",
        "SUMMARY:Team Meeting",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    const occ = occs[0];
    expect(occ.summary).toBe("Team Meeting");
    expect(occ.uid).toBe("single-1@test");
    expect(occ.key).toBe("single-1@test");
    expect(occ.start).toBe(ms("2026-07-10T14:00:00Z"));
    expect(occ.end).toBe(ms("2026-07-10T15:00:00Z"));
    expect(occ.isRecurring).toBe(false);
    expect(occ.allDay).toBe(false);
  });

  it("marks a DATE-valued DTSTART as an all-day event", () => {
    const ics = calendar(
      vevent([
        "UID:allday-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART;VALUE=DATE:20260715",
        "DTEND;VALUE=DATE:20260716",
        "SUMMARY:Company Holiday",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toHaveLength(1);
    expect(occs[0].allDay).toBe(true);
  });

  it("expands a weekly RRULE to only the in-window instances", () => {
    // Master starts 2026-06-01 (well before the window), weekly on Mondays.
    const ics = calendar(
      vevent([
        "UID:weekly-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=20",
        "SUMMARY:Standup",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    // Mondays in July 2026 within [07-01, 07-31): 07-06, 07-13, 07-20, 07-27.
    expect(occs).toHaveLength(4);
    const starts = occs.map((o) => new Date(o.start).toISOString()).sort();
    expect(starts).toEqual([
      "2026-07-06T10:00:00.000Z",
      "2026-07-13T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
    ]);
    for (const o of occs) {
      expect(o.isRecurring).toBe(true);
      expect(o.uid).toBe("weekly-1@test");
      expect(o.key).toBe(`weekly-1@test::${new Date(o.start).toISOString()}`);
    }
  });

  it("omits an instance removed by EXDATE", () => {
    const ics = calendar(
      vevent([
        "UID:weekly-2@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=20",
        "EXDATE:20260713T100000Z",
        "SUMMARY:Standup",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    const starts = occs.map((o) => new Date(o.start).toISOString());
    expect(starts).not.toContain("2026-07-13T10:00:00.000Z");
    expect(starts).toEqual([
      "2026-07-06T10:00:00.000Z",
      "2026-07-20T10:00:00.000Z",
      "2026-07-27T10:00:00.000Z",
    ]);
  });

  it("excludes a single event with STATUS:CANCELLED", () => {
    const ics = calendar(
      vevent([
        "UID:cancelled-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260710T140000Z",
        "DTEND:20260710T150000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Cancelled Meeting",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toEqual([]);
  });

  it("does not let one series' RECURRENCE-ID override contaminate another series (cross-series isolation)", () => {
    const ics = calendar(
      vevent([
        "UID:series-A@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
        "SUMMARY:Series A",
      ]),
      vevent([
        "UID:series-A@test",
        "RECURRENCE-ID:20260706T100000Z",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260706T120000Z",
        "DTEND:20260706T130000Z",
        "SUMMARY:Series A (moved)",
      ]),
      vevent([
        "UID:series-B@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260601T100000Z",
        "DTEND:20260601T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
        "SUMMARY:Series B",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));

    const seriesA = occs.filter((o) => o.uid === "series-A@test");
    const seriesB = occs.filter((o) => o.uid === "series-B@test");
    expect(seriesA).toHaveLength(4);
    expect(seriesB).toHaveLength(4);

    // Series A's July 6th instance is the override: moved to 12:00 with a new summary.
    const overridden = seriesA.find((o) => new Date(o.start).toISOString() === "2026-07-06T12:00:00.000Z");
    expect(overridden?.summary).toBe("Series A (moved)");

    // Series B keeps its own summary at every instance, including the same calendar
    // date — it must NOT pick up series A's override.
    expect(seriesB.every((o) => o.summary === "Series B")).toBe(true);
    const seriesBJuly6 = seriesB.find((o) => new Date(o.start).toISOString() === "2026-07-06T10:00:00.000Z");
    expect(seriesBJuly6?.summary).toBe("Series B");
  });

  it("emits a lone RECURRENCE-ID override with no master as a standalone occurrence, without throwing", () => {
    const ics = calendar(
      vevent([
        "UID:orphan-1@test",
        "RECURRENCE-ID:20260706T100000Z",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20260706T120000Z",
        "DTEND:20260706T130000Z",
        "SUMMARY:Orphan Instance",
      ]),
    );
    let occs: Occurrence[] = [];
    expect(() => {
      occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    }).not.toThrow();
    expect(occs).toHaveLength(1);
    expect(occs[0]).toMatchObject({
      key: "orphan-1@test",
      uid: "orphan-1@test",
      isRecurring: false,
      summary: "Orphan Instance",
    });
  });

  it("does not return an event entirely outside the window", () => {
    const ics = calendar(
      vevent([
        "UID:outside-1@test",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20250101T140000Z",
        "DTEND:20250101T150000Z",
        "SUMMARY:Long Ago",
      ]),
    );
    const occs = parseAndExpand(ics, ms("2026-07-01T00:00:00Z"), ms("2026-07-31T00:00:00Z"));
    expect(occs).toEqual([]);
  });
});

describe("computeCalendarPlan", () => {
  function occ(overrides: Partial<Occurrence>): Occurrence {
    return {
      key: "k1",
      uid: "u1",
      isRecurring: false,
      summary: "Event",
      start: ms("2026-07-10T14:00:00Z"),
      end: ms("2026-07-10T15:00:00Z"),
      allDay: false,
      location: "",
      description: "",
      version: "v1",
      ...overrides,
    };
  }
  const itemMap = (entries: Record<string, string>): Record<string, ItemMapEntry> =>
    Object.fromEntries(Object.entries(entries).map(([key, version]) => [key, { entryId: `e-${key}`, version }]));

  it("treats an occurrence unseen in itemMap as changed", () => {
    const plan = computeCalendarPlan([occ({ key: "new-1" })], {}, {}, ms("2026-07-01T00:00:00Z"));
    expect(plan.changed.map((o) => o.key)).toEqual(["new-1"]);
    expect(plan.deletedKeys).toEqual([]);
  });

  it("treats a version mismatch as changed and a matching version as unchanged", () => {
    const map = itemMap({ same: "v1", stale: "v-old" });
    const plan = computeCalendarPlan(
      [occ({ key: "same", version: "v1" }), occ({ key: "stale", version: "v-new" })],
      map,
      {},
      ms("2026-07-01T00:00:00Z"),
    );
    expect(plan.changed.map((o) => o.key)).toEqual(["stale"]);
  });

  it("sorts changed occurrences by start ascending", () => {
    const plan = computeCalendarPlan(
      [
        occ({ key: "later", version: "v1", start: ms("2026-07-20T00:00:00Z") }),
        occ({ key: "earlier", version: "v1", start: ms("2026-07-05T00:00:00Z") }),
      ],
      {},
      {},
      ms("2026-07-01T00:00:00Z"),
    );
    expect(plan.changed.map((o) => o.key)).toEqual(["earlier", "later"]);
  });

  it("deletes an itemMap key missing from occurrences when it was upcoming (cancelled-upcoming)", () => {
    const map = itemMap({ gone: "v1" });
    const meta: Record<string, CalendarMetaEntry> = {
      gone: { start: ms("2026-08-01T00:00:00Z"), end: ms("2026-08-01T01:00:00Z"), isRecurring: false },
    };
    const plan = computeCalendarPlan([], map, meta, ms("2026-07-15T00:00:00Z"));
    expect(plan.deletedKeys).toEqual(["gone"]);
  });

  it("keeps (does not delete) an itemMap key missing from occurrences when it already happened", () => {
    const map = itemMap({ aged: "v1" });
    const meta: Record<string, CalendarMetaEntry> = {
      aged: { start: ms("2026-07-01T00:00:00Z"), end: ms("2026-07-01T01:00:00Z"), isRecurring: false },
    };
    const plan = computeCalendarPlan([], map, meta, ms("2026-07-15T00:00:00Z"));
    expect(plan.deletedKeys).toEqual([]);
  });
});

describe("computeRetentionPrune", () => {
  const RETENTION = 180 * DAY_MS;

  it("keeps a one-off that ended within retentionMs and prunes one older than retentionMs", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      recent: { start: now - 10 * DAY_MS - 3600_000, end: now - 10 * DAY_MS, isRecurring: false },
      ancient: { start: now - 200 * DAY_MS - 3600_000, end: now - 200 * DAY_MS, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).not.toContain("recent");
    expect(pruned).toContain("ancient");
  });

  it("never prunes an entry that hasn't ended yet", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      future: { start: now + DAY_MS, end: now + 2 * DAY_MS, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).toEqual([]);
  });

  it("with recurringRetentionMs:0, prunes a past recurring instance immediately but keeps a past one-off within retentionMs", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      pastRecurring: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: true },
      pastOneOff: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: false },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: 0 });
    expect(pruned).toContain("pastRecurring");
    expect(pruned).not.toContain("pastOneOff");
  });

  it("with recurringRetentionMs:null, a past recurring entry uses retentionMs instead", () => {
    const now = ms("2026-07-23T00:00:00Z");
    const meta: Record<string, CalendarMetaEntry> = {
      pastRecurring: { start: now - 2 * 3600_000, end: now - 3600_000, isRecurring: true },
    };
    const pruned = computeRetentionPrune(meta, now, { retentionMs: RETENTION, recurringRetentionMs: null });
    expect(pruned).toEqual([]); // only 1 hour old, well within the 180-day retentionMs horizon
  });
});

describe("buildEventContent", () => {
  function occ(overrides: Partial<Occurrence>): Occurrence {
    return {
      key: "k1",
      uid: "u1",
      isRecurring: false,
      summary: "Team Sync",
      start: ms("2026-07-10T14:00:00Z"),
      end: ms("2026-07-10T15:00:00Z"),
      allDay: false,
      location: "",
      description: "",
      version: "v1",
      ...overrides,
    };
  }

  it("leads with the summary as a heading", () => {
    const content = buildEventContent(occ({}));
    expect(content.startsWith("# Team Sync\n")).toBe(true);
  });

  it("shows the UTC date/time range for a timed event", () => {
    const content = buildEventContent(occ({}));
    expect(content).toContain("2026-07-10 14:00 UTC–15:00 UTC");
  });

  it("shows (all day) for an all-day event instead of a time range", () => {
    const content = buildEventContent(
      occ({ allDay: true, start: ms("2026-07-15T00:00:00Z"), end: ms("2026-07-16T00:00:00Z") }),
    );
    expect(content).toContain("2026-07-15 (all day)");
    expect(content).not.toContain("UTC–");
  });

  it("includes a location line with a pin marker only when location is present", () => {
    const withLocation = buildEventContent(occ({ location: "Room 5" }));
    expect(withLocation).toContain("📍 Room 5");

    const withoutLocation = buildEventContent(occ({ location: "" }));
    expect(withoutLocation).not.toContain("📍");
  });

  it("appends the description only when present", () => {
    const withDescription = buildEventContent(occ({ description: "Discuss roadmap" }));
    expect(withDescription).toContain("Discuss roadmap");

    const withoutDescription = buildEventContent(occ({ description: "" }));
    expect(withoutDescription.trim().endsWith("Discuss roadmap")).toBe(false);
    expect(withoutDescription).toBe("# Team Sync\n2026-07-10 14:00 UTC–15:00 UTC");
  });
});

describe("validateCalendarUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(impl: (url: string) => { ok: boolean; status: number; text: () => Promise<string> }) {
    const fn = vi.fn().mockImplementation(async (url: string) => impl(url));
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("normalizes webcal:// to https:// and resolves the X-WR-CALNAME as the label", async () => {
    const fetchMock = stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () =>
        ["BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:My Cal", "PRODID:-//Test//Test//EN", "END:VCALENDAR"].join(
          "\r\n",
        ),
    }));
    const label = await validateCalendarUrl("webcal://example.com/cal.ics");
    expect(label).toBe("My Cal");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/cal.ics",
      expect.objectContaining({ headers: { Accept: "text/calendar" } }),
    );
  });

  it("falls back to the URL host when there is no X-WR-CALNAME", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      text: async () => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//Test//EN", "END:VCALENDAR"].join("\r\n"),
    }));
    const label = await validateCalendarUrl("https://cal.example.org/feed.ics");
    expect(label).toBe("cal.example.org");
  });

  it("rejects with a user-facing error on a non-2xx response", async () => {
    stubFetch(() => ({ ok: false, status: 404, text: async () => "not found" }));
    await expect(validateCalendarUrl("https://example.com/missing.ics")).rejects.toThrow(
      /Couldn't reach that calendar link/,
    );
  });

  it("rejects when the body is not an iCal document", async () => {
    stubFetch(() => ({ ok: true, status: 200, text: async () => "<html><body>not a calendar</body></html>" }));
    await expect(validateCalendarUrl("https://example.com/page.html")).rejects.toThrow(
      /didn't return a calendar/,
    );
  });
});

describe("makeCalendarProvider sync (happy path)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function toIcsUtc(epochMs: number): string {
    return new Date(epochMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  it("creates one mirror entry from a connected feed with one upcoming event", async () => {
    const now = Date.now();
    const start = now + 5 * DAY_MS;
    const end = start + 3600_000;
    const ics = calendar(
      vevent([
        "UID:sync-event-1@test",
        `DTSTAMP:${toIcsUtc(now)}`,
        `DTSTART:${toIcsUtc(start)}`,
        `DTEND:${toIcsUtc(end)}`,
        "SUMMARY:Upcoming Event",
      ]),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => ics }),
    );

    const kv = makeMemoryKV();
    const record: IntegrationRecord = {
      provider: "calendar-google",
      authKind: "token",
      credentials: { token: "https://cal.example/x.ics" },
      config: {},
      status: "connected",
      workspaceName: "My Cal",
      lastSyncedAt: null,
      lastSyncError: null,
      itemMap: {},
      createdAt: 0,
      updatedAt: 0,
    };
    await kv.put("integrations:calendar-google", JSON.stringify(record));

    const created: Array<{ content: string; tags: string[]; source: string }> = [];
    const store = {
      createEntry: vi.fn().mockImplementation(async (content: string, tags: string[], source: string) => {
        created.push({ content, tags, source });
        return "entry-fake-1";
      }),
      updateEntry: vi.fn().mockResolvedValue(true),
      deleteEntry: vi.fn().mockResolvedValue(undefined),
    };

    const provider = makeCalendarProvider({
      id: "calendar-google",
      name: "Google Calendar",
      connectLabel: "",
      connectPlaceholder: "",
      connectHint: "",
    });

    const outcome = await provider.sync({ OAUTH_KV: kv }, store);

    expect(outcome).toMatchObject({ ok: true, created: 1, updated: 0, failed: 0, deleted: 0, total: 1 });
    expect(store.createEntry).toHaveBeenCalledTimes(1);
    expect(created[0].tags).toEqual(["calendar", "calendar-google"]);
    expect(created[0].source).toBe("calendar-google");
    expect(created[0].content).toContain("# Upcoming Event");

    const saved = JSON.parse((await kv.get("integrations:calendar-google")) as string);
    expect(saved.itemMap["sync-event-1@test"]).toMatchObject({ entryId: "entry-fake-1" });
    expect(saved.status).toBe("connected");
    expect(saved.lastSyncedAt).not.toBeNull();
  });
});
