/**
 * Writes the merge module's digest into the runtime bundle.
 *
 * The frame imports the merge from source the host sends it, and hashes what
 * arrived against a digest compiled into the runtime. That is what makes
 * "the frame runs what the conformance fixtures ran" a property of the running
 * system rather than an assertion in a test — the frame cannot execute a merge
 * the fixtures did not, whatever it was handed.
 *
 * Run after `tsup`, because it needs both build outputs to exist. A post-build
 * patch rather than a `define`, for the same reason: the digest is of the built
 * bytes, and they do not exist while the config is being read.
 *
 *     node scripts/stamp-merge-digest.mjs
 *
 * Refuses if the placeholder is absent, which is the case where somebody has
 * edited the runtime and this step has quietly become a no-op. A digest that
 * silently fails to be written would leave the placeholder in place, and the
 * placeholder matches nothing — so the failure mode is every merge refusing,
 * which is safe but baffling. Better to fail here, where the reason is legible.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const merge = join(repo, "dist", "dai-merge.js");
const runtime = join(repo, "dist", "dai-runtime.js");
const PLACEHOLDER = "__DAI_MERGE_DIGEST__";

const digest = createHash("sha256").update(readFileSync(merge)).digest("hex");
const source = readFileSync(runtime, "utf8");

if (!source.includes(PLACEHOLDER)) {
  console.error(
    `${PLACEHOLDER} is not in dist/dai-runtime.js.\n` +
      "Either the runtime no longer pins the merge module, or this step has already run over it. " +
      "Both mean the pin is not doing what it claims, so this refuses rather than passing.",
  );
  process.exit(1);
}

writeFileSync(runtime, source.split(PLACEHOLDER).join(digest), "utf8");
console.log(`runtime pinned to dai-merge.js ${digest.slice(0, 16)}`);
