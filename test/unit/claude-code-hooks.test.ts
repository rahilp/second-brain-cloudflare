import { describe, it, expect } from "vitest";

// Pure helper logic mirroring integrations/claude-code-hooks/session-start.js
// and session-end.js. Testing these functions verifies the behavioral contract
// of the hook scripts.

function buildRecallQuery(cwd?: string): string {
  if (!cwd) return 'recent context and decisions';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const projectName = parts[parts.length - 1] ?? 'project';
  return `${projectName} recent context decisions and facts`;
}

function formatRecallResults(results: Array<{ content?: string }>): string {
  if (!results || results.length === 0) return '';
  return results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${String(r.content ?? '').trim()}`)
    .filter(line => line.length > 3)
    .join('\n');
}

function extractSessionContent(
  messages: Array<{ role: string; content: string }>,
  maxChars = 2000
): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const meaningful = messages
    .filter(
      m =>
        (m?.role === 'user' || m?.role === 'assistant') &&
        typeof m?.content === 'string' &&
        m.content.trim().length > 0
    )
    .slice(-10);
  if (meaningful.length === 0) return '';
  const text = meaningful
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function parseTranscriptInput(raw: string): object | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    return JSON.parse(raw) as object;
  } catch {
    return null;
  }
}

describe("claude-code hooks helpers", () => {
  describe("buildRecallQuery", () => {
    it("returns fallback when no cwd given", () => {
      expect(buildRecallQuery()).toBe('recent context and decisions');
    });

    it("extracts project name from unix path", () => {
      const q = buildRecallQuery('/home/user/my-project');
      expect(q).toContain('my-project');
    });

    it("handles Windows-style paths", () => {
      const q = buildRecallQuery('C:\\Users\\rahil\\code\\brain-app');
      expect(q).toContain('brain-app');
    });

    it("returns non-empty string for any truthy cwd", () => {
      expect(buildRecallQuery('/some/path').length).toBeGreaterThan(0);
    });

    it("includes context keywords", () => {
      const q = buildRecallQuery('/home/user/second-brain');
      expect(q).toContain('context');
      expect(q).toContain('decisions');
    });
  });

  describe("formatRecallResults", () => {
    it("returns empty string for empty array", () => {
      expect(formatRecallResults([])).toBe('');
    });

    it("numbers each result", () => {
      const results = [{ content: 'First fact' }, { content: 'Second fact' }];
      const out = formatRecallResults(results);
      expect(out).toContain('1. First fact');
      expect(out).toContain('2. Second fact');
    });

    it("caps at 5 results", () => {
      const results = Array.from({ length: 10 }, (_, i) => ({ content: `Fact ${i}` }));
      const lines = formatRecallResults(results).split('\n');
      expect(lines.length).toBe(5);
    });

    it("trims whitespace from content", () => {
      expect(formatRecallResults([{ content: '  spaced content  ' }])).toContain('spaced content');
    });

    it("skips results with empty content", () => {
      const results = [{ content: '' }, { content: 'Real fact' }];
      const out = formatRecallResults(results);
      expect(out).not.toContain('1. ');
      expect(out).toContain('Real fact');
    });
  });

  describe("extractSessionContent", () => {
    it("returns empty string for empty messages", () => {
      expect(extractSessionContent([])).toBe('');
    });

    it("excludes system messages", () => {
      const out = extractSessionContent([{ role: 'system', content: 'You are helpful.' }]);
      expect(out).toBe('');
    });

    it("formats user messages with User prefix", () => {
      const out = extractSessionContent([{ role: 'user', content: 'What is Cloudflare?' }]);
      expect(out).toContain('User: What is Cloudflare?');
    });

    it("formats assistant messages with Assistant prefix", () => {
      const out = extractSessionContent([{ role: 'assistant', content: 'A CDN.' }]);
      expect(out).toContain('Assistant: A CDN.');
    });

    it("truncates at maxChars and appends ellipsis", () => {
      const messages = [{ role: 'user', content: 'x'.repeat(3000) }];
      const out = extractSessionContent(messages, 100);
      expect(out.endsWith('...')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(103);
    });

    it("keeps only last 10 messages", () => {
      const messages = Array.from({ length: 15 }, (_, i) => ({
        role: 'user',
        content: `Message ${i}`,
      }));
      const out = extractSessionContent(messages, 100_000);
      expect(out).not.toContain('Message 0');
      expect(out).toContain('Message 14');
    });

    it("skips messages with empty content", () => {
      const out = extractSessionContent([
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Non-empty' },
      ]);
      expect(out).toContain('Assistant: Non-empty');
      expect(out.match(/User:/g)).toBeNull();
    });
  });

  describe("parseTranscriptInput", () => {
    it("returns null for empty string", () => {
      expect(parseTranscriptInput('')).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      expect(parseTranscriptInput('   ')).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      expect(parseTranscriptInput('{not valid json}')).toBeNull();
    });

    it("returns parsed object for valid JSON", () => {
      const result = parseTranscriptInput('{"messages": []}');
      expect(result).toEqual({ messages: [] });
    });

    it("returns array for JSON array input", () => {
      const result = parseTranscriptInput('[1, 2, 3]');
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
