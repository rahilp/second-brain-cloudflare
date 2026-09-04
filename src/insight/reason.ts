/**
 * One candidate pair in, at most one insight out.
 *
 * Two properties here are load-bearing, and both are corrections to the
 * generator this replaces:
 *
 *   - The prompt mandates NO opening phrase. Its predecessor required the answer
 *     to start with "You tend to" / "There's a recurring" / "Across your
 *     memories" and discarded anything else, which made the generic shape a
 *     contract rather than something a better model could escape.
 *
 *   - There is an explicit refusal path. That is what makes noisy inputs safe:
 *     roughly half of the `supersedes` edges on a real brain are false
 *     positives, so the model must be free to say there is no tension here
 *     rather than be told there is one.
 */
import type { Env } from "../env";
import { DEFAULTS, type Config } from "../config";
import { INSIGHT_PASS_MAX_TOKENS } from "../constants";
import { readStreamText } from "../lib/ai";

export type InsightShape = "contradiction" | "throughline" | "connection";

export interface ReasonedInsight {
  shape: InsightShape;
  text: string;
}

/**
 * What came of reasoning over one pair. Three outcomes, not two, and they must
 * stay distinguishable all the way to the caller:
 *
 *   - "insight"  — a real insight, ready to write.
 *   - "declined" — the model gave an answer and it was not an insight: an
 *     explicit `{"insight": false}`, malformed output, an invalid shape, text
 *     too short or too long, or a failure of the vocabulary floor. Re-asking
 *     the same model the same question about the same pair is not expected
 *     to change the answer, so this is a settled no.
 *   - "failed"   — the call itself never produced an answer to judge (network
 *     error, timeout, non-2xx). Nothing was decided, so the pair must stay
 *     eligible to be asked again.
 *
 * Collapsing "declined" and "failed" into one null was the bug this type
 * exists to prevent: a transient model outage would have looked exactly like
 * a considered refusal, and every candidate caught in it would have been
 * marked rejected forever. See src/insight/weekly.ts.
 */
export type ReasonOutcome =
  | { outcome: "insight"; shape: InsightShape; text: string; relationship?: TypedRelationship }
  | { outcome: "declined"; relationship?: TypedRelationship }
  | { outcome: "failed" };

/** How the model says the pair relates, and which side the edge points FROM. */
export interface TypedRelationship {
  type: "caused_by" | "decided" | "follows";
  source: "A" | "B";
}

/**
 * The types the insight call is allowed to propose.
 *
 * `supersedes` is deliberately absent though it is a real edge type. It is
 * welded to deprecation semantics — the thing it points at is treated as
 * retired — and a model volunteering it here would retire a memory nobody
 * asked to retire, from a call whose actual job was to write a sentence.
 */
const RELATIONSHIP_TYPES: ReadonlySet<string> = new Set(["caused_by", "decided", "follows"]);

/**
 * The relationship verdict, read independently of whether an insight survived.
 *
 * Parsed from the raw response rather than from parseInsightResponse's result,
 * because that function returns null for everything that is not a publishable
 * insight — which is most calls. The model had to decide how the pair relates
 * in order to answer at all, and that verdict is just as good on a response
 * that declined.
 */
/** Whether the response carries a JSON object that actually parses. */
function isReadableJsonObject(raw: string): boolean {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return false;
  try {
    JSON.parse(match[0]);
    return true;
  } catch {
    return false;
  }
}

export function parseRelationship(raw: string): TypedRelationship | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  const type = String(parsed.relationship ?? "");
  if (!RELATIONSHIP_TYPES.has(type)) return null;

  // No direction, no edge: a typed edge pointing the wrong way is worse than
  // the generic one it would replace. Both ends are required and they must
  // disagree — a response naming one memory as both source and target has not
  // committed to a direction, and reading `source` alone would invent one.
  const source = String(parsed.source ?? "").toUpperCase();
  const target = String(parsed.target ?? "").toUpperCase();
  if (source !== "A" && source !== "B") return null;
  if (target !== "A" && target !== "B") return null;
  if (source === target) return null;

  return { type: type as TypedRelationship["type"], source };
}

const SHAPES: ReadonlySet<string> = new Set(["contradiction", "throughline", "connection"]);

/** Below this the model has not said anything a person could act on. */
const MIN_INSIGHT_TEXT_CHARS = 40;

/**
 * Above this the model has stopped writing "one or two sentences" and
 * started writing paragraphs — a ceiling now needed because it used to come
 * for free. Before INSIGHT_PASS_MAX_TOKENS went from 200 to 1200 (see the
 * comment on that constant in src/constants.ts), the token budget itself
 * kept `text` short; raising it to give the reasoning model room to think
 * also removed the only thing bounding the length of its answer.
 *
 * Measured on a live brain, well-formed insights ran 259-316 characters
 * against this same "one or two sentences" prompt. 600 is roughly double
 * that observed ceiling: comfortable headroom for a longer-but-still-
 * disciplined two-sentence insight (long names, an em-dash aside, a
 * qualifying clause), while still refusing anything that has plainly
 * stopped being one or two sentences.
 *
 * The home dashboard now renders `text` in full in a review card (see
 * commit "Show full insight text on the brief card..."), with no clipping —
 * that's precisely why this ceiling exists: an unbounded `text` is not just
 * a quality problem, it's a wall of text on someone's home screen.
 */
const MAX_INSIGHT_TEXT_CHARS = 600;

/** How much of each entry the prompt carries. */
const ENTRY_EXCERPT_CHARS = 800;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "you", "your", "about",
  "into", "over", "then", "than", "they", "them", "have", "has", "was", "were",
  "are", "but", "not", "all", "any", "can", "will", "would", "should", "could",
  "often", "talk", "thing", "things", "something", "these", "those", "when",
  "what", "which", "there", "their", "been", "more", "most", "some", "such",
]);

const distinctiveTokens = (text: string): Set<string> =>
  new Set(
    text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g)?.filter(t => !STOPWORDS.has(t)) ?? [],
  );

/**
 * Does the insight text draw on vocabulary particular to EACH side, not just
 * vocabulary the two entries already share?
 *
 * The rule this replaced required a distinctive token from A, checked
 * independently of a distinctive token from B — "shares a distinctive token
 * with each entry". A noun both entries happen to contain (the shared topic
 * that made them a candidate pair in the first place) satisfies that against
 * both sides at once, trivially, every time. That is precisely the centroid
 * failure: "you often talk about your second brain project" echoes only what
 * the two entries have in common and names nothing particular to either.
 *
 * The asymmetric version requires a token that is distinctive to A AND ABSENT
 * from B, and — separately — a token distinctive to B AND absent from A. A
 * real insight says something particular to each side; a centroid can only
 * ever draw on their intersection.
 *
 * Degenerate case: the old rule's "source has no distinctive vocabulary of
 * its own" (an entry that is all stopwords) returned true, because there was
 * nothing to require. The asymmetric analogue is an entry whose entire
 * distinctive vocabulary is already contained in the other's — near-duplicate
 * entries, or one side's topic wholly subsumed by the other's. When a side
 * has no vocabulary that is ITS ALONE (onlyA / onlyB empty), that side has
 * nothing distinctive to ask for and cannot veto — handled explicitly below,
 * not as an accident of the boolean logic. If both sides are empty this way,
 * the two entries are too similar for the vocabulary floor to do any work at
 * all, and the prompt-level judgment (plus the restatement blocklist below)
 * is what is left to catch it.
 */
export function sharesVocabulary(text: string, a: string, b: string): boolean {
  const insightTokens = distinctiveTokens(text);
  const tokensA = distinctiveTokens(a);
  const tokensB = distinctiveTokens(b);

  const onlyA = [...tokensA].filter(t => !tokensB.has(t));
  const onlyB = [...tokensB].filter(t => !tokensA.has(t));

  const namesA = onlyA.length === 0 || onlyA.some(t => insightTokens.has(t));
  const namesB = onlyB.length === 0 || onlyB.some(t => insightTokens.has(t));

  return namesA && namesB;
}

/** A proposal restates an earlier one when most of its distinctive words are already there. */
const RESTATEMENT_OVERLAP = 0.6;

/**
 * Whether this proposal says what a recently written insight already said.
 *
 * The inverse of the D8 quality floor: that asks whether a proposal shares
 * distinctive vocabulary with each of its SOURCES, this asks whether it shares
 * too much with an insight already written. Reuses the same tokeniser rather
 * than an embedding call — no new model call, no new index.
 *
 * Each recent insight is compared independently. Concatenating them would pool
 * the vocabulary of unrelated insights into a match neither would have made.
 */
export function restatesRecent(text: string, recent: string[]): boolean {
  const tokens = distinctiveTokens(text);
  if (tokens.size === 0) return false;
  return recent.some(prior => {
    const priorTokens = distinctiveTokens(prior);
    if (priorTokens.size === 0) return false;
    const shared = [...tokens].filter(t => priorTokens.has(t)).length;
    return shared / tokens.size >= RESTATEMENT_OVERLAP;
  });
}

/**
 * A small, narrow backstop for the restatement framings the prompt above now
 * explicitly asks the model not to produce — not a style filter, and not a
 * substitute for that prompt instruction. A model that ignores the prompt
 * should still be caught mechanically, but the prompt change is what is
 * meant to keep the phrasing from happening in the first place.
 *
 * This code ships in a public template that other people self-host against
 * their own brains, so the list below is deliberately narrow: every phrase
 * here asserts bare co-occurrence and cannot appear in a well-formed
 * insight ("X is mentioned in both" says nothing about what changed, no
 * matter whose brain it is), or leaks the prompt's own scaffolding labels
 * ("Memory A" / "Memory B") into user-facing text.
 *
 * These eight real proposals, captured off the live endpoint against one
 * brain, are the evidence the list below is observed rather than guessed —
 * but they are evidence of how the model writes when it has nothing to say,
 * not evidence about that brain's subject matter, and the list must not be
 * fitted to them:
 *
 *   1. "...in Memory A, and in Memory B, you noted that there were replies
 *       posted, upvotes clicked..."
 *   2. "...first planning a promotional strategy in Memory A and then
 *       executing it in Memory B..."
 *   3. "...is mentioned in both memories, with Memory A discussing it...
 *       and Memory B describing..."
 *   4. "...is a recurring concern, as seen in Memory A's discussion of..."
 *   5. "...in both posts, showing a consistent concern over time."
 *   6. "...indicating a ongoing concern with the consistency and
 *       development of this technology stack."
 *   7. "...is a recurring concern that evolved in your thinking from
 *       identifying the problem... to developing a solution..."
 *   8. "...in Memory A, and later drafted YouTube comments... suggesting a
 *       continued exploration of AI memory and cost optimization."
 *
 * Deliberately NOT included, even though they appear above: "recurring
 * theme", "recurring concern", "consistent concern", "ongoing concern",
 * "continued exploration". Each is ordinary English that a genuine insight
 * can legitimately contain — "your recurring concern about onboarding
 * friction resolved when you shipped the installer" is a real observation,
 * not a restatement — so blocking the phrase would reject good output for
 * anyone whose brain actually has that shape, on the strength of one model
 * overusing it against one dataset. Sample 7 above (the one candidate of
 * the eight judged a real insight) contains "recurring concern" verbatim,
 * which is exactly this risk realized: a broader list would have rejected
 * the one good sample for the same surface reason it rejects sample 4's bad
 * one. Do not add these back without re-litigating this trade-off — the
 * asymmetric vocabulary check above and the prompt instruction are what are
 * meant to carry that weight instead.
 */
const RESTATEMENT_PHRASES = [
  "mentioned in both",
  "in both memories",
  "appears in both",
  "memory a",
  "memory b",
];

export function isRestatementFraming(text: string): boolean {
  const lower = text.toLowerCase();
  return RESTATEMENT_PHRASES.some(phrase => lower.includes(phrase));
}

export function parseInsightResponse(raw: string): ReasonedInsight | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }

  if (parsed.insight !== true) return null;
  const shape = String(parsed.shape ?? "");
  if (!SHAPES.has(shape)) return null;

  const text = String(parsed.text ?? "").trim();
  if (text.length < MIN_INSIGHT_TEXT_CHARS) return null;
  if (text.length > MAX_INSIGHT_TEXT_CHARS) return null;

  return { shape: shape as InsightShape, text };
}

export async function reasonOverPair(
  a: { content: string },
  b: { content: string },
  env: Env,
  config: Readonly<Config> = DEFAULTS,
): Promise<ReasonOutcome> {
  const first = a.content.slice(0, ENTRY_EXCERPT_CHARS);
  const second = b.content.slice(0, ENTRY_EXCERPT_CHARS);

  const prompt = `You are reading two memories from one person's second brain. They were written at different times and are similar in subject.

Memory A:
${first}

Memory B:
${second}

Is there a real, specific insight in the relationship between these two? Only answer yes if you can name something concrete from BOTH memories.

Restating what they have in common is not an insight. Specifically, do not:
- say something "is mentioned in both" memories, or call it a "recurring theme" or "recurring concern"
- just narrate that the person did one thing in the first memory and then did another in the second
- refer to the inputs as "Memory A" or "Memory B" in your answer — write to the person directly, not about the documents

Instead, name what changed between the two, what they conflict on, or what genuinely connects them that the person would not already have noticed just from having written both.

The shape is one of:
- "contradiction" — B reverses, revises or conflicts with A
- "throughline" — the same concern returning, developing over time
- "connection" — two things that relate but were never linked

Write in the second person, plainly, in one or two sentences. Do not begin with a set phrase. Do not hedge.

Respond with JSON only. No text outside the JSON object.
{"insight": false} OR {"insight": true, "shape": "<shape>", "text": "<the insight>"}

Then, in that same JSON object and whichever of those you answered, say how the two memories relate.

Read every type as one sentence: SOURCE <relationship> TARGET. Getting source and target the right way round matters as much as picking the type.

- "caused_by" — SOURCE happened BECAUSE OF TARGET. The target is the cause, the source is the consequence. If A is a pricing review and B is a cancellation that happened because of it, then source is B and target is A.
- "decided" — SOURCE is the decision; TARGET carries it out or reflects it. If A records choosing a vendor and B is the signed contract, then source is A and target is B.
- "follows" — SOURCE came AFTER TARGET in the same line of thought. If A is the earlier note and B the later one, then source is B and target is A.
- "none" — none of the three fits.

"relationship": one of "caused_by", "decided", "follows", "none".
"source": "A" or "B" — the memory the sentence starts with.
"target": "A" or "B" — the other one. It must not be the same as source.

Answer this even when you answered {"insight": false}. If none of the three fit, say "none" and omit source and target.`;

  let raw = "";
  try {
    // config.INSIGHT_LLM_MODEL, deliberately not config.LLM_MODEL — this is
    // the one call in the codebase reasoning over two whole memories at once
    // rather than classifying, extracting or summarizing one, and it is worth
    // a stronger model. See the cost comment on constants.INSIGHT_LLM_MODEL
    // for why that does not also change classification, contradiction
    // detection, smart merge, digests or recall synthesis.
    const stream = await (env.AI as any).run(config.INSIGHT_LLM_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: INSIGHT_PASS_MAX_TOKENS,
      stream: true,
    });
    raw = await readStreamText(stream as ReadableStream);
  } catch (e) {
    // The call never produced an answer to judge — nothing was decided, so the
    // pair must stay eligible to be asked again rather than being marked as a
    // considered refusal.
    console.error("Insight reasoning call failed (non-fatal):", e);
    return { outcome: "failed" };
  }

  // A response with no JSON object in it at all — prose, or an object truncated
  // before its closing brace — is not a judgement to record. `declined` marks
  // the candidate rejected permanently and re-accrual cannot resurrect it, so a
  // model that ran out of tokens mid-answer would cost the pair forever. Left
  // `failed`, exactly like a thrown call: nothing was decided, so it stays
  // pending and can be asked again.
  if (!isReadableJsonObject(raw)) return { outcome: "failed" };

  // Read before the insight gate: a decline is still an answer to this.
  const relationship = parseRelationship(raw) ?? undefined;
  const declined = (): ReasonOutcome => ({ outcome: "declined", ...(relationship && { relationship }) });

  const parsed = parseInsightResponse(raw);
  if (!parsed) return declined();

  // The mechanical floor. A real insight draws on vocabulary particular to
  // each side, not just what they share, and doesn't reach for the stock
  // phrases that mean the model gave up and restated the pair instead.
  if (isRestatementFraming(parsed.text)) return declined();
  if (!sharesVocabulary(parsed.text, first, second)) return declined();

  return { outcome: "insight", shape: parsed.shape, text: parsed.text, ...(relationship && { relationship }) };
}
