#!/usr/bin/env node
/**
 * The house rule from src/lib/scope.ts, machine-checked: no unscoped
 * corpus-wide query.
 *
 * WHAT THIS PROTECTS AGAINST
 *
 * Every SQL statement whose rows can reach a response must carry the caller's
 * workspace scope. Until this script existed the rule was enforced by review
 * and by test/integration/team-isolation.test.ts, and both are sampling: a
 * reviewer sees the diff, the isolation suite sees the surfaces someone thought
 * to add. Three admin-gated reads had slipped through anyway — GET
 * /insights/dry-run returned two of a colleague's private memories, and GET
 * /stats named their private tags on the admin's dashboard.
 *
 * The dry run is the reason this checks JOIN as well as FROM. It never writes
 * `FROM entries`; it reaches the table only through `JOIN entries a ON a.id =
 * c.a_id`, so a FROM-only check would have gone green over the exact leak that
 * motivated writing it.
 *
 * WHAT COUNTS AS SCOPED
 *
 * The enclosing template literal mentions `scope` in any form — ${scope.clause},
 * ${scopeSql}, ${nodeScopeSql}, ${rcScopeSql}, ${tagScopeSql} — or names
 * `workspace_id` outright. That is deliberately loose: this is a smoke alarm for
 * a whole category of mistake, not a proof of correctness, and a query that
 * mentions scoping at all has had the thought applied to it.
 *
 * DOCUMENTED EXCEPTIONS
 *
 * Plenty of queries legitimately have no caller scope: by-id lookups whose ids
 * came from an already-scoped read, cron passes with no request identity,
 * deployment-wide repair counters. Those carry `// scope-exempt: <reason>` on
 * the line above (or within five lines above), and the reason is the point —
 * the annotation exists to make someone write down why, where the next reader
 * will see it.
 *
 * There is no ESLint in this repo; this is a plain Node script with no
 * dependencies, run by `npm run check:scope` and by CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The tables whose rows are memory content and must never be read corpus-wide. */
const TABLE_PATTERNS = [
  /\bFROM\s+entries\b/gi,
  /\bFROM\s+edges\b/gi,
  /\bJOIN\s+entries\b/gi,
  /\bJOIN\s+edges\b/gi,
];

/** How far above a query an annotation may sit and still plainly be about it. */
const ANNOTATION_LOOKBACK = 5;

const EXEMPT_MARKER = "scope-exempt:";

/**
 * Characters after which a `/` opens a regular expression rather than dividing.
 * The usual heuristic: division follows a value, a regex follows an operator, an
 * opening bracket, or nothing at all.
 */
const REGEX_PRECEDERS = /[(,=:[!&|?{};+\-*%~^<>]/;
const REGEX_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "case", "do", "else", "yield", "await", "throw",
]);

/** Whether the `/` at `i` opens a regex literal, given the code before it. */
function opensRegex(text, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return true;
  const prev = text[j];
  if (REGEX_PRECEDERS.test(prev)) return true;
  if (!/[A-Za-z0-9_$]/.test(prev)) return false;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(text[k])) k--;
  return REGEX_KEYWORDS.has(text.slice(k + 1, j + 1));
}

/**
 * Every OUTERMOST template literal in the source, as {start, end} offsets of its
 * delimiting backticks.
 *
 * Outermost, not nearest, because `${cond ? `a` : `b`}` puts backticks between a
 * scope clause and the table name that follows it. Pairing a match with the
 * nearest backtick before it would start the span after the scope clause and
 * report a false positive on a query that is correctly scoped.
 *
 * A small lexer rather than a regex: it has to know that a backtick, a quote or
 * a `${` inside a line comment, a block comment, a quoted string or a REGEX
 * LITERAL does not mean what it says. The regex case is not hypothetical —
 * src/capture/store.ts:58 contains `/[."]/` inside a `${...}`, and reading that
 * `"` as the start of a string swallowed the rest of the file into one span,
 * which silently passed two unscoped by-id lookups because some other query in
 * the same span mentioned workspace_id.
 *
 * scanTree() asserts the stack empties on every file in src/, so a construct
 * this lexer cannot read fails the check rather than quietly passing it.
 */
export function templateSpans(text) {
  const spans = [];
  // "tpl" — inside a template literal. "expr" — inside its ${...}. "brace" — a
  // nested {} inside that expression (an object literal, a block).
  const stack = [];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (top()?.kind === "tpl") {
      if (c === "`") {
        const opened = stack.pop();
        if (stack.length === 0) spans.push({ start: opened.start, end: i });
        i++; continue;
      }
      if (c === "$" && text[i + 1] === "{") { stack.push({ kind: "expr" }); i += 2; continue; }
      i++; continue;
    }
    // Outside a template body: ordinary code, or the inside of a ${...}.
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "/" && opensRegex(text, i)) {
      i++;
      let inClass = false;
      while (i < text.length) {
        const r = text[i];
        if (r === "\\") { i += 2; continue; }
        if (r === "\n") break;                       // unterminated: treat as division
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++; continue;
    }
    if (c === "`") { stack.push({ kind: "tpl", start: i }); i++; continue; }
    if (c === "{" && (top()?.kind === "expr" || top()?.kind === "brace")) {
      stack.push({ kind: "brace" }); i++; continue;
    }
    if (c === "}" && (top()?.kind === "expr" || top()?.kind === "brace")) {
      stack.pop(); i++; continue;
    }
    i++;
  }
  spans.balanced = stack.length === 0;
  return spans;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Scan one file's source.
 *
 * Returns the number of corpus queries seen, the documented exceptions with the
 * reason each gives, and the violations — one entry per offending template, not
 * per table name in it, so a query joining two of these tables is reported once.
 */
export function scanSource(text) {
  const lines = text.split("\n");
  const spans = templateSpans(text);
  const seen = new Map();
  // A file this lexer could not read is reported rather than skipped: an
  // unbalanced stack means every span after the confusion is wrong, and the
  // failure mode is a false PASS.
  if (!spans.balanced) {
    return {
      queries: 0,
      exceptions: [],
      violations: [{ line: 1, snippet: "could not read this file's template literals", matched: "" }],
      unreadable: true,
    };
  }

  for (const pattern of TABLE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const lineNo = lineOf(text, match.index);
      const source = lines[lineNo - 1] ?? "";
      // Prose in a doc comment, not SQL. src/lib/scope.ts and
      // src/tags/vocabulary.ts both describe this rule in these words, and a
      // checker that trips on its own documentation is one people switch off.
      const trimmed = source.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;

      const span = spans.find(s => s.start < match.index && match.index < s.end);
      const key = span ? span.start : `bare:${match.index}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        line: span ? lineOf(text, span.start) : lineNo,
        text: span ? text.slice(span.start + 1, span.end) : source,
        matched: match[0],
      });
    }
  }

  const exceptions = [];
  const violations = [];
  for (const query of seen.values()) {
    if (/scope/i.test(query.text) || query.text.includes("workspace_id")) continue;

    const from = Math.max(0, query.line - 1 - ANNOTATION_LOOKBACK);
    const window = lines.slice(from, query.line);
    const annotated = window.reverse().find(l => l.includes(EXEMPT_MARKER));
    if (annotated) {
      exceptions.push({
        line: query.line,
        reason: annotated.slice(annotated.indexOf(EXEMPT_MARKER) + EXEMPT_MARKER.length).trim(),
      });
      continue;
    }
    violations.push({
      line: query.line,
      snippet: query.text.replace(/\s+/g, " ").trim().slice(0, 100),
      matched: query.matched,
    });
  }

  return { queries: seen.size, exceptions, violations };
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (name.endsWith(".ts")) yield path;
  }
}

function main() {
  let queries = 0;
  let exceptions = 0;
  const failures = [];

  for (const path of walk(join(ROOT, "src"))) {
    const result = scanSource(readFileSync(path, "utf8"));
    queries += result.queries;
    exceptions += result.exceptions.length;
    for (const v of result.violations) {
      failures.push({ file: relative(ROOT, path), ...v });
    }
  }

  if (failures.length === 0) {
    console.log(`✔ scope check: ${queries} queries, ${exceptions} documented exceptions`);
    process.exit(0);
  }

  const list = failures.map(f => `    ${f.file}:${f.line}\n      ${f.snippet}`).join("\n\n");
  console.error(`
✖ ${failures.length} corpus quer${failures.length === 1 ? "y reads" : "ies read"} entries or edges with no workspace scope.

${list}

  src/lib/scope.ts states the rule: every SQL statement whose rows can reach a
  response goes through scopeWhere. An admin gate authorises a surface; it does
  not widen which memory rows a caller may read.

  Add a scope clause, or document the exception with \`// scope-exempt: <reason>\`
  on the line above.
`);
  process.exit(1);
}

// Importable for test/unit/scope-checker.test.ts; the CLI runs only when this
// file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
