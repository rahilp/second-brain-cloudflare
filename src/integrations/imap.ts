/**
 * Minimal IMAP client for Cloudflare Workers, built directly on connect() from
 * cloudflare:sockets. Implements exactly the commands the email integration
 * needs — LOGIN, SELECT, UID SEARCH, UID FETCH (headers + full body) — and is
 * literal-aware: FETCH responses embed IMAP literals (`{N}\r\n` followed by N
 * raw bytes, which themselves contain CRLFs), so the reader can consume both
 * CRLF-terminated lines and raw N-byte blocks over one shared buffer.
 *
 * We hand-roll this rather than depend on cf-imap: a feasibility spike proved
 * the handful of commands we need are plain text over the socket.
 */
import { connect } from "cloudflare:sockets";

const CRLF = "\r\n";
const CR = 13;
const LF = 10;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const READ_TIMEOUT_MS = 12_000;

// ─── Low-level buffered socket reader ───────────────────────────────────────

interface RawConn {
  send(text: string): Promise<void>;
  readLine(timeoutMs?: number): Promise<string>;
  readBytes(n: number, timeoutMs?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

async function openConn(host: string, port: number): Promise<RawConn> {
  const socket: any = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = new Uint8Array(0);
  // A read timeout/error poisons the connection: the abandoned reader.read() may
  // still deliver a chunk we can no longer re-associate, so any later read would
  // be desynchronized. Fail fast instead — the caller opens a fresh connection,
  // and unprocessed messages are retried on the next sync.
  let poisoned: string | null = null;

  function ensureUsable(): void {
    if (poisoned) throw new Error(`IMAP connection unusable (${poisoned})`);
  }

  async function fill(deadline: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let res: ReadableStreamReadResult<Uint8Array>;
    try {
      const to = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("IMAP read timeout")), Math.max(0, deadline - Date.now()));
      });
      res = (await Promise.race([reader.read(), to])) as ReadableStreamReadResult<Uint8Array>;
    } catch (e) {
      poisoned = errMsg(e);
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (res.done) { poisoned = "server closed the connection"; throw new Error("IMAP socket closed by server"); }
    const chunk = res.value;
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
  }

  function crlfIndex(): number {
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === CR && buf[i + 1] === LF) return i;
    }
    return -1;
  }

  return {
    async send(text: string) {
      ensureUsable();
      await writer.write(enc.encode(text));
    },
    async readLine(timeoutMs = READ_TIMEOUT_MS) {
      ensureUsable();
      const deadline = Date.now() + timeoutMs;
      let idx: number;
      while ((idx = crlfIndex()) < 0) await fill(deadline);
      const line = dec.decode(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      return line;
    },
    async readBytes(n: number, timeoutMs = READ_TIMEOUT_MS) {
      ensureUsable();
      const deadline = Date.now() + timeoutMs;
      while (buf.length < n) await fill(deadline);
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    async close() {
      try { reader.releaseLock(); } catch { /* noop */ }
      try { await socket.close(); } catch { /* noop */ }
    },
  };
}

// ─── IMAP client ────────────────────────────────────────────────────────────

export interface FetchedMessage {
  uid: number;
  size?: number;                    // RFC822.SIZE octets (uidFetchHeaders only)
  headers: Record<string, string>; // lowercased header name → value
  raw?: Uint8Array;                 // full RFC822 bytes (uidFetchBody only)
}

export class ImapClient {
  private conn!: RawConn;
  private seq = 0;
  private dec = new TextDecoder();

  static async connect(host: string, port = 993): Promise<ImapClient> {
    const c = new ImapClient();
    c.conn = await openConn(host, port);
    await c.readGreeting();
    return c;
  }

  private tag(): string { return `a${++this.seq}`; }

  private async readGreeting(): Promise<void> {
    const line = await this.conn.readLine();
    if (!/^\* (OK|PREAUTH)/i.test(line)) throw new Error(`unexpected IMAP greeting: ${line}`);
  }

  // Read an untagged-then-tagged response for commands WITHOUT literals
  // (LOGIN, SELECT, SEARCH, LOGOUT). Returns the untagged `*` lines.
  private async readSimple(tag: string): Promise<string[]> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.conn.readLine();
      const done = new RegExp(`^${tag} (OK|NO|BAD)\\b`, "i").exec(line);
      if (done) {
        if (!/OK/i.test(done[1])) throw new Error(`IMAP ${tag} ${line.slice(tag.length + 1)}`);
        return lines;
      }
      lines.push(line);
    }
  }

  private async send(cmd: string): Promise<string> {
    const tag = this.tag();
    await this.conn.send(`${tag} ${cmd}${CRLF}`);
    return tag;
  }

  async login(email: string, appPassword: string): Promise<void> {
    const tag = await this.send(`LOGIN "${esc(email)}" "${esc(appPassword)}"`);
    try {
      await this.readSimple(tag);
    } catch (e) {
      throw new Error(`IMAP login failed — check the email and app password, and that IMAP is enabled. (${errMsg(e)})`);
    }
  }

  async selectInbox(): Promise<{ exists: number }> {
    const tag = await this.send(`SELECT INBOX`);
    const lines = await this.readSimple(tag);
    const exists = Number(lines.map((l) => /^\* (\d+) EXISTS/i.exec(l)?.[1]).find(Boolean) ?? NaN);
    return { exists: Number.isFinite(exists) ? exists : 0 };
  }

  // UID SEARCH SINCE <date> → stable UIDs (survive across sessions).
  async uidSearchSince(since: Date): Promise<number[]> {
    const tag = await this.send(`UID SEARCH SINCE ${imapDate(since)}`);
    const lines = await this.readSimple(tag);
    const raw = (lines.map((l) => /^\* SEARCH([^\r\n]*)/i.exec(l)?.[1]).find((v) => v != null) ?? "").trim();
    // Number("") === 0, so an empty SEARCH (the common "no new mail" steady
    // state) must NOT become [0] — UID 0 is invalid and would break the FETCH.
    return raw ? raw.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  }

  // Literal-aware FETCH. Sends `UID FETCH <set> (UID <what>)` and returns one
  // FetchedMessage per response item; the literal that follows each item's
  // `… {N}` is that item's payload.
  private async uidFetch(set: string, what: string, kind: "headers" | "raw"): Promise<FetchedMessage[]> {
    const tag = await this.send(`UID FETCH ${set} (UID ${what})`);
    const out: FetchedMessage[] = [];
    for (;;) {
      const line = await this.conn.readLine();
      const done = new RegExp(`^${tag} (OK|NO|BAD)\\b`, "i").exec(line);
      if (done) {
        if (!/OK/i.test(done[1])) throw new Error(`IMAP FETCH failed: ${line}`);
        return out;
      }
      // A FETCH item line introducing a literal: `* 12 FETCH (UID 34 BODY[…] {N}`
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit && /FETCH \(/i.test(line)) {
        const uid = Number(/UID (\d+)/i.exec(line)?.[1] ?? NaN);
        const sizeMatch = /RFC822\.SIZE (\d+)/i.exec(line)?.[1];
        const size = sizeMatch ? Number(sizeMatch) : undefined;
        const payload = await this.conn.readBytes(Number(lit[1]));
        // consume the trailing `)` line that closes this FETCH item
        await this.conn.readLine().catch(() => "");
        if (Number.isFinite(uid)) {
          out.push(kind === "raw"
            ? { uid, size, headers: {}, raw: payload }
            : { uid, size, headers: parseHeaders(this.dec.decode(payload)) });
        }
      }
      // other untagged lines (e.g. `* 12 FETCH (UID 34)` with no literal) are ignored
    }
  }

  async uidFetchHeaders(uids: number[], fields: string[]): Promise<FetchedMessage[]> {
    if (!uids.length) return [];
    return this.uidFetch(uids.join(","), `RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${fields.join(" ").toUpperCase()})]`, "headers");
  }

  async uidFetchBody(uid: number): Promise<Uint8Array | null> {
    const items = await this.uidFetch(String(uid), `BODY.PEEK[]`, "raw");
    return items[0]?.raw ?? null;
  }

  async logout(): Promise<void> {
    try {
      const tag = await this.send(`LOGOUT`);
      await this.readSimple(tag).catch(() => []);
    } catch { /* best-effort */ }
  }

  async close(): Promise<void> {
    await this.logout();
    await this.conn.close();
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function parseHeaders(text: string): Record<string, string> {
  // Unfold RFC822 continuation lines (a leading space/tab continues the prior
  // header), then split "Name: value".
  const unfolded = text.replace(/\r\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r\n/)) {
    const m = /^([!-9;-~]+):\s?(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function esc(s: string): string { return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
export function imapDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
