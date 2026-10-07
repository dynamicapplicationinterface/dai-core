/**
 * Every committed product, rebuilt and compared with what is committed.
 *
 *     npm run drift
 *
 * A generated file that is committed and never compared drifts in silence, and
 * each of these has: the conformance suite carried an older shell than the
 * build makes; the site served a runtime the build no longer made; the hosted
 * request was rebuilt by hand after a roster change moved it; the count floor
 * sat 30 percent under what CI passes (pass C's H1); and the merge fixtures'
 * `a.db` and `b.db` were regenerated in place by their own check, so a drift in
 * the committed bytes would pass while every reader after it read the
 * regenerated inputs (pass A's M4). Each was held by a different step, in a
 * different place, some only in CI and some only in a browser run.
 *
 * So one step rebuilds them all and says which moved. It runs first: in CI's
 * checks job and in the local gate (`npm run test:push`). Every step runs even
 * after one fails, so a run names everything that drifted at once. A product
 * that moved is left rebuilt in the tree, so the diff is there to read and
 * commit.
 *
 * The products: the library (built first; the rest read dist/), the site's
 * runtime (website/public/runtime), the conformance cases, the merge fixtures
 * (their inputs compared by content with what is committed, and the committed
 * bytes put back for every reader after), the impact map, the hosted
 * request (apps/runner/public/request.dai.html; signed, so compared by its
 * application entries, not its bytes), the model file's budget, the request
 * example's inline link against the cap (D186), and the count floor.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;

/** Every file under `dir` (or `dir` itself), with its SHA-256, keyed by repo-relative path. */
function hashes(dir, keep = () => true) {
  const out = new Map();
  const walk = (path) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
      return;
    }
    const rel = relative(repo, path).split("\\").join("/");
    if (keep(rel)) out.set(rel, createHash("sha256").update(readFileSync(path)).digest("hex"));
  };
  walk(resolve(repo, dir));
  return out;
}

/** The paths whose hash differs between two snapshots, or that one of them lacks. */
function moved(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

/** A command, inheriting output; true when it exits zero. Node is spawned directly, npm through a shell on Windows. */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: "inherit",
    shell: command === "npm" && process.platform === "win32",
  });
  return result.status === 0;
}

const steps = [];
const step = (name, work) => steps.push({ name, work });

step("library", () => (run("npm", ["run", "build:lib"]) ? [] : ["npm run build:lib failed; nothing after it reads a current dist/"]));

step("site runtime", () => {
  const before = hashes("website/public/runtime");
  if (!run(node, [join(repo, "scripts", "build-demo-pair.mjs")])) return ["build-demo-pair failed"];
  return moved(before, hashes("website/public/runtime")).map((path) => `${path} is not what the build stages; commit it`);
});

step("conformance cases", () =>
  run(node, [join(repo, "scripts", "build-conformance.mjs"), "--check"]) ? [] : ["build-conformance --check failed"],
);

/**
 * A database's content as text: its schema and every row of every table, in a
 * fixed order, each value with its storage class. Not its bytes: a file's
 * header records the SQLite library that wrote it (3.53 under Node 24 here,
 * another under CI's Node 22), so two writes of the same rows by two libraries
 * differ in bytes and agree here.
 */
export async function contentOf(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const value = (v) =>
      v === null ? "null" : v instanceof Uint8Array ? `x'${Buffer.from(v).toString("hex")}'` : `${typeof v}:${String(v)}`;
    const lines = [];
    const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all();
    for (const object of objects) lines.push(`${object.type} ${object.name}: ${object.sql ?? ""}`);
    for (const { name } of objects.filter((o) => o.type === "table" && !String(o.name).startsWith("sqlite_"))) {
      const rows = db
        .prepare(`SELECT * FROM "${String(name).replace(/"/g, '""')}"`)
        .all()
        .map((row) => Object.entries(row).map(([column, v]) => `${column}=${value(v)}`).join(" "))
        .sort();
      for (const row of rows) lines.push(`${name} ${row}`);
    }
    return lines.join("\n");
  } finally {
    db.close();
  }
}

step("merge fixtures", async () => {
  /*
   * The check regenerates a.db and b.db in place, and every reader after it
   * would read what it wrote, not what is committed (pass A's M4). So the
   * committed bytes are kept, the regenerated content is compared with theirs,
   * and the committed bytes go back, whatever the check found.
   */
  const inputs = [...hashes("conformance/merge", (rel) => /\/(a|b)\.db$/.test(rel)).keys()];
  const committed = new Map(inputs.map((rel) => [rel, readFileSync(resolve(repo, rel))]));
  const committedContent = new Map();
  for (const rel of inputs) committedContent.set(rel, await contentOf(resolve(repo, rel)));
  const failed = run("npm", ["run", "fixtures:check"]) ? [] : ["fixtures:check failed"];
  const changed = [];
  for (const rel of inputs) {
    const path = resolve(repo, rel);
    if (!existsSync(path) || (await contentOf(path)) !== committedContent.get(rel)) {
      changed.push(`${rel}: the generator writes different rows or schema than are committed`);
    }
    writeFileSync(path, committed.get(rel));
  }
  return [...failed, ...changed];
});

step("impact map", () => (run(node, [join(repo, "scripts", "impact-map.mjs"), "--check"]) ? [] : ["impact-map --check failed"]));

step("hosted request", async () => {
  const { compileDirectory, parseContainer } = await import(pathToFileURL(join(repo, "dist", "index.js")).href);
  const hosted = parseContainer(readFileSync(join(repo, "apps", "runner", "public", "request.dai.html"), "utf8"));
  const fresh = parseContainer(
    (await compileDirectory({ sourceDir: join(repo, "examples", "request"), root: repo, appName: "Request" })).html,
  );
  const app = (archive) => Object.keys(archive).filter((name) => name.startsWith("app/")).sort();
  const problems = [];
  if (JSON.stringify(app(hosted.archive)) !== JSON.stringify(app(fresh.archive))) problems.push("its application entries are not the example's");
  for (const name of app(fresh.archive)) {
    if (hosted.archive[name] && !Buffer.from(hosted.archive[name]).equals(Buffer.from(fresh.archive[name]))) {
      problems.push(`${name} is not what a build of examples/request makes today`);
    }
  }
  if (JSON.stringify(hosted.manifest.requires ?? []) !== JSON.stringify(fresh.manifest.requires ?? [])) problems.push("its `requires` differs");
  return problems.map((p) => `apps/runner/public/request.dai.html: ${p}; rebuild it with the CLI`);
});

step("model file budget", async () => {
  // The budget's numbers live with their reasons in the spec; read from there, not copied.
  const spec = readFileSync(join(repo, "tests", "model-file-size.spec.ts"), "utf8");
  const number = (name) => Number(new RegExp(`const ${name} = ([\\d_.]+);`).exec(spec)?.[1].replace(/_/g, ""));
  const [budget, growth, shrink] = [number("BUDGET_BYTES"), number("GROWTH_ALLOWED"), number("SHRINK_BEFORE_RESET")];
  if (![budget, growth, shrink].every(Number.isFinite)) return ["tests/model-file-size.spec.ts no longer states its budget in the shape this reads"];
  const { RECIPE } = await import(pathToFileURL(join(repo, "dist", "recipe.js")).href);
  const bytes = Buffer.byteLength(RECIPE, "utf8");
  console.log(`drift: the model file is ${bytes} bytes against a budget of ${budget}`);
  if (bytes > Math.floor(budget * (1 + growth))) return [`the model file is ${bytes} bytes, over its budget of ${budget}`];
  if (bytes < Math.ceil(budget * (1 - shrink))) return [`the model file is ${bytes} bytes, well under its budget of ${budget}: lower the budget`];
  return [];
});

step("inline link cap", async () => {
  const { compileDirectory } = await import(pathToFileURL(join(repo, "dist", "index.js")).href);
  const { INLINE_CAP, INLINE_KEY, inlineLink } = await import(pathToFileURL(join(repo, "dist", "link.js")).href);
  const built = await compileDirectory({
    sourceDir: join(repo, "examples", "request"),
    root: repo,
    appName: "Shared request",
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
  });
  const link = await inlineLink(built.html, "http://localhost:5175/", {
    template: readFileSync(join(repo, "dist", "template.html"), "utf8"),
    runtime: readFileSync(join(repo, "dist", "dai-runtime.js"), "utf8"),
  });
  if (!link) return [`the request example's inline link is over the cap of ${INLINE_CAP} and falls back to a reference link (D186)`];
  const length = link.split(`#${INLINE_KEY}=`)[1].length;
  console.log(`drift: the request example's inline link is ${length} characters, ${INLINE_CAP - length} under the cap`);
  return [];
});

step("count floor", () => {
  const before = hashes("tests/count-floor.json");
  if (!run(node, [join(repo, "scripts", "count-floor.mjs")])) return ["the count floor is stale or could not be regenerated"];
  return moved(before, hashes("tests/count-floor.json")).map(
    (path) => `${path} moved: the last green CI run passes a different count; commit the regenerated floor`,
  );
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const drifted = [];
  for (const { name, work } of steps) {
    console.log(`\ndrift: ${name}`);
    let problems;
    try {
      problems = await work();
    } catch (error) {
      problems = [`${name} could not be checked: ${error?.message ?? error}`];
    }
    for (const problem of problems) drifted.push(`${name}: ${problem}`);
  }

  console.log("");
  if (drifted.length === 0) {
    console.log(`drift: none; ${steps.length} products rebuilt and compared.`);
    process.exit(0);
  }
  for (const line of drifted) console.error(`drift: ${line}`);
  process.exit(1);
}
