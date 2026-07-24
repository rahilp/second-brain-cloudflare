/**
 * Second Brain — Email (IMAP) provider.
 *
 * Connects Gmail / iCloud via an app password over IMAP (see ./imap), fetches
 * new INBOX messages incrementally, filters out noise, and ingests the cleaned
 * body as a permanent memory. Read-only, append-only capture (NOT a live
 * mirror): emails don't vanish or cancel, so there is no delete/retention sweep
 * — new qualifying messages are captured once (deduped by Message-ID) and kept.
 */
import PostalMime from "postal-mime";
import { ImapClient } from "./imap";
import type { IntegrationEnv, IntegrationProvider, IntegrationRecord, MirrorStore, SyncOutcome } from "./framework";
import { loadIntegration, saveIntegration } from "./framework";

const DAY_MS = 86_400_000;
export const FIRST_SYNC_LOOKBACK_MS = 7 * DAY_MS;  // how far back the very first sync reaches
const OVERLAP_MS = 2 * DAY_MS;                      // re-scan window each sync (dedup covers repeats)
export const EMAIL_FETCH_BATCH = 5;                // full-body fetches per sync call; caller loops on `remaining`
const MAX_EMAIL_CHARS = 4000;
const MAX_INGESTED_IDS = 500;                       // bound the dedupe set kept in the record
const MAX_EMAIL_BYTES = 1_000_000;                  // skip messages larger than this (big attachments) to avoid timeouts/OOM

const HEADER_FIELDS = [
  "MESSAGE-ID", "FROM", "SUBJECT", "DATE",
  // Bulk / automated / list markers — presence of any means "not a person
  // writing to me". Genuine person-to-person mail carries none of these.
  "LIST-UNSUBSCRIBE", "LIST-ID", "LIST-POST",
  "PRECEDENCE", "AUTO-SUBMITTED", "FEEDBACK-ID", "X-FEEDBACK-ID",
  "X-AUTO-RESPONSE-SUPPRESS", "X-CAMPAIGN", "X-CAMPAIGNID", "CAMPAIGN-ID", "ERRORS-TO",
];

export interface EmailService {
  id: string;   // e.g. "email-gmail"
  name: string; // e.g. "Gmail"
  host: string; // IMAP host, e.g. "imap.gmail.com"
  connectLabel: string;
  connectPlaceholder: string;
  connectHint: string;
}

export interface EmailCreds { email: string; appPassword: string; }

// Email credentials are two fields packed as JSON into the framework's single
// `credentials.token` slot (the token is opaque to the framework; each provider
// owns its format).
export function parseEmailToken(token: string): EmailCreds {
  try {
    const o = JSON.parse(token);
    if (o && typeof o.email === "string" && typeof o.appPassword === "string" && o.email.trim() && o.appPassword) {
      return { email: o.email.trim(), appPassword: o.appPassword };
    }
  } catch { /* not JSON */ }
  throw new Error("This email connection is missing its credentials — please reconnect it.");
}

// ─── Filtering (pure) ───────────────────────────────────────────────────────

export interface EmailHeaderInfo {
  uid: number;
  size?: number;
  messageId: string;
  from: string;
  subject: string;
  date: string;
  bulk: boolean;
}

// Automated senders (broadened): the local-part signals a machine, not a person.
export function isNoiseSender(from: string): boolean {
  const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).toLowerCase();
  const local = (addr.split("@")[0] ?? "").trim();
  return /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|noreply|notification|notifications|notify|alert|alerts|mailer-daemon|mailer|postmaster|bounce|bounces|newsletter|updates)([._+-]|$)/.test(local);
}

// Header markers that reliably indicate bulk / automated / list mail. This is
// the primary noise filter and is fully generic — no per-sender rules: List-*
// (marketing + mailing lists), Precedence: bulk/list/junk, Auto-Submitted
// (RFC 3834 automated mail), Feedback-ID (which large senders attach), and
// common campaign headers. Person-to-person mail carries none of these, so this
// catches newsletters, marketing, receipts, statements, and alerts alike.
export function looksBulk(headers: Record<string, string>): boolean {
  const present = (k: string) => headers[k] != null;
  if (
    present("list-unsubscribe") || present("list-id") || present("list-post") ||
    present("feedback-id") || present("x-feedback-id") ||
    present("x-auto-response-suppress") ||
    present("x-campaign") || present("x-campaignid") || present("campaign-id") ||
    present("errors-to")
  ) return true;
  const prec = (headers["precedence"] || "").toLowerCase().trim();
  if (prec === "bulk" || prec === "list" || prec === "junk") return true;
  const auto = (headers["auto-submitted"] || "").toLowerCase().trim();
  if (auto && auto !== "no") return true;
  return false;
}

// Candidates = not a newsletter/marketing (List-Unsubscribe), not an automated
// sender, and not already ingested. Oldest-first so partial batches converge.
export function computeEmailPlan(headers: EmailHeaderInfo[], ingestedIds: Set<string>): EmailHeaderInfo[] {
  return headers
    .filter((h) => !h.bulk && !isNoiseSender(h.from) && (!h.messageId || !ingestedIds.has(h.messageId)))
    .sort((a, b) => a.uid - b.uid);
}

// ─── Body extraction + cleaning ─────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<\/(p|div|br|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Strip quoted reply chains, forwarded headers, and signatures; cap length.
export function cleanEmailBody(text: string): string {
  let t = (text || "").replace(/\r\n/g, "\n");
  const cuts = [
    /\n>?[ \t]*On .+ wrote:[ \t]*\n/i,
    /\n-{2,}[ \t]*Original Message[ \t]*-{2,}/i,
    /\n_{5,}\n/,
    /\nFrom:[ \t].+\n(Sent|Date):[ \t].+/i,
    /\n-{3,}[ \t]*Forwarded message[ \t]*-{3,}/i,
  ];
  for (const re of cuts) {
    const m = re.exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index);
  }
  const sig = t.search(/\n-- \n/);
  if (sig >= 0) t = t.slice(0, sig);
  t = t.split("\n").filter((l) => !/^[ \t]*>/.test(l)).join("\n");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > MAX_EMAIL_CHARS ? `${t.slice(0, MAX_EMAIL_CHARS)}\n…` : t;
}

// Lead with subject + sender + date so the embedding keys on them.
export function buildEmailContent(subject: string, from: string, date: string, body: string): string {
  const lines = [`# ${subject || "(no subject)"}`, `From: ${from}${date ? `  ·  ${date}` : ""}`];
  if (body) lines.push("", body);
  return lines.join("\n").trim();
}

interface ParsedEmail { text: string; subject: string; from: string; date: string; }

async function extractEmail(raw: Uint8Array): Promise<ParsedEmail> {
  const parsed: any = await PostalMime.parse(raw);
  const fromObj = parsed.from;
  const from = fromObj ? `${fromObj.name ? `${fromObj.name} ` : ""}<${fromObj.address ?? ""}>`.trim() : "";
  let text: string = parsed.text || "";
  if (!text && parsed.html) text = htmlToText(parsed.html);
  return { text, subject: parsed.subject || "", from, date: parsed.date || "" };
}

// ─── Connection validation + sync ───────────────────────────────────────────

export async function validateEmailToken(token: string, host: string): Promise<string> {
  const { email, appPassword } = parseEmailToken(token);
  const client = await ImapClient.connect(host);
  try {
    await client.login(email, appPassword);
    await client.selectInbox();
    return email;
  } finally {
    await client.close().catch(() => {});
  }
}

function getConfig(record: IntegrationRecord): { checkpoint?: number; ingestedIds?: string[] } {
  const c = record.config as any;
  return c && typeof c === "object" ? c : {};
}

async function runEmailSync(env: IntegrationEnv, store: MirrorStore, svc: EmailService): Promise<SyncOutcome> {
  const record = await loadIntegration(env, svc.id);
  if (!record) return { ok: false, error: `${svc.name} is not connected` };

  let creds: EmailCreds;
  try {
    creds = parseEmailToken(record.credentials.token);
  } catch (e) {
    record.status = "error";
    record.lastSyncError = errMsg(e);
    record.updatedAt = Date.now();
    await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  }

  const now = Date.now();
  const cfg = getConfig(record);
  const ingestedIds = new Set<string>(Array.isArray(cfg.ingestedIds) ? cfg.ingestedIds : []);
  const searchSince = new Date(typeof cfg.checkpoint === "number" ? cfg.checkpoint : now - FIRST_SYNC_LOOKBACK_MS);

  let client: ImapClient | null = null;
  try {
    client = await ImapClient.connect(svc.host);
    await client.login(creds.email, creds.appPassword);
    await client.selectInbox();

    const uids = await client.uidSearchSince(searchSince);
    const headerMsgs = await client.uidFetchHeaders(uids, HEADER_FIELDS);
    const headers: EmailHeaderInfo[] = headerMsgs.map((m) => ({
      uid: m.uid,
      size: m.size,
      messageId: (m.headers["message-id"] || "").trim(),
      from: m.headers["from"] || "",
      subject: m.headers["subject"] || "",
      date: m.headers["date"] || "",
      bulk: looksBulk(m.headers),
    }));

    const plan = computeEmailPlan(headers, ingestedIds);
    const batch = plan.slice(0, EMAIL_FETCH_BATCH);

    let created = 0, failed = 0;
    for (const h of batch) {
      try {
        if (h.size && h.size > MAX_EMAIL_BYTES) {
          // Skip large messages (usually big attachments): fetching them risks
          // timeouts/OOM. Mark seen so they don't linger in the candidate set.
          if (h.messageId) ingestedIds.add(h.messageId);
          continue;
        }
        const raw = await client.uidFetchBody(h.uid);
        if (!raw) { failed++; continue; }
        const parsed = await extractEmail(raw);
        const body = cleanEmailBody(parsed.text);
        const content = buildEmailContent(parsed.subject || h.subject, parsed.from || h.from, parsed.date || h.date, body);
        await store.createEntry(content, ["email", svc.id], svc.id);
        created++;
        if (h.messageId) ingestedIds.add(h.messageId);
      } catch (e) {
        console.error(`Email ingest failed for uid ${h.uid} (non-fatal):`, e);
        failed++;
      }
    }

    const remaining = plan.length - batch.length;
    // Only advance the checkpoint once the whole candidate set is drained, so a
    // partial batch re-searches the same window next run. Keep a 2-day overlap
    // so nothing slips through day-boundary/timing gaps — dedupe absorbs repeats.
    if (remaining === 0) cfg.checkpoint = now - OVERLAP_MS;
    cfg.ingestedIds = [...ingestedIds].slice(-MAX_INGESTED_IDS);
    (record.config as any) = cfg;

    record.status = "connected";
    record.lastSyncedAt = now;
    record.lastSyncError = null;
    record.updatedAt = now;
    await saveIntegration(env, record);

    return { ok: true, created, updated: 0, deleted: 0, failed, remaining, total: headers.length };
  } catch (e) {
    record.status = "error";
    record.lastSyncError = errMsg(e);
    record.updatedAt = now;
    await saveIntegration(env, record);
    return { ok: false, error: record.lastSyncError };
  } finally {
    try { await client?.close(); } catch { /* noop */ }
  }
}

export function makeEmailProvider(svc: EmailService): IntegrationProvider {
  return {
    id: svc.id,
    name: svc.name,
    category: "email",
    connectLabel: svc.connectLabel,
    connectPlaceholder: svc.connectPlaceholder,
    connectHint: svc.connectHint,
    validateToken: (token: string) => validateEmailToken(token, svc.host),
    sync: (env, store) => runEmailSync(env, store, svc),
  };
}

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
