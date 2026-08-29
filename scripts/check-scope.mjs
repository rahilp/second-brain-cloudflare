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
 * Each reference to `entries` or `edges` in a statement — every alias of it —
 * needs its own scope predicate. Two shapes count:
 *
 *   - an interpolation that mentions `scope` (${scope.clause}, ${nodeScopeSql},
 *     ${tagScopeSql}), because src/lib/scope.ts builds those from the caller's
 *     identity;
 *   - a literal `workspace_id` comparison in PREDICATE position against a bound
 *     value or an interpolation.
 *
 * Predicate position is load-bearing. An earlier draft accepted `workspace_id`
 * anywhere in the statement, so `SELECT id, content, workspace_id FROM entries
 * ORDER BY created_at` — no WHERE at all — passed. A projected column
 * constrains nothing. So does a hard-coded literal: `workspace_id = 'ws-bob'`
 * names a workspace the SOURCE chose, which is the opposite of scoping.
 *
 * Per-alias, also load-bearing: `JOIN entries a … JOIN entries b … WHERE
 * a.${scope.clause}` is the /insights/dry-run leak with one alias dropped, and
 * counting clauses rather than attributing them let it pass.
 *
 * DOCUMENTED EXCEPTIONS
 *
 * Plenty of queries legitimately have no caller scope: by-id lookups whose ids
 * came from an already-scoped read, cron passes with no request identity,
 * deployment-wide repair counters. Those carry `// scope-exempt: <reason>` on
 * the line above (or within five lines above), and the reason is the point —
 * the annotation exists to make someone write down why, where the next reader
 * will see it. Each annotation is spent by the FIRST query below it, so one
 * defensible reason cannot quietly cover the query after it too.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * This is a regex lexer, not a SQL parser, and the list below is the honest
 * boundary rather than an apology for it. Where it cannot decide it fails loudly
 * and someone annotates: a false positive costs thirty seconds, a false negative
 * is a leak with a green tick beside it.
 *
 *  1. SQL assembled by concatenation is invisible. `"SELECT … FROM " +
 *     "entries WHERE …"` never contains the token `FROM entries`, so no rule
 *     here can see the table at all. Same for a WHERE clause built entirely in
 *     JavaScript and handed to `env.DB.prepare(sql)` as a variable — only the
 *     template literal where the SQL is written is scanned.
 *  2. The `scope` test is by NAME, not by proof. `${somethingScopeish}` passes
 *     whatever it renders. It shows the thought was applied; it does not show
 *     the clause is right. Correctness is the isolation suite's job
 *     (test/integration/team-isolation.test.ts).
 *  3. Alias attribution is textual. `${aScope.clause}` carries no visible alias,
 *     so it joins a shared pool — two aliases and two unattributed clauses pass
 *     even if both clauses were built for the same alias. Only an explicitly
 *     prefixed clause (`a.${…}`, `e.workspace_id = ?`) is attributed.
 *  4. Subqueries share the enclosing statement's pool, so a clause in an outer
 *     WHERE can satisfy a table reference inside a subselect.
 *  5. `workspace_id = ?` is accepted without knowing what gets bound to it. A
 *     bound value from the request rather than from the identity would pass.
 *  6. Only `entries` and `edges` are checked. Every other table is out of scope
 *     for this script by design.
 *  7. A conditionally-applied clause — `${scope ? \`AND ${scope.clause}\` : ""}` —
 *     is deliberately NOT accepted, because one arm is unscoped. Files with a
 *     legitimate identity-less path annotate it like any other exception.
 *  8. The comment skip is per-line: a match on a line whose first non-space
 *     character is `*` or `//` is treated as prose even in the unlikely case
 *     that the line sits inside a template literal.
 *
 * The one thing it does prove, and the reason it earns its place in CI: no
 * statement in src/ reads entries or edges without either a scope predicate for
 * every alias, or a human-written sentence saying why not.
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

/** Words that can follow a table name but are not an alias for it. */
const NOT_AN_ALIAS = new Set([
  "as", "on", "using", "where", "group", "order", "limit", "offset", "having",
  "join", "left", "right", "inner", "outer", "cross", "natural", "union", "set",
  "values", "and", "or", "not", "in", "when", "then", "else", "end", "select",
  "from", "into", "delete", "update", "returning", "with",
]);

/**
 * Replace every `${...}` with a marker of the same length, so the SQL around it
 * can be scanned without an interpolation's JavaScript being mistaken for SQL.
 * Returns the masked SQL and the interpolations, each with the identifier that
 * immediately preceded it (`a.${scope.clause}` → alias "a").
 */
function maskInterpolations(sql) {
  let masked = "";
  const interps = [];
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "$" && sql[i + 1] === "{") {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "{") depth++;
        else if (sql[i] === "}") depth--;
        else if (sql[i] === "`") {
          // A nested template: skip it whole, braces and all.
          i++;
          while (i < sql.length && sql[i] !== "`") i += sql[i] === "\\" ? 2 : 1;
        }
        i++;
      }
      const inner = sql.slice(start + 2, i - 1);
      const before = masked.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*$/);
      interps.push({ inner, alias: before ? before[1] : null });
      masked += " ".repeat(i - start);
      continue;
    }
    masked += sql[i];
    i++;
  }
  return { masked, interps };
}

/** SQL comments are prose. `-- TODO think about scope` is not a scope clause. */
const stripSqlComments = (sql) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Every `FROM entries` / `JOIN edges b` in the statement, with its alias. */
function tableRefs(sql) {
  const refs = [];
  const re = /\b(?:FROM|JOIN)\s+(entries|edges)\b\s*(?:(AS)\s+)?([A-Za-z_][A-Za-z0-9_$]*)?/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const candidate = m[3];
    const alias = candidate && !NOT_AN_ALIAS.has(candidate.toLowerCase()) ? candidate : null;
    refs.push({ table: m[1].toLowerCase(), name: (alias ?? m[1]).toLowerCase() });
  }
  return refs;
}

/**
 * Is the right-hand side of a `workspace_id <op>` comparison derived from the
 * caller, rather than written into the source?
 *
 * Only a bound parameter or an interpolation can be. A quoted literal —
 * `workspace_id = 'ws-bob'` — names a workspace the source chose, which is the
 * opposite of scoping, so it is never accepted however it is spelled.
 */
const BOUND_RHS = /^\s*(?:\?|\$\{|\(\s*(?:\?|\$\{))/;

/**
 * The scope predicates in a statement, each attributed to an alias where the
 * source says which one.
 *
 * Two shapes count. An interpolation that mentions `scope` — ${scope.clause},
 * ${nodeScopeSql}, ${tagScopeSql} — because the clause it renders is built by
 * src/lib/scope.ts from the caller's identity. And a literal `workspace_id`
 * comparison in PREDICATE position against a bound value.
 *
 * Predicate position is the whole of finding (a): `SELECT id, content,
 * workspace_id FROM entries` names the column in the projection and constrains
 * nothing, and an earlier draft of this checker passed it.
 */
function scopePredicates(sql) {
  const { masked, interps } = maskInterpolations(sql);
  const predicates = [];

  for (const it of interps) {
    const inner = it.inner.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    if (!/scope/i.test(inner)) continue;
    // An optionally-applied clause is not a scope clause: `${scope ? `AND
    // ${scope.clause}` : ""}` is unscoped on the arm that matters. Callers that
    // legitimately have an identity-less path annotate it like every other one.
    if (/[?].*:/s.test(inner) && /:\s*(""|'')/.test(inner)) continue;
    predicates.push({ alias: it.alias ? it.alias.toLowerCase() : null });
  }

  const clean = stripSqlComments(masked);
  const re = /(?:\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?\bworkspace_id\b\s*(=|!=|<>|>=|<=|>|<|\bIS\b|\bNOT\s+IN\b|\bIN\b)/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    // The masked text blanks interpolations, so a `${...}` right-hand side shows
    // as whitespace here; read the RHS from the original to tell it from nothing.
    const rhs = sql.slice(m.index + m[0].length);
    if (!BOUND_RHS.test(rhs)) continue;
    predicates.push({ alias: m[1] ? m[1].toLowerCase() : null });
  }
  return predicates;
}

/**
 * Which table references in this statement have no scope predicate of their own.
 *
 * Every aliased reference needs its own — finding (b). Counting predicates is not
 * enough: `JOIN entries a … JOIN entries b … WHERE a.${scope.clause} AND
 * a.${otherScope.clause}` has as many clauses as tables and still leaves `b`
 * reading the whole corpus. So an alias-attributed predicate is claimed by that
 * alias first, and only unattributed predicates are shared out afterwards.
 */
function unscopedRefs(sql) {
  const refs = tableRefs(stripSqlComments(maskInterpolations(sql).masked));
  const pool = scopePredicates(sql).map(p => ({ ...p, used: false }));
  const pending = [];

  for (const ref of refs) {
    const exact = pool.find(p => !p.used && p.alias === ref.name);
    if (exact) exact.used = true;
    else pending.push(ref);
  }
  const unscoped = [];
  for (const ref of pending) {
    const shared = pool.find(p => !p.used && p.alias === null);
    if (shared) shared.used = true;
    else unscoped.push(ref);
  }
  return unscoped;
}

/**
 * Scan one file's source.
 *
 * Returns the number of corpus queries seen, the documented exceptions with the
 * reason each gives, and the violations — one entry per offending statement, not
 * per table name in it, naming the references that have no clause.
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
      violations: [{ line: 1, snippet: "could not read this file's template literals", unscoped: [] }],
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
      });
    }
  }

  const exceptions = [];
  const violations = [];
  // An annotation is spent by the first query below it — finding (d). Without
  // this, one defensible reason silently covered every query whose template
  // happened to open within the lookback window.
  const claimed = new Set();

  for (const query of [...seen.values()].sort((a, b) => a.line - b.line)) {
    const unscoped = unscopedRefs(query.text);
    if (unscoped.length === 0) continue;

    const from = Math.max(0, query.line - 1 - ANNOTATION_LOOKBACK);
    let annotation = null;
    for (let i = query.line - 1; i >= from; i--) {
      if (!claimed.has(i) && (lines[i] ?? "").includes(EXEMPT_MARKER)) { annotation = i; break; }
    }
    if (annotation !== null) {
      claimed.add(annotation);
      const line = lines[annotation];
      exceptions.push({
        line: query.line,
        reason: line.slice(line.indexOf(EXEMPT_MARKER) + EXEMPT_MARKER.length).trim(),
      });
      continue;
    }
    violations.push({
      line: query.line,
      snippet: query.text.replace(/\s+/g, " ").trim().slice(0, 100),
      unscoped: unscoped.map(r => (r.name === r.table ? r.table : `${r.table} ${r.name}`)),
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

  const list = failures
    .map(f => `    ${f.file}:${f.line}  (no clause for: ${f.unscoped.join(", ") || "?"})\n      ${f.snippet}`)
    .join("\n\n");
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
