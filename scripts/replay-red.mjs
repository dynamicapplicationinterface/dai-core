/**
 * Replays a fix's test against the code before the fix.
 *
 *     node scripts/replay-red.mjs --fix <sha> --test tests/<file>.spec.ts [--from <sha>] [--project <name>]
 *     node scripts/replay-red.mjs --fix <sha> --vector <name> [--from <sha>]
 *
 * `--with <file>` replays a hand variant of the test in place of the committed
 * one; the verdict line then says so. `--keep` leaves the worktree.
 *
 * A fix whose red was described rather than shown has one way left to show it:
 * take the test as the fix (or a later commit, `--from`) left it, put it on the
 * fix's parent, and run it there. It must fail. If it passes, the test does not
 * catch the defect it was written for.
 *
 * The run happens in a worktree at `<fix>^`, beside the repo, with the repo's
 * `node_modules` and `website/node_modules` joined in (junctions), so the tree
 * under test is never the working tree. The library is built there first:
 * Playwright starts the opener's web server, which bundles `dist/`, before its
 * own global setup builds it (D30).
 *
 * - A spec runs in its Playwright project (by default `node` when the file
 *   names no page, browser or context, as playwright.config.ts decides, and
 *   `chromium` otherwise).
 * - A vector runs as CI checks it: the generator and the sealer from `--from`,
 *   the vector's directory from `--from`, then `build-merge-fixtures.mjs
 *   --check --only <name>` against the parent's runtime.
 *
 * Verdicts, one line on stdout:
 *
 * - FAIL: the test failed on the parent. The red was real.
 * - PASS: the test passed on the parent. It does not catch the defect.
 * - N/A: the fix changed tests only, so its parent is not the defect's code.
 * - ERROR: nothing was judged (the test did not load, the generator could not
 *   import from the parent's runtime, no test ran). The reason follows.
 *
 * Exit 0 for FAIL, 1 for PASS, 2 for N/A or ERROR. Never run it beside
 * another Playwright run: it uses the same ports, and refuses to start while
 * any of them is taken.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = [5174, 5175, 5176];
const TIMEOUT_MS = 30 * 60_000;

const args = process.argv.slice(2);
const opt = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const fix = opt("fix");
const test = opt("test");
const vector = opt("vector");
const from = opt("from") ?? fix;
const keep = args.includes("--keep");
// A hand variant of the test (a local file) in place of the committed one: to
// ask whether a later assertion, past one the fix's own change fails, is red.
const variant = opt("with");
if (!fix || !(test || vector) || (test && vector)) {
  console.error("usage: replay-red.mjs --fix <sha> (--test <path> | --vector <name>) [--from <sha>] [--project <name>] [--keep]");
  process.exit(2);
}

function verdict(word, reason, code) {
  const what = test ?? `vector ${vector}`;
  console.log(`${word}  ${what}  fix ${fix.slice(0, 8)}${from !== fix ? ` test from ${from.slice(0, 8)}` : ""}${variant ? " (hand variant)" : ""}${reason ? `  (${reason})` : ""}`);
  process.exitCode = code;
}

function git(...a) {
  const r = spawnSync("git", a, { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout;
}

function gitBytes(...a) {
  const r = spawnSync("git", a, { cwd: repo, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, "127.0.0.1", () => server.close(() => done(true)));
  });
}

function run(command, argv, cwd, shell = false) {
  const r = spawnSync(command, argv, { cwd, encoding: "utf8", shell, timeout: TIMEOUT_MS, maxBuffer: 1 << 28 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, timedOut: r.error?.code === "ETIMEDOUT" };
}

function unjoin(path) {
  if (!existsSync(path)) return;
  // A junction is removed as a link; its target is left alone.
  if (process.platform === "win32") spawnSync("cmd", ["/c", "rmdir", path]);
  else rmSync(path);
}

// What the fix changed outside tests and the conformance suite. Nothing means a
// test-only fix: its parent holds the old test, not the defect's code.
const changed = git("show", "--name-only", "--format=", fix).split("\n").filter(Boolean);
const code = changed.filter((f) => !f.startsWith("tests/") && !f.startsWith("conformance/") && !f.startsWith("docs/"));
if (code.length === 0) {
  verdict("N/A", "the fix changed tests only", 2);
  process.exit();
}

const busy = [];
for (const port of PORTS) if (!(await portFree(port))) busy.push(port);
if (busy.length) {
  console.error(`ports in use: ${busy.join(", ")}. Stop the other run or its preview servers first.`);
  process.exit(2);
}

const parent = git("rev-parse", `${fix}^`).trim();
const tree = resolve(repo, "..", `dai-replay-${fix.slice(0, 8)}`);
if (existsSync(tree)) {
  console.error(`${tree} exists; remove it first (git worktree remove --force).`);
  process.exit(2);
}
git("worktree", "add", "--detach", tree, parent);

try {
  mkdirSync(join(repo, "test-results"), { recursive: true });
  symlinkSync(join(repo, "node_modules"), join(tree, "node_modules"), "junction");
  symlinkSync(join(repo, "website", "node_modules"), join(tree, "website", "node_modules"), "junction");

  const place = (path) => {
    const target = join(tree, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, variant && path === test ? readFileSync(variant) : gitBytes("show", `${from}:${path}`));
  };

  const build = run("npm", ["run", "build"], tree, true);
  if (build.status !== 0) {
    verdict("ERROR", `the parent did not build: ${build.out.trim().split("\n").slice(-3).join(" / ")}`, 2);
  } else if (test) {
    place(test);
    const text = readFileSync(join(tree, test), "utf8");
    const project = opt("project") ?? (/\b(page|browser|context|browserName)\b/.test(text) ? "chromium" : "node");
    const cli = join(repo, "node_modules", "@playwright", "test", "cli.js");
    const r = run(process.execPath, [cli, "test", test.replaceAll("\\", "/"), `--project=${project}`, "--reporter=list", "--retries=0"], tree);
    const passed = Number(r.out.match(/(\d+) passed/)?.[1] ?? 0);
    const failed = Number(r.out.match(/(\d+) failed/)?.[1] ?? 0);
    writeFileSync(join(repo, "test-results", `replay-${fix.slice(0, 8)}-${test.split("/").pop()}.log`), r.out);
    if (r.timedOut) verdict("ERROR", "timed out", 2);
    else if (failed > 0) verdict("FAIL", `${project}: ${failed} failed, ${passed} passed`, 0);
    else if (passed > 0 && r.status === 0) verdict("PASS", `${project}: ${passed} passed`, 1);
    else verdict("ERROR", `${project}: no test ran (${r.out.trim().split("\n").slice(-2).join(" / ")})`, 2);
  } else {
    for (const path of ["scripts/build-merge-fixtures.mjs", "scripts/sealer.mjs", "conformance/merge/signatures.json"]) place(path);
    const dir = `conformance/merge/${vector}`;
    rmSync(join(tree, dir), { recursive: true, force: true });
    for (const path of git("ls-tree", "-r", "--name-only", from, dir).split("\n").filter(Boolean)) place(path);
    const r = run(process.execPath, ["scripts/build-merge-fixtures.mjs", "--check", "--only", vector], tree);
    writeFileSync(join(repo, "test-results", `replay-${fix.slice(0, 8)}-${vector}.log`), r.out);
    // A throw before any comparison judges nothing: an import the parent's
    // runtime does not export, or a shape it does not have.
    // The README lists every vector, so it differs whenever the parent's
    // generator knew fewer; only a line naming the vector judges it.
    const crashed = /SyntaxError|does not provide an export|ERR_MODULE|^\s+at \S/m.test(r.out);
    const named = r.out.split("\n").filter((l) => l.includes(vector));
    if (r.timedOut) verdict("ERROR", "timed out", 2);
    else if (crashed) verdict("ERROR", `generator did not run: ${r.out.match(/^\w*Error.*$/m)?.[0]?.trim() ?? "see log"}`, 2);
    else if (named.length) verdict("FAIL", named.slice(0, 2).join(" / ").trim(), 0);
    else verdict("PASS", r.status === 0 ? "fixtures match" : "nothing differs for this vector", 1);
  }
} finally {
  if (!keep) {
    unjoin(join(tree, "website", "node_modules"));
    unjoin(join(tree, "node_modules"));
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: repo });
  }
}
