// Provisions the Vectorize index and injects its binding at build/deploy time.
//
// Why this exists: the one-click "Deploy to Cloudflare" form prompts for
// Vectorize dimensions/metric whenever a vectorize binding is present in the
// committed wrangler config, and there is no supported way to preset those
// values (cloudflare/workers-sdk#14075). So the binding is kept OUT of
// wrangler.jsonc — which stops the form from prompting — and added back here
// against an index we create ourselves with the correct shape (384 / cosine).
//
// Produces wrangler.deploy.jsonc (gitignored). `npm run dev` and
// `npm run deploy` both run wrangler with `--config wrangler.deploy.jsonc`.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const INDEX = "second-brain-vectors";
const DIMENSIONS = 384;
const METRIC = "cosine";

// `npm run deploy` passes --create to provision the index (idempotently) with
// the right shape before deploying. `npm run dev` skips it.
if (process.argv.includes("--create")) {
  try {
    execSync(
      `wrangler vectorize create ${INDEX} --dimensions=${DIMENSIONS} --metric=${METRIC}`,
      { stdio: "inherit" },
    );
  } catch {
    // Index already exists (re-deploy) or the deploy token lacks permission to
    // create it — either way, carry on and bind to whatever index is there.
  }
}

// Insert the binding as the first key after the opening brace. The rest of the
// file — including any resource IDs the deploy form injected for D1/KV — is
// preserved verbatim, comments and all, since the output stays a .jsonc file.
const source = readFileSync("wrangler.jsonc", "utf8");
const binding = `
\t"vectorize": [
\t\t{ "binding": "VECTORIZE", "index_name": "${INDEX}" }
\t],`;
writeFileSync("wrangler.deploy.jsonc", source.replace("{", `{${binding}`));
