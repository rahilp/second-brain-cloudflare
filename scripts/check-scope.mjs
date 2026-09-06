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
 * A fifth thing is not accepted, and it is the newest: a clause in the ON
 * CLAUSE OF AN OUTER JOIN. `LEFT JOIN entries m ON m.id = ev.entry_id AND
 * m.${scope.clause}` decides which row supplies a COLUMN, not which rows
 * appear — every row of the other side survives, with that column NULL and the
 * rest intact. GET /team/activity shipped exactly that and this script passed
 * it before the one-word fix and after it, with no number moving either time.
 * An INNER join's ON is a row filter and still counts; see THE OUTER-JOIN RULE
 * beside joinStructure().
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
 * `// scope-outer-join: <reason>` — the clause is here and applied, but by an
 * outer join's ON, so it nulls a column instead of dropping a row; here is why
 * that is enough. A third word in the same grammar rather than a third grammar,
 * and separate from `scope-exempt:` for the same reason `scope-checked:` is:
 * the one statement in src/ with this shape ALREADY carried an exemption
 * written about a different alias, so accepting that word here would have made
 * the rule a no-op at the only site that had the defect. Counted separately.
 *
 * Any marker sits on the line above, or within five lines above, and is spent
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
 *  1. A table named in a shape this lexer cannot follow now FAILS LOUDLY rather
 *     than vanishing. Two spellings are detected and reported: a FROM/JOIN whose
 *     table is an interpolation (`FROM ${TBL}`), and one split across a string
 *     concatenation (`"SELECT … FROM " + "entries …"`). Neither ever contains
 *     the token `FROM entries`, so both used to be invisible to every pattern
 *     here — not flagged AND not counted, which is precisely the failure shape
 *     this script exists to prevent. They are now reported like any other
 *     unparseable reference and answered with an annotation.
 *
 *     What is still invisible is narrower, and stated rather than implied: a
 *     split THROUGH an identifier (`"… FROM ent" + "ries"`), and a whole
 *     statement assembled in JavaScript and handed to `env.DB.prepare(sql)` as
 *     a bare variable, with no SQL text at the call site to see at all.
 *
 *     Detection of the two closed shapes is gated on the surrounding region
 *     looking like SQL (`looksLikeSql`), because `synced from ${name}` and
 *     `Synthesized from ${rows.length} entries` are both real strings in this
 *     tree and neither is a query. That gate is a heuristic, and it is the ONE
 *     place in this file that deliberately errs toward a false negative.
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
 * 10. The line-leading `*` / `//` prose skip applies only OUTSIDE a template.
 *     Inside one there is no such thing as a comment line, only SQL — an earlier
 *     draft skipped there too and silently ate `SELECT\n  * FROM entries`, which
 *     is ordinary wrapping rather than an edge case. Two consequences worth
 *     knowing, both deliberate and both erring toward a false positive:
 *       - A real trailing comment on the line that CLOSES a multi-line template
 *         is read as inside the span, so it cannot grant a licence. Put the
 *         annotation on its own line above the query.
 *       - SQL string literals are never lexed, so a clause written inside one —
 *         `WHERE note = 'x WHERE ${scope.clause}'` — counts. Building a SQL
 *         string lexer to catch a contrived case is not worth the surface it
 *         would add.
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
 * 12. The outer-join rule reads join STRUCTURE with the same regex lexer as
 *     everything else, and gives up loudly rather than guessing. What it can
 *     read: LEFT / RIGHT / FULL, with or without OUTER, in any whitespace,
 *     across newlines, with SQL comments and single-quoted literals blanked
 *     first so neither can invent a join or end an ON clause. What it refuses:
 *     an interpolated join keyword, a join onto a subquery, and a subquery
 *     inside an ON clause — each REPORTED as undecidable, never read as inner.
 *     What it does not attempt: which SIDE of the join a table sits on. It does
 *     not need to, because both sides are unsafe (one preserves the other
 *     table's rows, the other preserves its own), and a rule that guessed sides
 *     would be a rule that could guess wrong.
 *
 *     The one shape it cannot see is the one this file already admits in
 *     limitation 5: a scoped table inside a DERIVED TABLE on the optional side
 *     — `LEFT JOIN (SELECT ... FROM entries WHERE ${scope.clause}) m ON ...` —
 *     leaks the preserved side's rows exactly as the ON-clause spelling does,
 *     and its scope predicate is in a real WHERE. That spelling is caught today
 *     only because `JOIN (` is refused outright as undecidable, which is a
 *     coarser reason than the true one.
 * 13. It reads `src/**\/*.ts` and nothing else. `db/schema.sql`, `installer/`,
 *     `integrations/`, `test/` and every migration outside src/ are never
 *     looked at. That is survivable today because the SQL out there is DDL, but
 *     it is not a claim about them — it is an absence of one.
 *
 * WHAT IT DOES PROVE, AND WHAT IT DOES NOT
 *
 * This sentence was wrong in three successive reviews. Every time it was wrong
 * in the same direction — claiming completeness the tool cannot deliver — and
 * every time a short adversarial sweep found the counterexample. The version
 * below is written to be checked against the code branch by branch, and the
 * previous one still said "no fourth path" while a fourth path existed:
 *
 *   For every reference to `entries` or `edges` that this script matches INSIDE
 *   A TEMPLATE LITERAL, one of three things happens. It finds a narrowing
 *   clause for each alias — one that governs the ROW SET, which is why an outer
 *   join's ON clause does not qualify. Or it reports the statement. Or a human wrote a
 *   non-empty sentence in a real comment above it. A reference it cannot parse
 *   is reported; one hidden inside a nested template is reported; and a
 *   shortfall between what the file sweep saw and what the statement parser
 *   accounted for is reported. Nothing inside a template is dropped quietly.
 *
 *   Exactly one kind of match is discarded: a line OUTSIDE every template whose
 *   first non-space character is `*` or `//`. That is prose about SQL rather
 *   than SQL — it is how this file's own documentation, and src/lib/scope.ts's,
 *   survive the check — and it cannot reach an executing statement, because a
 *   line beginning that way outside a template is a comment or a syntax error.
 *
 *   Separately from that trichotomy, a FROM/JOIN whose table name is an
 *   interpolation or is split across a concatenation is reported on sight. It is
 *   not a reference this script can attribute to a table, so it is not resolved
 *   — it is refused, and counted, and a human writes down why it is safe.
 *
 *   It does NOT claim to have matched them all. Limitation 13 is a hole by
 *   construction, limitation 1 names what remains of a hole that used to be much
 *   wider, 12 names what the join lexer gives up on, and 2 through 11 are places
 *   where a match is judged on a name, a token or a position rather than on
 *   meaning.
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

/**
 * A SQL statement's opening verb. Used only to tell SQL from English prose when
 * deciding whether a dangling FROM/JOIN is worth reporting — `synced from
 * ${name}` and `Synthesized from ${rows.length} entries` are both real strings
 * in this tree, and neither is a query.
 */
const SQL_VERB = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;

/**
 * Two ways to name a table that no amount of lexing here can follow, each
 * REPORTED rather than skipped.
 *
 * Both used to be silent. A statement written either way was not flagged and
 * not counted — it was not seen at all — so the summary line got healthier as
 * the tree got worse, which is the one failure shape this script exists to
 * prevent. Neither can be resolved (the table name is not in the source text
 * at all, or not in one piece), so the honest outcome is a loud failure that a
 * human answers with `scope-exempt:` / `scope-checked:` like any other, not a
 * quiet pass.
 *
 * Neither construct exists in src/ today. That is the point: they are closed
 * before the first one is written, not after.
 */
const UNRESOLVABLE_TABLE = [
  {
    re: /\b(?:FROM|JOIN)\s+\$\{/gi,
    describe: "the table name is an interpolation (`FROM ${...}`), so which table this reads is not in the source",
  },
  {
    re: /\b(?:FROM|JOIN)[ \t]*["'`][ \t]*\+/gi,
    describe: "the table name is split across a string concatenation (`\"... FROM \" + \"entries ...\"`), so no single literal contains it",
  },
];

/**
 * Is the text around `index` SQL rather than English?
 *
 * Inside a template literal the whole template is the region, because that is
 * the statement. Outside one — a concatenation of double-quoted strings — the
 * region is a window, wide enough to reach a `SELECT` in an earlier fragment of
 * the same expression.
 *
 * A heuristic, and named as one. It errs toward a false NEGATIVE in exactly one
 * shape: a statement whose verb is far enough away, or absent, that the region
 * misses it. That is the direction chosen deliberately here and nowhere else in
 * this file, because the alternative is flagging ordinary prose containing the
 * word "from" and this check has to survive being on by default.
 */
function looksLikeSql(text, spans, index) {
  const span = spans.find((sp) => sp.start < index && index < sp.end);
  const region = span
    ? text.slice(span.start, span.end)
    : text.slice(Math.max(0, index - 300), index + 100);
  return SQL_VERB.test(region);
}

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
  { marker: "scope-outer-join:", kind: "outer-join" },
];

/**
 * Which markers may answer which finding. Kind-matched, not interchangeable.
 *
 * A third WORD in the existing grammar, not a third grammar: same `// marker:
 * reason` shape, same five-line lookback, same spent-by-the-first-query rule,
 * same refusal of an empty reason. The vocabulary is what had to grow, because
 * the three markers answer three different questions:
 *
 *   scope-exempt:     this query is NOT scoped, and that is correct.
 *   scope-checked:    it IS scoped; the clause is assembled in JavaScript.
 *   scope-outer-join: the clause is here and applied, but to COLUMNS rather
 *                     than rows — and here is why nulling a column is enough.
 *
 * Reusing `scope-exempt:` was the obvious cheap move and it is exactly wrong.
 * There are 48 of them in this tree and one of them already sits on the only
 * statement in src/ with this shape (src/routes/admin.ts's /patterns source
 * hydration), so the new rule would have been a no-op at the one site that
 * needed it and no one would ever have been asked the outer-join question.
 * That is the same argument that split scope-checked off scope-exempt in the
 * first place: a licence granted for one reason must not silently discharge
 * another.
 */
const MARKERS_FOR = {
  "outer-join": new Set(["outer-join"]),
  other: new Set(["exempt", "checked"]),
};

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
      // `end` as well as `start`: the outer-join rule has to read the tokens on
      // BOTH sides of an interpolation to see `${joinKind} JOIN` and
      // `LEFT ${maybeOuter} JOIN`, and in the masked text an interpolation is
      // indistinguishable from a run of ordinary spaces.
      interps.push({ inner, start, end: i, alias: before ? before[1] : null });
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

/**
 * Blank out single-quoted SQL string literals without moving anything.
 *
 * Used by the outer-join rule and by nothing else. That rule reads the SQL's
 * JOIN/ON structure, and a quoted literal is DATA sitting in the middle of it:
 * it can neither create a join nor end an ON clause. Both directions were
 * attacked and both are real:
 *
 *   - `SELECT 'LEFT JOIN' AS note ... JOIN entries m ON ... AND m.${scope}` is
 *     an INNER join and correctly scoped. Reading the literal as structure
 *     flags a correct query.
 *   - `LEFT JOIN entries m ON m.id = ev.entry_id AND ev.note != 'WHERE' AND
 *     m.${scope}` is the leak. NOT blanking the literal lets the `WHERE` inside
 *     it end the ON clause early, which puts the scope predicate outside the
 *     region and reads the leak as safe — a false NEGATIVE, and the direction
 *     that matters.
 *
 * Limitation 10 says SQL string literals are never lexed, and that stays true
 * of the scope-clause search: this blanking is local to the join lexer, where
 * the alternative is a false negative rather than a contrived false positive.
 */
const blankSqlStrings = (sql) =>
  sql.replace(/'(?:''|[^'\n])*'/g, (m) => " ".repeat(m.length));

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
 * NOT is deliberately not here either, and its absence is the same rule as the
 * one restricting operators to `=` and `IN`: `WHERE NOT ${scope.clause}` and
 * `WHERE NOT workspace_id IN (…)` return precisely everyone ELSE's rows. Having
 * NOT in this set reopened that class one token to the left of where it had been
 * closed. A NOT that applies to something else in the statement is untouched —
 * the rule is about the token immediately left of the clause.
 *
 * CASE WHEN is deliberately NOT here. `SUM(CASE WHEN ${scope.clause} THEN 1 ELSE
 * 0 END) … FROM entries` narrows the AGGREGATE, not the row set — the statement
 * still reads the whole corpus — so counting it as a scope clause was itself a
 * small false pass.
 */
const PREDICATE_KEYWORDS = new Set(["WHERE", "AND", "OR", "ON", "HAVING"]);

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
 * THE OUTER-JOIN RULE.
 *
 * A scope predicate in the ON clause of an OUTER join is not a scope predicate.
 *
 * GET /team/activity shipped this, and `check:scope` passed it before the fix
 * and after it — the tool had no opinion either way, because its whole question
 * was "is there a narrowing clause attributed to alias m":
 *
 *   FROM entry_events ev
 *   LEFT JOIN entries m ON m.id = ev.entry_id AND m.${scope.clause}
 *
 * `entry_events` carries no workspace column. With an outer join the ON clause
 * decides WHICH ROW SUPPLIES A COLUMN, not which rows appear: every `ev` row
 * survives, and an unmatched one arrives with `title` NULL and `entry_id` and
 * `payload.workspaceId` fully populated. An admin of company X read company Y's
 * rows that way. A row hidden in one column and disclosed in another is not
 * scoped. The fix was one word — LEFT JOIN to JOIN — and no number this script
 * printed moved, because it had no opinion about the join type at all.
 *
 * The rule is about the join type and nothing else. For an INNER join, ON is a
 * row filter and is exactly equivalent to WHERE, so its predicates still count:
 * a rule that banned ON clauses would be a ban on the correct spelling of the
 * fix. And it is per ON CLAUSE, not per statement — an inner join's ON in a
 * statement that also outer-joins is untouched.
 *
 * Which side the table sits on is deliberately NOT considered, because both
 * sides are unsafe and for different reasons:
 *
 *   - on the null-producing side (`x LEFT JOIN entries m ON m.${scope}`) the
 *     predicate filters `m` but preserves every `x` row, so the statement emits
 *     rows the caller's scope never authorised;
 *   - on the preserved side (`FROM entries e LEFT JOIN x ON e.${scope}`) the
 *     predicate does not filter at all — every `entries` row survives, merely
 *     unmatched.
 *
 * The safe shape stays green and is the reason the rule discounts a PREDICATE
 * rather than banning a JOIN: `LEFT JOIN entries m ON ... WHERE m.${scope}`
 * carries the same clause in the WHERE, which discards the unmatched rows
 * (`NULL IN (...)` is never true), so the scope governs the row set after all.
 *
 * WHAT IT READS, AND WHAT IT REFUSES TO GUESS
 *
 * An ON clause runs from its `ON` to the next clause keyword. It belongs to an
 * outer join if LEFT, RIGHT or FULL appears between the previous ON and this
 * one — a window rather than a nearest-JOIN walk, so a stray `JOIN` cannot
 * claim someone else's ON and downgrade it to inner. Comments and string
 * literals are blanked first: neither can create a join or end an ON clause.
 *
 * Where the structure cannot be read the statement is REFUSED, not assumed
 * inner — commit 81e5fc6's precedent, and the exact failure mode that produced
 * the leak above was a guard reading an unparseable construct as fine. Three
 * shapes are refused: a join keyword that is an interpolation (`${joinKind}
 * JOIN`, `LEFT ${maybeOuter} JOIN`), a join onto a subquery (`JOIN (SELECT
 * ...)`), and a subquery inside an ON clause, which also moves the clause
 * boundary out from under this lexer.
 */
const ON_TOKEN = /(?<![.\w$])ON(?![\w$])/gi;
const ON_CLAUSE_END =
  /\b(?:WHERE|GROUP|ORDER|HAVING|LIMIT|OFFSET|WINDOW|UNION|EXCEPT|INTERSECT|RETURNING|VALUES|JOIN|LEFT|RIGHT|FULL|INNER|CROSS|NATURAL)\b/gi;
/** The three join words that preserve unmatched rows. INNER and CROSS do not. */
const OUTER_JOIN_WORD = /\b(?:LEFT|RIGHT|FULL)\b/i;
/** A join keyword run ending right where an interpolation begins. */
const JOIN_RUN_BEFORE = /\b(?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL|OUTER)\s*$/i;
/** A join keyword run beginning right where an interpolation ends. */
const JOIN_RUN_AFTER = /^\s*(?:(?:LEFT|RIGHT|FULL|INNER|CROSS|NATURAL|OUTER)\s+)*JOIN\b/i;

function joinStructure(masked, interps) {
  const text = blankSqlStrings(blankSqlComments(masked));
  const regions = [];
  const undecidable = [];

  ON_TOKEN.lastIndex = 0;
  let m;
  let previousOnEnd = 0;
  while ((m = ON_TOKEN.exec(text)) !== null) {
    const window = text.slice(previousOnEnd, m.index);
    ON_CLAUSE_END.lastIndex = m.index + m[0].length;
    const stop = ON_CLAUSE_END.exec(text);
    const end = stop ? stop.index : text.length;
    regions.push({ start: m.index, end, outer: OUTER_JOIN_WORD.test(window) });
    if (/\bSELECT\b/i.test(text.slice(m.index, end))) {
      undecidable.push("a subquery inside an ON clause moves the clause boundary");
    }
    previousOnEnd = m.index + m[0].length;
  }

  if (/\bJOIN\s*\(/i.test(text)) {
    undecidable.push("this joins a subquery (`JOIN (SELECT ...)`), whose rows this cannot attribute");
  }
  for (const it of interps) {
    const before = text.slice(0, it.start);
    // An interpolation that is FOLLOWED by a join keyword run is only ambiguous
    // if it could BE the join type. `g.${scope.clause} LEFT JOIN users u` is a
    // scope clause that happens to be the last thing before a join, and reading
    // it as an interpolated join keyword refused a correct statement — found by
    // attacking this rule with the mixed inner/outer case. The existing
    // predicate-position test is exactly the question being asked: a clause sits
    // after WHERE/AND/OR/ON/HAVING, a join keyword never does.
    const couldBeJoinType = JOIN_RUN_AFTER.test(text.slice(it.end)) && !inPredicatePosition(before);
    if (JOIN_RUN_BEFORE.test(before) || couldBeJoinType) {
      undecidable.push("the join keyword is an interpolation, so whether this join is outer is not in the source");
    }
  }
  return { regions, undecidable: [...new Set(undecidable)] };
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
  const { regions, undecidable } = joinStructure(masked, interps);
  // A predicate inside the ON clause of an outer join governs which rows supply
  // a column, not which rows appear. It is recorded rather than dropped, so the
  // report can say WHY the alias came out unscoped.
  const inOuterOn = (offset) =>
    regions.some((r) => r.outer && offset > r.start && offset < r.end);
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
    predicates.push({
      alias: it.alias ? it.alias.toLowerCase() : null,
      outerOn: inOuterOn(it.start),
    });
  }
  predicates.hidden = hidden;
  predicates.undecidable = undecidable;

  const clean = blankSqlComments(masked);
  WORKSPACE_PREDICATE.lastIndex = 0;
  let m;
  while ((m = WORKSPACE_PREDICATE.exec(clean)) !== null) {
    if (!NARROWING_OPERATORS.has(m[2].replace(/\s+/g, " ").toUpperCase())) continue;
    // `WHERE NOT workspace_id = ?` is the inverse of a scope clause, and the
    // operator alone cannot see it.
    if (/\bNOT\s*$/i.test(clean.slice(0, m.index))) continue;
    // The masked text blanks interpolations, so a `${...}` right-hand side shows
    // as whitespace here; read the RHS from the original to tell it from nothing.
    if (!BOUND_RHS.test(sql.slice(m.index + m[0].length))) continue;
    predicates.push({
      alias: m[1] ? m[1].toLowerCase() : null,
      outerOn: inOuterOn(m.index),
    });
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
  // Only predicates that govern the ROW SET enter the pool. One in the ON clause
  // of an outer join is kept aside so the finding can name it: an alias that
  // came out unscoped BECAUSE of the join type is a different problem from one
  // that never had a clause, and it is answered with a different marker.
  const discounted = found.filter((p) => p.outerOn);
  const pool = found.filter((p) => !p.outerOn).map((p) => ({ ...p, used: false }));
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
  // Only blame the join for an alias whose own clause was the discounted one —
  // or for any of them, where the discounted clause carried no alias at all
  // (limitation 4: an unattributed clause joins a shared pool).
  const blamed = unscoped.filter((r) =>
    discounted.some((p) => p.alias === r.name || p.alias === null));
  return {
    unscoped,
    unreadable: dropped > 0
      ? [...refs.unreadable, `${dropped} reference(s) the sweep found and the parser did not`]
      : refs.unreadable,
    hidden: found.hidden,
    undecidableJoin: found.undecidable,
    outerJoin: blamed.map(describeRef),
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
    const span = spans.find((s) => s.start < match.index && match.index < s.end);
    // Prose in a doc comment, not SQL — src/lib/scope.ts and
    // src/tags/vocabulary.ts both describe this rule in these words, and a
    // checker that trips on its own documentation is one people switch off.
    //
    // Only OUTSIDE a template, though. Applied inside one it ate ordinary
    // formatting: `SELECT\n  * FROM entries` is one of the commonest ways to
    // wrap a select, and it was matched by the sweep and then dropped — not
    // flagged, not counted. Inside a template there is no such thing as a
    // comment line; there is only SQL.
    if (!span) {
      const trimmed = source.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    }

    const key = span ? span.start : `bare:${match.index}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      line: span ? lineOf(text, span.start) : lineNo,
      text: span ? text.slice(span.start + 1, span.end) : source,
    });
  }

  // The two constructs that name a table in a shape this lexer cannot follow.
  // Keyed by offset, not by span, so one of these inside a template that ALSO
  // contains a readable query yields two findings rather than being absorbed
  // into one — they are separate problems and each needs its own reason.
  for (const { re, describe } of UNRESOLVABLE_TABLE) {
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(text)) !== null) {
      const lineNo = lineOf(text, hit.index);
      const span = spans.find((sp) => sp.start < hit.index && hit.index < sp.end);
      // The same prose skip the sweep uses, for the same reason: this file and
      // src/lib/scope.ts both describe these constructs in words.
      if (!span) {
        const trimmed = (lines[lineNo - 1] ?? "").trimStart();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      }
      if (!looksLikeSql(text, spans, hit.index)) continue;
      seen.set(`unresolvable:${hit.index}`, {
        line: lineNo,
        text: (lines[lineNo - 1] ?? "").trim(),
        problem: `${describe}: ${(lines[lineNo - 1] ?? "").trim().slice(0, 80)}`,
      });
    }
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
    // A construct whose table name is not resolvable at all: the problem is
    // already decided, and running it through the parser would only produce a
    // second, less useful description of the same thing.
    const { unscoped, unreadable, hidden, undecidableJoin, outerJoin, total } = query.problem
      ? { unscoped: [], unreadable: [], hidden: [], undecidableJoin: [], outerJoin: [], total: 1 }
      : unscopedRefs(query.text);
    const names = unscoped.map(describeRef);

    // Three ways a statement can be a problem, in the order they matter. The
    // first two are the shapes that used to VANISH — counted as nothing, so the
    // summary line got healthier as the tree got worse — and they take priority
    // over a missing clause, because a scope clause elsewhere in the statement
    // says nothing about a branch that carries its own FROM.
    let problem = query.problem ?? null;
    // Which marker may answer this finding. Only the outer-join family needs
    // its own word; everything else is answered as it always was.
    let kind = "other";
    if (problem) {
      // decided above
    } else if (hidden.length) {
      problem = `a corpus table is reached from inside a nested template, where the clause for it cannot be read: \${${hidden[0]}}`;
    } else if (unreadable.length || total === 0) {
      problem = `could not parse the table reference: ${unreadable.join(", ") || query.text.replace(/\s+/g, " ").trim().slice(0, 60)}`;
    } else if (undecidableJoin.length) {
      // 81e5fc6's precedent: what the lexer cannot follow fails loudly. Ahead of
      // the outer-join verdict below because "this might be an outer join" is
      // not the same finding as "this is one", and ahead of a missing clause
      // because a clause says nothing when the structure it sits in is unread.
      kind = "outer-join";
      problem = `the join type cannot be read, so whether a scope clause governs rows or only columns is undecidable: ${undecidableJoin.join("; ")}`;
    } else if (outerJoin.length) {
      kind = "outer-join";
      problem =
        `the only scope clause for ${outerJoin.join(", ")} sits in the ON clause of an outer join, ` +
        `where it decides which rows supply a column and not which rows appear: ` +
        query.text.replace(/\s+/g, " ").trim().slice(0, 100);
    } else if (unscoped.length) {
      problem = query.text.replace(/\s+/g, " ").trim().slice(0, 100);
    }
    if (!problem) continue;

    const from = Math.max(0, query.line - 1 - ANNOTATION_LOOKBACK);
    const wanted = MARKERS_FOR[kind];
    let found = null;
    for (let i = query.line - 1; i >= from && !found; i--) {
      if (claimed.has(i)) continue;
      const hit = annotationOn(lines[i], inSpan(lineStarts[i] ?? 0));
      // A marker of the wrong kind is not consumed and not counted against this
      // finding: it is an answer to a different question, and it stays available
      // to the query it was written for.
      if (hit && wanted.has(hit.kind)) found = { index: i, ...hit };
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
    const outerJoin = documented.filter((e) => e.kind === "outer-join");
    // The fourth count is APPENDED, never interleaved: CI and
    // test/unit/scope-checker.test.ts both read the first three off this line by
    // position, and a count that moves the others is a count that breaks them.
    console.log(
      `✔ scope check: ${queries} queries, ${exempt.length} documented exceptions, ` +
      `${checked.length} scope-checked (clause assembled in JS), ` +
      `${outerJoin.length} scope-outer-join (clause governs a column, not the row set)`,
    );
    // The inventory, with the machine's own alias list beside each human
    // sentence. Behind --inventory rather than on by default: its value is as a
    // diffable CI artifact — the reason says one thing about which table is
    // unscoped, the checker says another, and only seeing them on one line makes
    // that obvious — but a hundred lines on every local run is noise, and noise
    // is how a green tick stops being read.
    if (!process.argv.includes("--inventory")) process.exit(0);
    for (const label of ["exempt", "checked", "outer-join"]) {
      const rows = documented.filter((e) => e.kind === label);
      if (!rows.length) continue;
      console.log(`\n  ${MARKERS.find((mk) => mk.kind === label).marker.slice(0, -1)} (${rows.length}):`);
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

  If the clause is in the ON clause of an OUTER join, it decides which rows
  supply a column and not which rows appear — an unmatched row still ships, with
  that column NULL and every other column intact. Make the join INNER, or repeat
  the clause in the WHERE, or write \`// scope-outer-join: <reason>\` saying why
  nulling a column is enough here.
`);
  process.exit(1);
}

// Importable for test/unit/scope-checker.test.ts; the CLI runs only when this
// file is the entry point.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
