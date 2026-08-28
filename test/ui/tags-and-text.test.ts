/**
 * The two client-side primitives Tier 1 rests on: which tags a person sees,
 * and how source text is reduced to something readable.
 *
 * Both decide what every row in the app looks like, and both are pure — so
 * they are tested directly rather than through the DOM.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, it, expect } from "vitest";
import { installI18n } from "./_i18n-harness";

const ROOT = resolve(import.meta.dirname, "../..");

function load(): any {
  const ctx: any = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  installI18n(ctx, "en");
  vm.runInContext(readFileSync(resolve(ROOT, "public/utils.js"), "utf8"), ctx);
  return ctx;
}

describe("isSystemTag / humanTags", () => {
  const { isSystemTag, humanTags } = load();

  it("treats the contradiction marker as the brain's own bookkeeping", () => {
    // captureEntry writes this the moment a contradiction is detected, exactly like
    // the other pipeline markers — it was simply missing from the list.
    expect(isSystemTag("contradiction-resolved")).toBe(true);
    expect(humanTags(["cycling", "contradiction-resolved"])).toEqual(["cycling"]);
  });

  it("hides every reserved namespace the Worker writes", () => {
    for (const t of ["kind:episodic", "status:canonical", "volatility:volatile", "stale:as-of"]) {
      expect(isSystemTag(t), t).toBe(true);
    }
  });

  it("hides pipeline markers", () => {
    for (const t of ["auto-pattern", "auto-insight", "synthesized", "rolled-up", "duplicate-candidate"]) {
      expect(isSystemTag(t), t).toBe(true);
    }
  });

  it("hides the machine identifiers a #token scan mistook for tags", () => {
    // Issue references, colour codes, short commit SHAs — the tag filter was
    // pages of these on a real brain.
    for (const t of ["5118", "298", "fd540a", "002b49", "0f3d3e", "41ace39"]) {
      expect(isSystemTag(t), t).toBe(true);
    }
  });

  it("keeps tags that only look like identifiers", () => {
    // Digits are required, so hex-lookalike words survive; six characters are
    // required, so short technical tags survive; the whole string must be hex,
    // so anything with other characters survives.
    for (const t of ["facade", "decade", "d1", "v2", "12v-battery", "14-day-plan", "q3-2026"]) {
      expect(isSystemTag(t), t).toBe(false);
    }
  });

  it("keeps the user's own vocabulary, in order", () => {
    const tags = ["work", "kind:episodic", "signpath", "5118", "status:canonical", "idea"];
    expect(humanTags(tags)).toEqual(["work", "signpath", "idea"]);
  });

  it("treats malformed input as system rather than rendering it", () => {
    expect(humanTags(["", "  ", null, 42, "real"] as any)).toEqual(["real"]);
    expect(humanTags(null as any)).toEqual([]);
  });

  it("is case-insensitive, because tags arrive from many clients", () => {
    expect(isSystemTag("Kind:Semantic")).toBe(true);
    expect(isSystemTag("STATUS:DEPRECATED")).toBe(true);
  });
});

describe("stripToPlainText / titleLine", () => {
  const { stripToPlainText, titleLine, relativeTime, sourceBadge } = load();

  it("reduces the email shapes that made rows start with punctuation", () => {
    const email = "# Your Uber Pro Card is no longer active\n*************\n[Sign in to your account](https://click.example.com/x)\n\nBalance is $0.";
    const out = stripToPlainText(email);
    expect(out).not.toMatch(/[#*]/);
    expect(out).not.toMatch(/https?:/);
    expect(out).toContain("Sign in to your account");
    expect(out.startsWith("Your Uber Pro Card")).toBe(true);
  });

  it("drops code fences and inline code without eating the prose", () => {
    expect(stripToPlainText("Run ```sh\nnpm run deploy\n``` before merging")).toBe("Run before merging");
    expect(stripToPlainText("Use `npm ci` first")).toBe("Use npm ci first");
  });

  it("takes the first sentence as the title", () => {
    expect(titleLine("Decided to close the account. The balance was zero.")).toBe("Decided to close the account.");
  });

  it("truncates on a boundary when there is no sentence to find", () => {
    // A 200-character single word has no boundaries in it, so this fixture can
    // only ever exercise the fallback — it passed while real prose was being cut
    // mid-word. Kept for the fallback; the prose case is below.
    const long = "x".repeat(200);
    const title = titleLine(long);
    expect(title.length).toBeLessThanOrEqual(90);
    expect(title.endsWith("…")).toBe(true);
  });

  it("never severs a word, and the preview resumes at the same boundary", () => {
    // The card showed this as "…agreed to hire o…" above "ne more backend
    // engineer." — one word split across two lines of the same card.
    const { previewAfterTitle } = load();
    const content =
      "Meeting notes Q3 roadmap review, deferred the billing rewrite to Q4 and agreed to hire one more backend engineer";
    const title = titleLine(content);

    expect(title.endsWith("…")).toBe(true);
    const head = title.replace(/…$/, "");
    // The title ends on a whole word.
    expect(content.startsWith(head)).toBe(true);
    expect(content[head.length]).toBe(" ");
    // And the preview picks up at the next one, not mid-word.
    const preview = previewAfterTitle(content, title);
    expect(preview.startsWith("one more backend engineer")).toBe(true);
  });

  it("does not collapse the title when the first word is enormous", () => {
    const content = "y".repeat(80) + " and then some ordinary words follow here";
    const title = titleLine(content);
    // No usable boundary inside the budget, so the hard cut stands rather than
    // leaving a two-character title.
    expect(title.length).toBeGreaterThan(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("does not repeat the title in the preview", () => {
    const { previewAfterTitle } = load();
    const content = "Decided to close the account. The balance was zero, so nothing else was owed.";
    const title = titleLine(content);
    expect(title).toBe("Decided to close the account.");
    expect(previewAfterTitle(content, title)).toBe("The balance was zero, so nothing else was owed.");
  });

  it("returns an empty preview when the title already said everything", () => {
    const { previewAfterTitle } = load();
    const content = "Renewed the domain.";
    expect(previewAfterTitle(content, titleLine(content))).toBe("");
  });

  it("keeps the whole text when the title was truncated mid-stream", () => {
    const { previewAfterTitle } = load();
    const long = "y".repeat(200);
    const preview = previewAfterTitle(long, titleLine(long));
    expect(preview.length).toBeGreaterThan(100);
  });

  it("normalizes an email for reading without rewriting what is stored", () => {
    const { normalizeForDisplay } = load();
    const email = "# Happy Friday!\nFrom: DEV <yo@dev.to>\n\n\n\nHey there,\n\n\t\t\tTwo weeks left.\n";
    const out = normalizeForDisplay(email);
    expect(out.startsWith("Happy Friday!")).toBe(true);   // heading marker gone
    expect(out).not.toMatch(/\n{3,}/);                    // padding collapsed
    expect(out).not.toMatch(/\n[ \t]+\S/);                 // no stray indents
    expect(out).toContain("Two weeks left.");
  });

  it("leaves indentation alone inside a code fence", () => {
    const { normalizeForDisplay } = load();
    expect(normalizeForDisplay("Run:\n```sh\n  npm ci\n```\n")).toContain("\n  npm ci");
  });

  it("never renders an empty title", () => {
    expect(titleLine("")).toBe("Untitled memory");
    expect(titleLine("***")).toBe("Untitled memory");
  });

  it("describes recency the way a person would", () => {
    const now = Date.now();
    expect(relativeTime(now - 30_000)).toBe("just now");
    expect(relativeTime(now - 2 * 3600_000)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86400_000)).toBe("3d ago");
    expect(relativeTime(0)).toBe("");
  });

  it("uses a real brand mark wherever the icon font has one", () => {
    expect(sourceBadge("email-gmail")).toEqual({ icon: "ti-brand-google", label: "gmail" });
    expect(sourceBadge("email-icloud")).toEqual({ icon: "ti-brand-apple", label: "icloud" });
    expect(sourceBadge("chatgpt").icon).toBe("ti-brand-openai");
    expect(sourceBadge("codex").icon).toBe("ti-brand-openai");
    expect(sourceBadge("git-hook").icon).toBe("ti-brand-github");
    expect(sourceBadge("notion").icon).toBe("ti-brand-notion");
  });

  it("describes the kind of source honestly where no brand mark exists", () => {
    // Anthropic is not in the icon font; a conversation icon says more than a
    // generic AI sparkle, and claude-code is a terminal rather than a chat.
    expect(sourceBadge("claude-desktop")).toEqual({ icon: "ti-message-2", label: "claude" });
    expect(sourceBadge("claude-code").icon).toBe("ti-terminal-2");
    expect(sourceBadge("obsidian").icon).toBe("ti-notes");
  });

  it("does not mistake the CLI for GitHub", () => {
    expect(sourceBadge("cli")).toEqual({ icon: "ti-terminal-2", label: "cli" });
  });

  it("truncates a source that is really a sentence", () => {
    const badge = sourceBadge("User uploaded markdown on 2026-05-30");
    expect(badge.label.length).toBeLessThanOrEqual(18);
    expect(sourceBadge(undefined).label).toBe("manual");
  });
});
