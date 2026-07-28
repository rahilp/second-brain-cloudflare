#!/usr/bin/env node
// Bundles everything the desktop app needs to deploy the Worker:
//   worker-dist/worker.js       — src/index.ts + deps as a single ES module
//   worker-dist/assets/…        — the dashboard files from public/
//   worker-dist/manifest.json   — bindings/vars/cron derived from wrangler.jsonc
// The Rust core embeds worker-dist/ at compile time (see worker_bundle.rs), so
// the installer always deploys the exact Worker version it shipped with.
import { build } from "esbuild";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const outDir = resolve(here, "..", "src-tauri", "worker-dist");

// The Vectorize index is created by the installer, not declared in
// wrangler.jsonc — these must match README.md / the Worker's expectations.
const VECTORIZE_DIMENSIONS = 384;
const VECTORIZE_METRIC = "cosine";

// Minimal JSONC → JSON: strips // and /* */ comments outside of strings.
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      inLine = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlock = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

const wrangler = JSON.parse(
  stripJsonComments(readFileSync(resolve(repoRoot, "wrangler.jsonc"), "utf8")),
);

const d1 = wrangler.d1_databases?.[0];
const vectorize = wrangler.vectorize?.[0];
const kv = wrangler.kv_namespaces?.[0];
if (!d1 || !vectorize || !kv || !wrangler.ai?.binding) {
  throw new Error("wrangler.jsonc is missing an expected binding (d1/vectorize/kv/ai)");
}

// The bundled Worker's version — the app compares this against a deployed
// Worker's /health version to offer updates. Read from the same SB_VERSION
// constant the Worker echoes, so both sides always agree.
// SB_VERSION does not have to live in the entry file: splitting the Worker into
// modules moved it to src/env.ts. Check the entry first, then walk the source
// tree, so moving it again does not break the desktop build.
const SB_VERSION_RE = /export\s+const\s+SB_VERSION\s*=\s*["']([^"']+)["']/;

function findWorkerVersion(entryFile) {
  const entryMatch = readFileSync(entryFile, "utf8").match(SB_VERSION_RE);
  if (entryMatch) return entryMatch[1];
  const stack = [resolve(repoRoot, "src")];
  while (stack.length) {
    for (const entry of readdirSync(stack.pop(), { withFileTypes: true })) {
      const path = resolve(entry.parentPath, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.endsWith(".ts")) {
        const match = readFileSync(path, "utf8").match(SB_VERSION_RE);
        if (match) return match[1];
      }
    }
  }
  return null;
}

const workerVersion = findWorkerVersion(resolve(repoRoot, wrangler.main));
if (!workerVersion) {
  throw new Error("could not find `export const SB_VERSION = \"...\"` anywhere under src/");
}

const manifest = {
  scriptName: wrangler.name,
  workerVersion,
  compatibilityDate: wrangler.compatibility_date,
  compatibilityFlags: wrangler.compatibility_flags ?? [],
  vars: wrangler.vars ?? {},
  cron: wrangler.triggers?.crons ?? [],
  d1Binding: d1.binding,
  d1Name: d1.database_name,
  vectorizeBinding: vectorize.binding,
  vectorizeName: vectorize.index_name,
  vectorizeDimensions: VECTORIZE_DIMENSIONS,
  vectorizeMetric: VECTORIZE_METRIC,
  kvBinding: kv.binding,
  aiBinding: wrangler.ai.binding,
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Like wrangler's nodejs_compat handling: bare Node builtins ("path") resolve
// to their "node:"-prefixed workerd-native modules and stay external, and a
// createRequire banner lets bundled CJS require() those externals at runtime
// (esbuild's __require shim defers to a module-scope `require` when defined).
const nodeBuiltins = new Set(builtinModules);
const nodeCompatPlugin = {
  name: "node-compat",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (nodeBuiltins.has(args.path)) {
        return { path: `node:${args.path}`, external: true };
      }
      return undefined;
    });
  },
};

await build({
  // Facade entry (like wrangler's): the Worker source exports test-only
  // constants alongside the handler, and workerd rejects non-handler named
  // exports on the main module — re-export only the default handler.
  stdin: {
    contents: `import worker from ${JSON.stringify("./" + wrangler.main)};\nexport default worker;`,
    resolveDir: repoRoot,
    loader: "js",
    sourcefile: "entry-facade.js",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  external: ["node:*", "cloudflare:*"],
  plugins: [nodeCompatPlugin],
  banner: {
    // workerd has no import.meta.url; wrangler's own nodejs_compat shim also
    // anchors createRequire at "/".
    js: 'import { createRequire as __sbCreateRequire } from "node:module";\nconst require = __sbCreateRequire("/");',
  },
  keepNames: true,
  outfile: resolve(outDir, "worker.js"),
  target: "es2022",
  logLevel: "warning",
});

cpSync(resolve(repoRoot, wrangler.assets.directory), resolve(outDir, "assets"), {
  recursive: true,
  filter: (src) => !src.endsWith(".DS_Store"),
});

writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`worker-dist ready: ${wrangler.name} (${wrangler.compatibility_date})`);
