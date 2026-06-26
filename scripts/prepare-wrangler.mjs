// Wires up the Vectorize index + binding so that BOTH the one-click "Deploy to
// Cloudflare" button and a manual `wrangler deploy` end up with the VECTORIZE
// binding — without ever declaring it in wrangler.jsonc.
//
// Why it can't just live in wrangler.jsonc: when a vectorize binding is present
// in the committed config, the Deploy form prompts for the index
// dimensions/metric, and wrangler forbids presetting those inline
// (cloudflare/workers-sdk#14075). So users get stuck on blank fields. Keeping
// the binding out of wrangler.jsonc keeps that form clean.
//
// How the binding still gets applied: this script writes a generated config
// (wrangler.deploy.jsonc) that DOES contain the binding, plus the official
// `.wrangler/deploy/config.json` "redirect" that points wrangler at it. Wrangler
// honors that redirect for `deploy`/`dev`/`versions ...`, so even a bare
// `wrangler deploy` (what the one-click flow runs by default) picks up the
// binding. See: https://developers.cloudflare.com/workers/wrangler/configuration/
//
// This runs automatically on `postinstall`, so it happens during the install
// step that every path performs — no need for the deploy command to be
// `npm run deploy`.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const INDEX = "second-brain-vectors";
const DIMENSIONS = 384;
const METRIC = "cosine";

const DEPLOY_CONFIG = "wrangler.deploy.jsonc";

// Create the index only where it makes sense: an explicit `--create` (manual
// `npm run deploy`) or inside a Cloudflare build (the one-click flow sets
// WORKERS_CI). A plain `npm install` / CI test run does neither, so it stays
// offline and side-effect free. Vectorize can't be auto-provisioned at deploy
// the way KV/R2/D1 can, so the index must exist before the binding is applied.
const shouldCreateIndex =
  process.argv.includes("--create") || Boolean(process.env.WORKERS_CI);

if (shouldCreateIndex) {
  try {
    execSync(
      `npx wrangler vectorize create ${INDEX} --dimensions=${DIMENSIONS} --metric=${METRIC}`,
      { stdio: "inherit" },
    );
  } catch {
    // Index already exists (re-deploy) or the token can't create it — either
    // way, carry on and bind to whatever index is there. Never fail install.
  }
}

try {
  // Insert the binding as the first key after the opening brace. The rest of the
  // file — including any resource IDs the deploy form injected for D1/KV — is
  // preserved verbatim, comments and all, since the output stays a .jsonc file.
  const source = readFileSync("wrangler.jsonc", "utf8");
  const binding = `
\t"vectorize": [
\t\t{ "binding": "VECTORIZE", "index_name": "${INDEX}" }
\t],`;
  writeFileSync(DEPLOY_CONFIG, source.replace("{", `{${binding}`));

  // Redirect wrangler at the generated config. With this in place, a bare
  // `wrangler deploy` / `wrangler dev` uses wrangler.deploy.jsonc (binding and
  // all) instead of wrangler.jsonc. configPath is resolved relative to this
  // file, i.e. ../../ is the repo root.
  mkdirSync(".wrangler/deploy", { recursive: true });
  writeFileSync(
    ".wrangler/deploy/config.json",
    `${JSON.stringify({ configPath: `../../${DEPLOY_CONFIG}` }, null, 2)}\n`,
  );
} catch (err) {
  // Don't let a config-generation hiccup break `npm install`.
  console.error(`[prepare-wrangler] skipped config generation: ${err.message}`);
}
