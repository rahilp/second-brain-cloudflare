import { describe, it, expect } from "vitest";
import {
  parseEmailToken,
  isNoiseSender,
  looksBulk,
  computeEmailPlan,
  cleanEmailBody,
  buildEmailContent,
  parseHeaders,
  imapDate,
} from "../../src/integrations";
import type { EmailHeaderInfo } from "../../src/integrations";

// ─── looksBulk ──────────────────────────────────────────────────────────────

describe("looksBulk", () => {
  const personToPerson: Record<string, string> = {
    from: "jordan@example.com",
    to: "me@example.com",
    subject: "Hey",
    date: "Mon, 5 Jan 2026 10:00:00 -0500",
    "message-id": "<abc123@example.com>",
  };

  it("returns false for a plain person-to-person header set", () => {
    expect(looksBulk(personToPerson)).toBe(false);
  });

  const bulkKeys = [
    "list-unsubscribe",
    "list-id",
    "list-post",
    "feedback-id",
    "x-feedback-id",
    "x-auto-response-suppress",
    "x-campaign",
    "x-campaignid",
    "campaign-id",
    "errors-to",
  ];

  for (const key of bulkKeys) {
    it(`returns true when '${key}' is present`, () => {
      expect(looksBulk({ ...personToPerson, [key]: "1" })).toBe(true);
    });
  }

  it("treats precedence: bulk/list/junk as bulk", () => {
    expect(looksBulk({ ...personToPerson, precedence: "bulk" })).toBe(true);
    expect(looksBulk({ ...personToPerson, precedence: "list" })).toBe(true);
    expect(looksBulk({ ...personToPerson, precedence: "junk" })).toBe(true);
  });

  it("does not treat other precedence values as bulk by themselves", () => {
    expect(looksBulk({ ...personToPerson, precedence: "something-else" })).toBe(false);
  });

  it("treats any non-'no' auto-submitted value as bulk", () => {
    expect(looksBulk({ ...personToPerson, "auto-submitted": "auto-generated" })).toBe(true);
    expect(looksBulk({ ...personToPerson, "auto-submitted": "auto-replied" })).toBe(true);
  });

  it("does not treat auto-submitted: no as bulk", () => {
    expect(looksBulk({ ...personToPerson, "auto-submitted": "no" })).toBe(false);
  });
});

// ─── isNoiseSender ──────────────────────────────────────────────────────────

describe("isNoiseSender", () => {
  it.each([
    "<no-reply@x.com>",
    "noreply@x.com",
    "notifications@x.com",
    "alerts@x.com",
    "mailer-daemon@x.com",
    "bounce@x.com",
  ])("treats %s as a noise sender", (from) => {
    expect(isNoiseSender(from)).toBe(true);
  });

  it("treats a real person as not a noise sender", () => {
    expect(isNoiseSender('"Jordan Lee" <jordan@gmail.com>')).toBe(false);
  });

  it("handles bare addresses (no angle brackets)", () => {
    expect(isNoiseSender("noreply@x.com")).toBe(true);
    expect(isNoiseSender("jordan@gmail.com")).toBe(false);
  });

  it("handles Name <addr> form", () => {
    expect(isNoiseSender("No Reply <no-reply@x.com>")).toBe(true);
    expect(isNoiseSender("Mailer Daemon <mailer-daemon@x.com>")).toBe(true);
    expect(isNoiseSender("Jordan Lee <jordan@gmail.com>")).toBe(false);
  });
});

// ─── computeEmailPlan ───────────────────────────────────────────────────────

describe("computeEmailPlan", () => {
  const base = (over: Partial<EmailHeaderInfo>): EmailHeaderInfo => ({
    uid: 1,
    messageId: "id-1",
    from: "jordan@example.com",
    subject: "Hi",
    date: "Mon, 5 Jan 2026 10:00:00 -0500",
    bulk: false,
    ...over,
  });

  it("excludes bulk mail, noise senders, and already-ingested messages; keeps genuine mail sorted by uid ascending", () => {
    const headers: EmailHeaderInfo[] = [
      base({ uid: 30, messageId: "m30", from: "jordan@example.com" }), // genuine, keep
      base({ uid: 10, messageId: "m10", from: "newsletter@brand.com", bulk: true }), // bulk, drop
      base({ uid: 20, messageId: "m20", from: "noreply@service.com" }), // noise sender, drop
      base({ uid: 5, messageId: "m5", from: "sam@example.com" }), // already ingested, drop
      base({ uid: 15, messageId: "m15", from: "sam@example.com" }), // genuine, keep
    ];
    const ingestedIds = new Set(["m5"]);

    const plan = computeEmailPlan(headers, ingestedIds);

    expect(plan.map((h) => h.uid)).toEqual([15, 30]);
  });

  it("returns an empty plan when every candidate is filtered out", () => {
    const headers: EmailHeaderInfo[] = [
      base({ uid: 1, messageId: "m1", bulk: true }),
      base({ uid: 2, messageId: "m2", from: "noreply@x.com" }),
      base({ uid: 3, messageId: "m3" }),
    ];
    expect(computeEmailPlan(headers, new Set(["m3"]))).toEqual([]);
  });
});

// ─── cleanEmailBody ─────────────────────────────────────────────────────────

describe("cleanEmailBody", () => {
  it("cuts a quoted reply chain", () => {
    const raw =
      "Hey, thanks for that!\n\n" +
      "On Mon, Jan 5, 2026 at 10:00 AM, Jordan Lee <jordan@x.com> wrote:\n" +
      "> Previous message text\n" +
      "> more quoted text";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Hey, thanks for that!");
    expect(result).not.toContain("Previous message");
    expect(result).not.toContain("wrote:");
  });

  it("drops a signature after '-- '", () => {
    const raw = "Hello there,\nMain content.\n-- \nJordan\nCEO, Example Inc.";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Hello there,\nMain content.");
    expect(result).not.toContain("Jordan");
    expect(result).not.toContain("CEO");
  });

  it("drops leading '>' quote lines", () => {
    const raw = "Real line one\n> quoted line\nReal line two\n   > indented quoted";

    const result = cleanEmailBody(raw);

    expect(result).toBe("Real line one\nReal line two");
  });

  it("caps the body at the max length and appends an ellipsis", () => {
    const huge = "x".repeat(5000);

    const result = cleanEmailBody(huge);

    expect(result.length).toBe(4002); // 4000 chars + "\n…"
    expect(result.endsWith("\n…")).toBe(true);
    expect(result.startsWith("x".repeat(4000))).toBe(true);
  });

  it("keeps ordinary body text untouched", () => {
    const raw = "Just a normal short message with no quoting or signature.";
    expect(cleanEmailBody(raw)).toBe(raw);
  });
});

// ─── buildEmailContent ──────────────────────────────────────────────────────

describe("buildEmailContent", () => {
  it("leads with the subject heading, then a From line with the date, then the body", () => {
    const content = buildEmailContent(
      "Meeting notes",
      "Jordan Lee <jordan@example.com>",
      "Mon, 5 Jan 2026 10:00:00 -0500",
      "Let's meet at 3pm.",
    );
    expect(content).toBe(
      "# Meeting notes\nFrom: Jordan Lee <jordan@example.com>  ·  Mon, 5 Jan 2026 10:00:00 -0500\n\nLet's meet at 3pm.",
    );
  });

  it("falls back to '(no subject)' for an empty subject", () => {
    const content = buildEmailContent("", "a@b.com", "", "Body text");
    expect(content).toBe("# (no subject)\nFrom: a@b.com\n\nBody text");
  });

  it("omits the date separator when date is empty", () => {
    const content = buildEmailContent("Subj", "a@b.com", "", "Body");
    expect(content).toBe("# Subj\nFrom: a@b.com\n\nBody");
  });

  it("omits the body block entirely when body is empty", () => {
    const content = buildEmailContent("Subj", "a@b.com", "Mon, 5 Jan 2026", "");
    expect(content).toBe("# Subj\nFrom: a@b.com  ·  Mon, 5 Jan 2026");
  });
});

// ─── parseEmailToken ────────────────────────────────────────────────────────

describe("parseEmailToken", () => {
  it("parses a valid JSON token and trims the email", () => {
    const token = JSON.stringify({ email: "  test@x.com  ", appPassword: "abcd-1234" });
    expect(parseEmailToken(token)).toEqual({ email: "test@x.com", appPassword: "abcd-1234" });
  });

  it("throws for a non-JSON token", () => {
    expect(() => parseEmailToken("not-json-at-all")).toThrow(
      "This email connection is missing its credentials — please reconnect it.",
    );
  });

  it("throws when the appPassword field is missing", () => {
    const token = JSON.stringify({ email: "test@x.com" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the email field is missing", () => {
    const token = JSON.stringify({ appPassword: "abcd-1234" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the email is empty/whitespace-only", () => {
    const token = JSON.stringify({ email: "   ", appPassword: "abcd-1234" });
    expect(() => parseEmailToken(token)).toThrow();
  });

  it("throws when the appPassword is empty", () => {
    const token = JSON.stringify({ email: "test@x.com", appPassword: "" });
    expect(() => parseEmailToken(token)).toThrow();
  });
});

// ─── parseHeaders ───────────────────────────────────────────────────────────

describe("parseHeaders", () => {
  it("parses Name: value lines into a lowercased-key map, unfolds continuations, and ignores non-header lines", () => {
    const raw = [
      "From: Jordan Lee <jordan@x.com>",
      "Subject: Weekly sync",
      " agenda attached",
      "Date: Mon, 5 Jan 2026 10:00:00 -0500",
      "not a header line without a colon",
      "",
    ].join("\r\n");

    expect(parseHeaders(raw)).toEqual({
      from: "Jordan Lee <jordan@x.com>",
      subject: "Weekly sync agenda attached",
      date: "Mon, 5 Jan 2026 10:00:00 -0500",
    });
  });

  it("unfolds a continuation line indented with a tab", () => {
    const raw = ["X-Custom: first part", "\tsecond part"].join("\r\n");
    expect(parseHeaders(raw)).toEqual({ "x-custom": "first part second part" });
  });
});

// ─── imapDate ───────────────────────────────────────────────────────────────

describe("imapDate", () => {
  it("formats a UTC date as D-Mon-YYYY", () => {
    expect(imapDate(new Date(Date.UTC(2026, 6, 4)))).toBe("4-Jul-2026");
  });

  it("does not zero-pad single-digit days", () => {
    expect(imapDate(new Date(Date.UTC(2026, 0, 1)))).toBe("1-Jan-2026");
  });

  it("formats a two-digit day and December correctly", () => {
    expect(imapDate(new Date(Date.UTC(2025, 11, 25)))).toBe("25-Dec-2025");
  });
});
