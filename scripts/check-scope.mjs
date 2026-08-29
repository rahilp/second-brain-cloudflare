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
 *   - an interpolation whose identifier is scope-shaped (`scope`, `scopeSql`,
 *     `scopeWhere(`, or the `…Scope` / `…ScopeSql` family), matched as a whole
 *     identifier and applied unconditionally;
 *   - a literal `workspace_id = ?` or `workspace_id IN (?, …)` in predicate
 *     position, against a bound value or an interpolation.
 *
 * Four things are deliberately NOT accepted, each because it shipped green once:
 *
 *   1. A projected column. `SELECT id, content, workspace_id FROM entries ORDER
 *      BY created_at` has no WHERE at all and constrains nothing.
 *   2. Any operator but `=` and `IN`. `!=` and `NOT IN` return precisely
 *      everyone ELSE's rows — the exact inverse of the rule — and `>` is how
 *      src/runtime/rotation.ts walks the workspace ring, a real corpus query
 *      that passed on the operator alone.
 *   3. A hard-coded literal. `workspace_id = 'ws-bob'` names a workspace the
 *      SOURCE chose, which is the opposite of scoping.
 *   4. A conditional clause WRITTEN IN THE INTERPOLATION.
 *      `${scope ? `AND ${scope.clause}` : ""}` is unscoped on the arm that
 *      matters, so any `?`, `&&` or `||` inside the braces disqualifies it. That
 *      is a test on the text between `${` and `}` and nothing more: hoist the
 *      same ternary one line up — `const scopeSql = isAdmin ? "1=1" :
 *      scope.clause;` and then `${scopeSql}` — and it passes, for the reason
 *      limitation 2 gives. The rule catches the spelling, not the idea.
 *
 * Per-alias attribution is load-bearing too: `JOIN entries a … JOIN entries b …
 * WHERE a.${scope.clause}` is the /insights/dry-run leak with one alias dropped,
 * and counting clauses rather than attributing them let it pass.
 *
 * DOCUMENTED EXCEPTIONS, IN TWO KINDS
 *
 * `// scope-exempt: <reason>` — this query is NOT scoped and that is correct:
 * by-id lookups whose ids came from an already-scoped read, cron passes with no
 * request identity, deployment-wide repair counters.
 *
 * `// scope-checked: <reason>` — this query IS scoped; the clause is assembled
 * in JavaScript where the lexer cannot see it (src/recall/search.ts's
 * `d1Filters`, src/recall/distill.ts's `where`). Counted separately, because
 * filing these as permanent licences made the exemption count overstate how much
 * of src/ deliberately reads the corpus.
 *
 * Either marker sits on the line above, or within five lines above, and is spent
 * by the FIRST query below it, so one reason cannot quietly cover the next query
 * too. The reason is the point: it makes someone write down why, where the next
 * reader will see it. `npm run check:scope` prints every reason next to the
 * alias list the checker itself derived, so drift between the sentence and the
 * SQL is visible without re-deriving it.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * A regex lexer, not a SQL parser. This list is the boundary, not an apology for
 * it — and it is the part of this file most worth keeping honest, because a
 * reader will trust it more than they will read the code.
 *
 * The intent is that where the lexer cannot decide it fails loudly, because a
 * false positive costs thirty seconds and a false negative is a leak with a
 * green tick beside it. The intent is not the same as the guarantee: the list
 * below is where the two come apart, and every entry in it was found by someone
 * attacking this file rather than by reasoning about it.
 *
 *  1. SQL assembled by concatenation is invisible. `"SELECT … FROM " +
 *     "entries WHERE …"` never contains the token `FROM entries`, so nothing
 *     here can see the table at all. Same for a whole statement built in
 *     JavaScript and handed to `env.DB.prepare(sql)` as a variable — only
 *     template literals are scanned. This is the one gap with no loud failure:
 *     the statement is not checked and not counted, because it is not seen.
 *  2. The scope test is by identifier NAME, not by proof. `${somethingScope}`
 *     passes whatever it renders; it shows the thought was applied, not that the
 *     clause is right. Correctness is the isolation suite's job
 *     (test/integration/team-isolation.test.ts).
 *  3. Boolean structure is not parsed. `WHERE ${scope.clause} OR 1=1` passes:
 *     the clause is present and unconditional, and this script cannot tell that
 *     an OR at the same level defeats it. Pinned by a test so this line and the
 *     behaviour cannot drift apart.
 *  4. Alias attribution is textual. `${aScope.clause}` carries no visible alias,
 *     so it joins a shared pool — two aliases and two unattributed clauses pass
 *     even if both clauses were built for the same alias. Only an explicitly
 *     prefixed clause (`a.${…}`, `e.workspace_id = ?`) is attributed. Writing
 *     the alias in the template is what makes a statement machine-checkable.
 *  5. Subqueries share the enclosing statement's pool, so a clause in an outer
 *     WHERE can satisfy a table reference inside a subselect.
 *  6. `workspace_id = ?` is accepted without knowing what gets bound. A value
 *     taken from the request rather than from the resolved identity would pass.
 *  7. An annotation covers the WHOLE statement, every alias in it. Where one
 *     alias is scoped and another is exempt (src/routes/admin.ts's /patterns
 *     source hydration), only the written reason records which is which; if a
 *     later edit dropped the scoped alias's clause, the annotation would still
 *     silence it. A per-alias syntax was considered and rejected: it would
 *     restate machine-derived information at fifty call sites. Printing the
 *     derived alias list beside each reason is the cheaper half of that trade.
 *  8. Rejecting every conditional interpolation is a false-positive bias by
 *     choice. A legitimately unconditional clause that happens to contain `?`,
 *     `&&` or `||` will be flagged and must be annotated.
 *  9. Only `entries` and `edges` are checked. Every other table is out of scope
 *     for this script by design.
 * 10. The comment skip is per-line: a match on a line whose first non-space
 *     character is `*` or `//` is treated as prose, even in the unlikely case
 *     that the line sits inside a template literal.
 * 11. Predicate position for an interpolation is judged by an ALLOWLIST of the
 *     token it follows — WHERE, AND, OR, ON, HAVING, NOT, optionally through
 *     open parens. That is a rule about ONE TOKEN, not about SQL structure, and
 *     it is strict in both directions on purpose. It refuses correct queries
 *     whose leading AND is inside a JavaScript fragment (five of them in this
 *     tree, all carrying `scope-checked`), and it would accept a clause after a
 *     WHERE that some other part of the statement then undoes — see limitation
 *     3. It replaced a blocklist that eleven shapes walked through, and the
 *     asymmetry is deliberate: the blocklist's failures were silent, this rule's
 *     failures arrive as a build error.
 * 12. It reads `src/**\/*.ts` and nothing else. `db/schema.sql`, `installer/`,
 *     `integrations/`, `test/` and every migration outside src/ are never
 *     looked at. That is survivable today because the SQL out there is DDL, but
 *     it is not a claim about them — it is an absence of one.
 *
 * WHAT IT DOES PROVE, AND WHAT IT DOES NOT
 *
 * This sentence has been wrong twice. Both times it was wrong in the same
 * direction — claiming completeness the tool cannot deliver — and both times a
 * short adversarial sweep found the counterexample. So it is now written as a
 * description of what the script does, which is checkable, rather than as a
 * property of the tree, which is not:
 *
 *   For every reference to `entries` or `edges` that this script MATCHES, one
 *   of three things happens and nothing else. It finds a narrowing clause for
 *   each alias. Or it reports the statement. Or a human wrote a non-empty
 *   sentence in a real comment above it. There is no fourth path: a reference
 *   it cannot parse is reported, a reference hidden inside a nested template is
 *   reported, and a shortfall between what the file sweep saw and what the
 *   statement parser accounted for is reported. Nothing is dropped quietly.
 *
 *   It does NOT claim to have matched them all. Limitations 1 and 12 are holes
 *   by construction, and 2 through 11 are places where a match is judged on a
 *   name, a token or a position rather than on meaning.
 *
 * Read a green run as "nothing this script can see is unscoped". Never as
 * "nothing is unscoped". The thing that tests the actual behaviour is
 * test/integration/team-isolation.test.ts, and it always was.
 *
 * There is no ESLint in this repo; this is a plain Node script with no
 * dependencies, run by `npm run check:scope` and by CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The tables whose rows are memory content and must never be read corpus-wide. */
const QUALIFIER = `(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]*"|\\[[^\\]]*\\])`;

/**
 * The token after FROM/JOIN, dotted parts and all — `entries`, `"entries"`,
 * `main . entries`, `[main] . [entries]`.
 *
 * The dots must be part of the token, together with the whitespace around them.
 * A token pattern of `[^\\s,;()]+` stopped at the first space, so
 * `FROM main . entries b` handed the parser `main`, which parses cleanly as a
 * table that is not ours and was skipped without a word. Standalone that
 * survived on the total===0 guard; sharing a statement with one parseable
 * reference, it vanished outright.
 */
const TABLE_TOKEN_RE = () =>
  new RegExp(
    `\\b(?:FROM|JOIN)\\s+(${QUALIFIER}(?:\\s*\\.\\s*${QUALIFIER})*)` +
      `(?:\\s+(?:AS\\s+)?([A-Za-z_][A-Za-z0-9_$]*))?`,
    "gi",
  );

/**
 * The file-level sweep. Its job is to SEE every reference, in any spelling —
 * `entries`, `"entries"`, `[entries]`, `main.entries`, `"main"."entries"`,
 * `[main].[entries]`. Whether a reference can then be parsed and attributed is
 * the statement parser's problem, and one it reports rather than drops.
 *
 * Getting this pattern too narrow is not a false positive, it is a DISAPPEARANCE:
 * an unmatched reference is neither flagged nor counted, so the summary line gets
 * healthier as the tree gets worse. That is why the qualifier alternative accepts
 * quoted and bracketed names too — three of the six spellings used to vanish here.
 */
const FILE_TABLE_PATTERN =
  new RegExp(`\\b(?:FROM|JOIN)\\s+(?:${QUALIFIER}\\s*\\.\\s*)*["'\\[]?\\s*(entries|edges)\\b`, "gi");

/** The same reference test, for looking inside one interpolation. */
const HIDDEN_TABLE = new RegExp(
  `\\b(?:FROM|JOIN)\\s+(?:${QUALIFIER}\\s*\\.\\s*)*["'\\[]?\\s*(entries|edges)\\b`, "i");

/** How far above a query an annotation may sit and still plainly be about it. */
const ANNOTATION_LOOKBACK = 5;

/**
 * Two markers, deliberately different words.
 *
 *   scope-exempt:  this query is NOT scoped, and here is why that is correct.
 *   scope-checked: this query IS scoped; the clause is assembled in JavaScript
 *                  where the lexer cannot see it (src/recall/search.ts's
 *                  d1Filters, src/recall/distill.ts's where).
 *
 * They were one marker, and the count was the casualty: a reader auditing "50
 * permanent licences to read the corpus" was really auditing 48 plus two
 * false alarms. Counted and reported separately.
 */
const MARKERS = [
  { marker: "scope-exempt:", kind: "exempt" },
  { marker: "scope-checked:", kind: "checked" },
];

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
 * Replace every `${...}` with spaces of the same length, so the SQL around it
 * can be scanned without an interpolation's JavaScript being mistaken for SQL,
 * and so every offset in the masked text still lines up with the original.
 *
 * Returns the interpolations too, each with the identifier that immediately
 * preceded it (`a.${scope.clause}` → alias "a") and its offset, which is what
 * lets a clause sitting inside a SQL comment be told from one that is live.
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
      interps.push({ inner, start, alias: before ? before[1] : null });
      masked += " ".repeat(i - start);
      continue;
    }
    masked += sql[i];
    i++;
  }
  return { masked, interps };
}

/** Where the SQL comments are. Offsets, so an interpolation inside one is findable. */
function sqlCommentRanges(masked) {
  const ranges = [];
  for (const re of [/\/\*[\s\S]*?\*\//g, /--[^\n]*/g]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(masked)) !== null) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

/** Blank out SQL comments without moving anything: prose, not clauses. */
const blankSqlComments = (sql) =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length));

/**
 * Reduce the token after FROM/JOIN to a bare table name.
 *
 * `"entries"`, `[entries]`, `main.entries` and `main."edges"` are all the table,
 * and an earlier draft saw none of them — they produced queries=0, so they were
 * not flagged AND not counted, which made the summary line look healthier than
 * the tree was. Anything with an unbalanced delimiter is returned as
 * unparseable rather than guessed at.
 */
function normaliseTableToken(token) {
  let t = token;
  // Every leading qualifier, not just one: `a . b . entries` must reduce to
  // `entries` rather than stopping half way and being called unparseable.
  for (;;) {
    const qualifier = t.match(/^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]*"|\[[^\]]*\])\s*\.\s*/);
    if (!qualifier) break;
    t = t.slice(qualifier[0].length);
  }
  if (/^"[^"]*"$/.test(t) || /^\[[^\]]*\]$/.test(t)) return { name: t.slice(1, -1).toLowerCase() };
  if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(t)) return { name: t.toLowerCase() };
  return { unparseable: true, token };
}

/**
 * Every reference to entries/edges in the statement, with its alias — plus any
 * reference that mentions one of those tables in a shape this cannot read.
 * Those are reported, never dropped: a reference that vanishes is a false pass.
 */
function tableRefs(sql) {
  const refs = [];
  const unreadable = [];
  const re = TABLE_TOKEN_RE();
  let m;
  while ((m = re.exec(sql)) !== null) {
    const norm = normaliseTableToken(m[1]);
    if (norm.unparseable) {
      if (/entries|edges/i.test(m[1])) unreadable.push(m[1]);
      continue;
    }
    if (norm.name !== "entries" && norm.name !== "edges") {
      // A token that parsed cleanly as something else but still MENTIONS one of
      // our tables is the qualifier-only case: `FROM main . entries b` used to
      // yield the name "main" and be dropped on the spot. Reported, not skipped.
      if (/\b(entries|edges)\b/i.test(m[1])) unreadable.push(m[1]);
      continue;
    }
    const candidate = m[2];
    const alias = candidate && !NOT_AN_ALIAS.has(candidate.toLowerCase()) ? candidate : null;
    refs.push({ table: norm.name, name: (alias ?? norm.name).toLowerCase() });
  }
  refs.unreadable = unreadable;
  return refs;
}

/**
 * The operators that NARROW to a set the caller named. Only these two.
 *
 * `!=` returns precisely everyone else's rows, so accepting it green-lit the
 * exact inverse of the rule. `>` is not hypothetical either: it is how
 * src/runtime/rotation.ts walks the workspace ring, and that query passed the
 * scope test on the strength of the operator alone.
 */
const NARROWING_OPERATORS = new Set(["=", "IN"]);

/** Longest-first, so NOT IN beats IN and >= beats >. */
const WORKSPACE_PREDICATE =
  /(?:\b([A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?\bworkspace_id\b\s*(NOT\s+IN\b|IS\s+NOT\b|NOT\s+LIKE\b|IS\b|LIKE\b|BETWEEN\b|!=|<>|>=|<=|=|>|<|IN\b)/gi;

/**
 * Is the right-hand side derived from the caller, rather than written into the
 * source? Only a bound parameter or an interpolation can be. A quoted literal —
 * `workspace_id = 'ws-bob'` — names a workspace the SOURCE chose.
 */
const BOUND_RHS = /^\s*(?:\?|\$\{|\(\s*(?:\?|\$\{))/;

/**
 * The identifier shapes that mean "a clause built by src/lib/scope.ts": `scope`,
 * `scopeSql`, `scopeWhere(`, and the `…Scope` / `…ScopeSql` family (aScope,
 * nodeScopeSql, tagScopeSql).
 *
 * Matched as whole identifiers, not as a substring. `/scope/i` accepted
 * `periscopeStart`, `unscopedId` and `scopeless` — an identifier that merely
 * contains the letters is not a scope clause, and `unscoped` is the one word in
 * that list you would least like to see pass.
 */
const SCOPE_SHAPES = [
  /(?:^|[^A-Za-z0-9_$])scope(?![A-Za-z0-9_$])/,
  /(?:^|[^A-Za-z0-9_$])scopeSql(?![A-Za-z0-9_$])/,
  /(?:^|[^A-Za-z0-9_$])scopeWhere\s*\(/,
  /[A-Za-z0-9_$]Scope(?:Sql)?(?![A-Za-z0-9_$])/,
];

/**
 * Anything that can make the clause conditional. A clause that is applied only
 * sometimes is unscoped on the arm that matters, and enumerating the spellings
 * was a losing game: `: ""` was rejected while `: \`\``, `: "1=1"`, the reversed
 * `!scope ? "" : …`, `scope?.clause ?? ""` and `scope && \`…\`` all passed. So
 * the test is now structural — a conditional operator anywhere in the
 * interpolation disqualifies it, and a file with a legitimate identity-less
 * path annotates it like every other exception.
 */
const CONDITIONAL = /\?|&&|\|\|/;

/**
 * The only tokens a scope clause may follow.
 *
 * An ALLOWLIST, replacing a blocklist that a single character of punctuation
 * walked through: it fired only when one of its tokens was the last thing before
 * `${`, so `SELECT id, content, (${entryScope}) AS in_scope FROM entries` — and
 * ten other shapes: COALESCE, CASE WHEN, `||`, `+`, `LIMIT (…)`, `OFFSET 0 + …`,
 * `GROUP BY (…)`, `ORDER BY CASE WHEN …`, `RETURNING`, `VALUES (…)` — all
 * reported clean.
 *
 * The price is real and was paid rather than argued away. `WHERE tags LIKE ?
 * ${tagScopeSql}` and `WHERE id IN (${ph})${rcScopeSql}` in src/recall/search.ts
 * ARE scoped, and this rule cannot see it, because their leading AND lives
 * inside the JavaScript fragment. They carry `// scope-checked:` now — the
 * marker for exactly that, which does not inflate the exemption count. Three
 * honest annotations for eleven closed holes.
 *
 * CASE WHEN is deliberately NOT here. `SUM(CASE WHEN ${scope.clause} THEN 1 ELSE
 * 0 END) … FROM entries` narrows the AGGREGATE, not the row set — the statement
 * still reads the whole corpus — so counting it as a scope clause was itself a
 * small false pass.
 */
const PREDICATE_KEYWORDS = new Set(["WHERE", "AND", "OR", "ON", "HAVING", "NOT"]);

/**
 * Is an interpolation at the end of `before` in a position where a boolean
 * clause is actually applied?
 *
 * Open parens are stepped over, so `WHERE ((${scope.clause}))` still counts, but
 * only the token before them decides — which is what separates `WHERE (` from
 * `COALESCE(`, `LIMIT (` and `, (`.
 */
function inPredicatePosition(before) {
  const text = before
    .replace(/[A-Za-z_][A-Za-z0-9_$]*\s*\.\s*$/, "")
    .replace(/[\s(]*$/, "");
  const token = text.match(/([A-Za-z_][A-Za-z0-9_$]*)\s*$/);
  return !!token && PREDICATE_KEYWORDS.has(token[1].toUpperCase());
}

/**
 * The scope predicates in a statement, each attributed to an alias where the
 * source says which one — plus any corpus table hidden inside an interpolation,
 * which is reported rather than parsed.
 */
function scopePredicates(sql) {
  const { masked, interps } = maskInterpolations(sql);
  const commentRanges = sqlCommentRanges(masked);
  const blanked = blankSqlComments(masked);
  const predicates = [];
  const hidden = [];

  for (const it of interps) {
    // A corpus table inside a nested template inside an interpolation — the
    // natural spelling of an "admin sees everything" branch. It used to be
    // erased outright: masking skips nested templates whole, so the reference
    // never reached the parser, and the file sweep had already keyed this span.
    // Erased, not merely passed, which is the worse of the two.
    if (HIDDEN_TABLE.test(it.inner)) hidden.push(it.inner.replace(/\s+/g, " ").trim().slice(0, 60));

    // A clause inside a SQL comment is not applied. `-- AND ${scope.clause}`
    // and `/* ${scope.clause} */` both passed until this ran on the
    // interpolation path as well as the literal one.
    if (commentRanges.some(([a, b]) => it.start >= a && it.start < b)) continue;
    const inner = it.inner.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    if (!SCOPE_SHAPES.some((re) => re.test(inner))) continue;
    if (CONDITIONAL.test(inner)) continue;
    // Predicate position, the same requirement the literal `workspace_id` path
    // has always had. `SELECT ${scope.clause} AS x FROM entries` renders the
    // clause into the projection and constrains nothing.
    if (!inPredicatePosition(blanked.slice(0, it.start))) continue;
    predicates.push({ alias: it.alias ? it.alias.toLowerCase() : null });
  }
  predicates.hidden = hidden;

  const clean = blankSqlComments(masked);
  WORKSPACE_PREDICATE.lastIndex = 0;
  let m;
  while ((m = WORKSPACE_PREDICATE.exec(clean)) !== null) {
    if (!NARROWING_OPERATORS.has(m[2].replace(/\s+/g, " ").toUpperCase())) continue;
    // The masked text blanks interpolations, so a `${...}` right-hand side shows
    // as whitespace here; read the RHS from the original to tell it from nothing.
    if (!BOUND_RHS.test(sql.slice(m.index + m[0].length))) continue;
    predicates.push({ alias: m[1] ? m[1].toLowerCase() : null });
  }
  return predicates;
}

/**
 * Which table references in this statement have no scope predicate of their own.
 *
 * Every aliased reference needs its own. Counting predicates is not enough:
 * `JOIN entries a … JOIN entries b … WHERE a.${scope.clause} AND
 * a.${otherScope.clause}` has as many clauses as tables and still leaves `b`
 * reading the whole corpus. So an alias-attributed predicate is claimed by that
 * alias first, and only unattributed predicates are shared out afterwards.
 */
function unscopedRefs(sql) {
  const outer = blankSqlComments(maskInterpolations(sql).masked);
  const refs = tableRefs(outer);
  // The structural backstop. The file-level sweep is deliberately looser than the
  // statement parser, so if the parser accounts for FEWER references than the
  // sweep can see, something was dropped — and a dropped reference is the one
  // failure shape with no symptom, because the summary line gets healthier as the
  // tree gets worse. Rather than patch one spelling at a time, the two counts are
  // compared and any shortfall is reported.
  FILE_TABLE_PATTERN.lastIndex = 0;
  const swept = (outer.match(FILE_TABLE_PATTERN) ?? []).length;
  const found = scopePredicates(sql);
  const pool = found.map((p) => ({ ...p, used: false }));
  const pending = [];

  for (const ref of refs) {
    const exact = pool.find((p) => !p.used && p.alias === ref.name);
    if (exact) exact.used = true;
    else pending.push(ref);
  }
  const unscoped = [];
  for (const ref of pending) {
    const shared = pool.find((p) => !p.used && p.alias === null);
    if (shared) shared.used = true;
    else unscoped.push(ref);
  }
  const dropped = swept - (refs.length + refs.unreadable.length);
  return {
    unscoped,
    unreadable: dropped > 0
      ? [...refs.unreadable, `${dropped} reference(s) the sweep found and the parser did not`]
      : refs.unreadable,
    hidden: found.hidden,
    total: refs.length,
  };
}

const describeRef = (r) => (r.name === r.table ? r.table : `${r.table} ${r.name}`);

/**
 * Read an annotation off one source line — but only where a human plainly put
 * one there.
 *
 * The marker must OPEN the comment body. This was a raw `.includes()` over the
 * line, so anything within five lines that merely contained the marker text
 * granted a real licence to the next query: an error message
 * (`const ERR = "use scope-exempt: to document"`), a JSDoc line explaining the
 * convention, a test fixture, a TODO about adding one later. A licence handed
 * out by accident is worth less than no licence at all, because the whole
 * justification for the mechanism is that somebody decided.
 *
 * An empty reason is refused for the same reason: a bare marker records that
 * someone wanted the check to stop, not why it is safe.
 *
 * `insideTemplate` closes the last version of the same hole: this is a per-line
 * read and had no idea whether the line was CODE. A line beginning `//` inside a
 * template literal — sample SQL, a fixture, documentation of this very
 * convention — is text, not a decision, and it was granting full licences.
 */
function annotationOn(line, insideTemplate) {
  if (insideTemplate) return null;
  const trimmed = (line ?? "").trimStart();
  let body = null;
  if (trimmed.startsWith("//")) body = trimmed.slice(2).trimStart();
  else if (trimmed.startsWith("/*")) body = trimmed.slice(2).replace(/^\*+/, "").trimStart();
  else if (trimmed.startsWith("*")) body = trimmed.slice(1).trimStart();
  if (body === null) return null;

  const hit = MARKERS.find((mk) => body.startsWith(mk.marker));
  if (!hit) return null;
  const reason = body.slice(hit.marker.length).replace(/\*\/\s*$/, "").trim();
  return { kind: hit.kind, marker: hit.marker, reason };
}

/**
 * Scan one file's source.
 *
 * Returns the number of corpus queries seen, the documented exceptions — each
 * with its kind, its human reason, and the alias list the MACHINE derived, so
 * drift between the two is visible — and the violations.
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

  FILE_TABLE_PATTERN.lastIndex = 0;
  let match;
  while ((match = FILE_TABLE_PATTERN.exec(text)) !== null) {
    const lineNo = lineOf(text, match.index);
    const source = lines[lineNo - 1] ?? "";
    // Prose in a doc comment, not SQL. src/lib/scope.ts and
    // src/tags/vocabulary.ts both describe this rule in these words, and a
    // checker that trips on its own documentation is one people switch off.
    const trimmed = source.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;

    const span = spans.find((s) => s.start < match.index && match.index < s.end);
    const key = span ? span.start : `bare:${match.index}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      line: span ? lineOf(text, span.start) : lineNo,
      text: span ? text.slice(span.start + 1, span.end) : source,
    });
  }

  // Offsets of every line start, so a candidate annotation can be tested for
  // "is this line actually code, or is it text inside a template literal?".
  const lineStarts = [];
  for (let i = 0, at = 0; i < lines.length; i++) {
    lineStarts.push(at);
    at += lines[i].length + 1;
  }
  const inSpan = (offset) => spans.some((sp) => sp.start < offset && offset < sp.end);

  const exceptions = [];
  const violations = [];
  // An annotation is spent by the first query below it. Without this, one
  // defensible reason silently covered every query whose template happened to
  // open within the lookback window.
  const claimed = new Set();

  for (const query of [...seen.values()].sort((a, b) => a.line - b.line)) {
    const { unscoped, unreadable, hidden, total } = unscopedRefs(query.text);
    const names = unscoped.map(describeRef);

    // Three ways a statement can be a problem, in the order they matter. The
    // first two are the shapes that used to VANISH — counted as nothing, so the
    // summary line got healthier as the tree got worse — and they take priority
    // over a missing clause, because a scope clause elsewhere in the statement
    // says nothing about a branch that carries its own FROM.
    let problem = null;
    if (hidden.length) {
      problem = `a corpus table is reached from inside a nested template, where the clause for it cannot be read: \${${hidden[0]}}`;
    } else if (unreadable.length || total === 0) {
      problem = `could not parse the table reference: ${unreadable.join(", ") || query.text.replace(/\s+/g, " ").trim().slice(0, 60)}`;
    } else if (unscoped.length) {
      problem = query.text.replace(/\s+/g, " ").trim().slice(0, 100);
    }
    if (!problem) continue;

    const from = Math.max(0, query.line - 1 - ANNOTATION_LOOKBACK);
    let found = null;
    for (let i = query.line - 1; i >= from && !found; i--) {
      if (claimed.has(i)) continue;
      const hit = annotationOn(lines[i], inSpan(lineStarts[i] ?? 0));
      if (hit) found = { index: i, ...hit };
    }
    if (found) {
      claimed.add(found.index);
      // A marker with nothing after it records that someone wanted the check to
      // stop, not why the query is safe. That is not a reason, so it is not a
      // licence.
      if (!found.reason) {
        violations.push({
          line: query.line,
          snippet: `\`${found.marker}\` on line ${found.index + 1} has no reason after it`,
          unscoped: names,
        });
        continue;
      }
      exceptions.push({ line: query.line, kind: found.kind, reason: found.reason, unscoped: names });
      continue;
    }
    violations.push({ line: query.line, snippet: problem, unscoped: names });
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
  const documented = [];
  const failures = [];

  for (const path of walk(join(ROOT, "src"))) {
    const file = relative(ROOT, path);
    const result = scanSource(readFileSync(path, "utf8"));
    queries += result.queries;
    for (const e of result.exceptions) documented.push({ file, ...e });
    for (const v of result.violations) failures.push({ file, ...v });
  }

  if (failures.length === 0) {
    const exempt = documented.filter((e) => e.kind === "exempt");
    const checked = documented.filter((e) => e.kind === "checked");
    console.log(
      `✔ scope check: ${queries} queries, ${exempt.length} documented exceptions, ` +
      `${checked.length} scope-checked (clause assembled in JS)`,
    );
    // The inventory, with the machine's own alias list beside each human
    // sentence. Behind --inventory rather than on by default: its value is as a
    // diffable CI artifact — the reason says one thing about which table is
    // unscoped, the checker says another, and only seeing them on one line makes
    // that obvious — but a hundred lines on every local run is noise, and noise
    // is how a green tick stops being read.
    if (!process.argv.includes("--inventory")) process.exit(0);
    for (const label of ["exempt", "checked"]) {
      const rows = documented.filter((e) => e.kind === label);
      if (!rows.length) continue;
      console.log(`\n  ${label === "exempt" ? "scope-exempt" : "scope-checked"} (${rows.length}):`);
      for (const e of rows) {
        console.log(`    ${e.file}:${e.line}  [${e.unscoped.join(", ") || "-"}]\n      ${e.reason}`);
      }
    }
    process.exit(0);
  }

  const list = failures
    .map((f) => `    ${f.file}:${f.line}  (no clause for: ${f.unscoped.join(", ") || "?"})\n      ${f.snippet}`)
    .join("\n\n");
  console.error(`
✖ ${failures.length} corpus quer${failures.length === 1 ? "y reads" : "ies read"} entries or edges with no workspace scope.

${list}

  src/lib/scope.ts states the rule: every SQL statement whose rows can reach a
  response goes through scopeWhere. An admin gate authorises a surface; it does
  not widen which memory rows a caller may read.

  Add a scope clause, or document the exception with \`// scope-exempt: <reason>\`
  on the line above. If the clause IS there but assembled in JavaScript where
  this script cannot see it, use \`// scope-checked: <reason>\` instead.
`);
  process.exit(1);
}

// Importable for test/unit/scope-checker.test.ts; the CLI runs only when this
// file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
