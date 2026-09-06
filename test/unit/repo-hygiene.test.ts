/**
 * What the tree is allowed to contain.
 *
 * A `node_modules` SYMLINK was committed here as a mode-120000 blob pointing at
 * `../../node_modules` — two levels ABOVE the repository root. It reached main
 * because `.gitignore` said `node_modules/` WITH A TRAILING SLASH, and a
 * trailing slash matches a directory: a symlink of that name is a file to git,
 * so the rule never applied to it. Working from a git worktree that shares the
 * parent checkout's install is exactly how such a symlink comes to exist, so
 * this is a repeatable accident, not a one-off.
 *
 * The damage is not local. Every fresh clone gets a dangling link out of the
 * checkout, and on a machine where the target happens to exist, `npm install`
 * and everything else that walks node_modules operates outside the repository.
 *
 * Two assertions, because either alone is insufficient: the first says the tree
 * is clean today, the second says the rule that keeps it clean actually covers
 * the shape that got through.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const git = (...args: string[]) =>
  spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });

describe("the committed tree", () => {
  it("contains no symlink at all", () => {
    const run = git("ls-tree", "-r", "HEAD");
    expect(run.status, run.stderr).toBe(0);
    // Mode 120000 is git's symlink. Listed with paths so a failure names the
    // offender rather than just asserting a count.
    const links = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("120000 "))
      .map((line) => line.split("\t")[1]);
    expect(links).toEqual([]);
  });

  it("ignores a node_modules that is NOT a directory, not only one that is", () => {
    // check-ignore's exit status is 0 when the path is ignored and 1 when it is
    // not; `--no-index` answers for an untracked path, which is what a fresh
    // worktree's symlink is.
    //
    // The path is deliberately one that does NOT exist on disk. Git decides
    // whether a trailing-slash rule applies by STATTING the path, and it stats
    // THROUGH a symlink — so asking about the real `node_modules` link here
    // would answer "directory, ignored" on a machine where the link resolves
    // and "file, not ignored" on one where it dangles, which is the same
    // coin-toss that let the blob be committed in the first place. A path git
    // cannot stat is classified as a non-directory every time, which is exactly
    // the case `node_modules/` misses and `node_modules` catches.
    const notADir = git("check-ignore", "--no-index", "-q", "--", "test/__nope__/node_modules");
    expect(
      notADir.status,
      "a `node_modules` that is not a directory is committable: .gitignore's rule must not end in a slash",
    ).toBe(0);
    // And the ordinary directory case still holds, so the fix widens the rule
    // rather than trading one miss for another.
    const dir = git("check-ignore", "--no-index", "-q", "--", "test/__nope__/node_modules/left-pad");
    expect(dir.status).toBe(0);
  });
});

/**
 * Nothing that holds a person's memories can be committed.
 *
 * `wrangler d1 export` writes every entry in the brain, in plaintext, to
 * wherever `--output` points. Local runs can send it to /tmp, but the
 * repository root is one mistyped flag away, and a dump is exactly the kind of
 * large untracked file that rides along in a `git add -A` and is never noticed.
 * A local D1 is the same content as SQLite.
 *
 * `--no-index` so these are decided by the ignore rules alone, not by whether
 * the file happens to exist in the working tree right now.
 */
describe("memory-bearing files", () => {
  const ignored = (path: string) =>
    git("check-ignore", "--no-index", "-q", "--", path).status === 0;

  for (const path of [
    "brain.sql",                       // a d1 export in the repo root
    "test/__nope__/export.sql",        // …or anywhere else
    "dump.sqlite",
    "local.sqlite3",
    "state.db",
    "state.db-wal",                    // SQLite's sidecars carry content too
    "state.db-shm",
  ]) {
    it(`ignores ${path}`, () => {
      expect(ignored(path), `${path} could be committed`).toBe(true);
    });
  }

  it("still tracks db/schema.sql, which is the shipped schema and not a dump", () => {
    // The *.sql rule needs its negation; without it the schema silently leaves
    // the tree and a fresh deployment has no tables.
    expect(ignored("db/schema.sql")).toBe(false);
    expect(git("ls-files", "--error-unmatch", "db/schema.sql").status).toBe(0);
  });
});
