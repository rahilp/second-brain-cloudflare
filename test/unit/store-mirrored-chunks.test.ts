import { describe, it, expect } from "vitest";
import { storeEntry } from "../../src/capture/store";
import { CHUNK_MAX_CHARS, MIRRORED_SOURCES } from "../../src/constants";
import { INTEGRATION_PROVIDERS } from "../../src/integrations";
import { makeTestEnv } from "../helpers/make-env";

/**
 * A mirrored record is one line of fact wrapped in a templated trailer, and the
 * trailer is what survives every content-level cleaner: senders differ, the
 * shapes differ, and a new one appears whenever a provider redesigns its mail.
 *
 * Chunking is what turns that from dilution into a retrieval defect. `chunkText`
 * splits at CHUNK_MAX_CHARS and `storeEntry` embeds each chunk separately, so a
 * long mirrored record produces vectors whose entire content is trailer. Those
 * vectors match anything sharing one ordinary word with the boilerplate.
 *
 * `buildEmailContent` already leads with subject, sender and date "so the
 * embedding keys on them" — but only the first chunk gets them. Indexing that
 * chunk alone keeps the part with the signal and drops the part that is only
 * ever noise. The full text stays in D1 and stays readable; this changes what is
 * searchable, not what is stored.
 */
function longMirroredRecord(): string {
  return [
    "# Your statement is ready",
    "From: Northwind Bank <statements@example.com>",
    "",
    "Your August statement is available. Closing balance $1,240.55.",
    // Templated trailer, long enough to spill into chunks of its own.
    ...Array.from({ length: 60 }, () =>
      "Visit our help centre, follow us for updates, and see our terms and privacy notice.",
    ),
  ].join("\n");
}

describe("storeEntry chunk indexing for mirrored sources", () => {
  it("embeds only the first chunk of a mirrored record", async () => {
    const env = makeTestEnv();
    const content = longMirroredRecord();
    expect(content.length).toBeGreaterThan(CHUNK_MAX_CHARS);

    const { vectorIds } = await storeEntry(env, "entry-1", content, ["email"], "email-gmail", Date.now());

    const upserted = (env.VECTORIZE.upsert as any).mock.calls[0][0];
    expect(upserted).toHaveLength(1);
    expect(upserted[0].metadata.chunkIndex).toBe(0);
    expect(upserted[0].metadata.content).toContain("Closing balance $1,240.55");
    expect(vectorIds).toHaveLength(1);
  });

  it("embeds a calendar record the same way", async () => {
    const env = makeTestEnv();

    await storeEntry(env, "entry-2", longMirroredRecord(), ["calendar"], "calendar-icloud", Date.now());

    expect((env.VECTORIZE.upsert as any).mock.calls[0][0]).toHaveLength(1);
  });

  // Guard against over-reach rather than a new behaviour: a memory the user
  // wrote is signal end to end, and truncating its index would lose real
  // content. This passes today and must keep passing.
  it("still embeds every chunk of a hand-written memory", async () => {
    const env = makeTestEnv();

    await storeEntry(env, "entry-3", longMirroredRecord(), [], "claude-desktop", Date.now());

    expect((env.VECTORIZE.upsert as any).mock.calls[0][0].length).toBeGreaterThan(1);
  });

  // The list is hand-written because deriving it would make `capture` depend on
  // `integrations`, which already depends on `capture`. This is the price of
  // that, and it is the check the equivalent list in `insight/eligibility.ts`
  // never had: that one was three providers behind — every calendar source —
  // so calendar records were being reasoned over as though a person had written
  // them. A provider added to the registry and not here would silently start
  // indexing its trailer again.
  it("covers every provider in the integration registry", () => {
    const missing = Object.keys(INTEGRATION_PROVIDERS).filter(id => !MIRRORED_SOURCES.has(id));
    expect(missing, `registered providers absent from MIRRORED_SOURCES: ${missing.join(", ")}`).toEqual([]);
  });
});
