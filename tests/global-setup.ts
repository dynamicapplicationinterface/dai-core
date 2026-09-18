import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const fixture = resolve(here, "fixture");

/** Everything the build below reads, hashed; written next to what it built. */
const STAMP = resolve(repo, "dist", ".build-inputs");
const INPUTS = [
  "src",
  "tests/fixture",
  "tsup.config.ts",
  "package-lock.json",
  "scripts/copy-template.mjs",
  "scripts/stamp-merge-digest.mjs",
  "scripts/embed-assets.mjs",
  "scripts/retain-host.mjs",
  "scripts/generate-key.mjs",
];

function inputsDigest(): string {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...INPUTS], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const file of listed) {
    const path = resolve(repo, file);
    if (!existsSync(path)) continue;
    hash.update(file).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

/**
 * Builds the plugin, then compiles the fixture with it. Tests run against the
 * emitted artifact, not against the sources, so what is asserted is what a
 * consumer would actually ship.
 */
export default function globalSetup(): void {
  /*
   * The inner loop may reuse the last build — only when asked
   * (DAI_REUSE_BUILD, which the iterate tier sets) and only when nothing the
   * build reads has changed since it ran. The push tier and CI never set it,
   * so every run that stands behind a push or a merge builds from scratch.
   */
  const digest = inputsDigest();
  const built = resolve(fixture, "fixture.dai.html");
  if (
    process.env.DAI_REUSE_BUILD &&
    existsSync(built) &&
    existsSync(STAMP) &&
    readFileSync(STAMP, "utf8") === digest
  ) {
    console.log("global setup: nothing the build reads has changed since it last ran; reusing it");
    return;
  }

  // A signing key per run: the fixture is signed so the authenticity path is
  // exercised, and no private key is ever committed.
  execSync(`node ${JSON.stringify(resolve(repo, "scripts/generate-key.mjs"))} ${JSON.stringify(fixture)}`, {
    cwd: repo,
    stdio: "inherit",
  });

  // The library only: keeping a host is the deliberate build's job (D77).
  execSync("npm run build:lib", { cwd: repo, stdio: "inherit" });

  rmSync(resolve(fixture, "dist"), { recursive: true, force: true });
  rmSync(resolve(fixture, "fixture.dai.html"), { force: true });

  execSync("npx vite build", { cwd: fixture, stdio: "inherit" });

  const container = resolve(fixture, "fixture.dai.html");
  if (!existsSync(container)) {
    throw new Error(`Fixture build produced no container at ${container}`);
  }
  // Hashed again: generating the key writes into the fixture directory.
  writeFileSync(STAMP, inputsDigest(), "utf8");
}
