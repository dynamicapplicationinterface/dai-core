import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
 * What each served build is made from, and what it produces.
 *
 * The runner and the website are built by their `webServer` command and then
 * previewed. Locally `reuseExistingServer` is on, so a server left running
 * from an earlier run is reused — and the build step is skipped with it. The
 * pages then served are the ones built whenever that server started, which has
 * already cost an afternoon: sender.spec failed twice against a website built
 * before the runtime changed, and the failure looked like the change.
 */
const SERVED = [
  {
    port: 5175,
    what: "the runner (port 5175)",
    output: "apps/runner/dist/index.html",
    inputs: ["src", "apps/runner/src", "apps/runner/index.html", "apps/runner/public", "apps/runner/vite.config.ts"],
  },
  {
    port: 5176,
    what: "the website (port 5176)",
    output: "website/.vitepress/dist/index.html",
    inputs: ["website/docs", "website/public", "website/.vitepress/config.ts", "website/.vitepress/theme"],
  },
];

/**
 * Whether something already answers on this port.
 *
 * `localhost`, not `127.0.0.1`: the preview servers bind the name, which on
 * Windows resolves to `::1` first, and a check against the v4 address alone
 * reported a listening server as absent — which is how this guard's first
 * version let a stale server through.
 */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve2) => {
    const socket = connect({ port, host: "localhost" });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve2(answer);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** The newest modification time among the tracked files under these paths. */
function newestInput(paths: string[]): { at: number; file: string } {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  let at = 0;
  let file = "";
  for (const name of listed) {
    const path = resolve(repo, name);
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.isFile() && stat.mtimeMs > at) {
      at = stat.mtimeMs;
      file = name;
    }
  }
  return { at, file };
}

/**
 * Refuses a build older than what it is built from.
 *
 * A green run against a stale build reads exactly like a green run. This is the
 * one thing that can tell them apart from outside: if the served build predates
 * its own sources, the server was reused and its build step was skipped, and
 * nothing that follows says anything about the code in the working tree.
 */
async function refuseStaleServers(): Promise<void> {
  for (const served of SERVED) {
    // Only a server that is already up can be a reused one. With nothing
    // listening, the webServer command builds, and an older dist is simply
    // what is about to be replaced.
    if (!(await listening(served.port))) continue;
    const output = resolve(repo, served.output);
    if (!existsSync(output)) continue;
    const built = statSync(output).mtimeMs;
    const newest = newestInput(served.inputs);
    if (newest.at <= built) continue;
    throw new Error(
      `The build behind ${served.what} is older than what it is built from: ` +
        `${served.output} was built ${new Date(built).toISOString()}, and ${newest.file} changed ` +
        `${new Date(newest.at).toISOString()}. A server left running from an earlier run is being reused, ` +
        "and its build step was skipped, so this run would say nothing about the code here. " +
        "Stop the servers on ports 5174, 5175 and 5176 and run again.",
    );
  }
}

/**
 * Builds the plugin, then compiles the fixture with it. Tests run against the
 * emitted artifact, not against the sources, so what is asserted is what a
 * consumer would actually ship.
 */
export default async function globalSetup(): Promise<void> {
  await refuseStaleServers();
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
