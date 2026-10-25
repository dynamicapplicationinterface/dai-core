/**
 * The cold replies into the apps the runtime is driven over (the changeset
 * spike's own step, kept with the eval since Build 2a's re-ask).
 *
 * Each reply in replies/ is parsed as the repository parses a pasted bundle
 * (parseBundle) and written to apps/<name>/; then `dai check --json` and
 * `dai build`, as an author would run them. The ledger is out/extract.json.
 *
 *     npm run build && node eval/changesets-ten/extract.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseBundle } from "../../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, "..", "..", "dist", "bin.js");
const ledger = [];
for (const reply of readdirSync(join(here, "replies")).filter((f) => f.endsWith(".md")).sort()) {
  const name = reply.replace(/\.md$/, "");
  const dir = join(here, "apps", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const entry = { name };
  try {
    const bundle = parseBundle(readFileSync(join(here, "replies", reply), "utf8"));
    for (const [file, body] of Object.entries(bundle.files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    entry.files = Object.keys(bundle.files).sort();
    entry.parseWarnings = bundle.warnings;
  } catch (e) {
    entry.parse = `refused: ${e.message}`;
    ledger.push(entry);
    continue;
  }
  const run = (args) => {
    try {
      return { exit: 0, out: execFileSync(process.execPath, [bin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (e) {
      return { exit: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const check = run(["check", dir, "--json"]);
  try {
    const j = JSON.parse(check.out);
    entry.check = { exit: check.exit, ok: j.ok, findings: (j.findings ?? []).map((f) => `${f.id}${f.file ? ` (${f.file})` : ""}`) };
  } catch {
    entry.check = { exit: check.exit, raw: check.out.slice(0, 400) };
  }
  const build = run(["build", dir, "-o", join(tmpdir(), `dai-ten-${name}.dai.html`)]);
  entry.build = { exit: build.exit, tail: build.out.trim().split("\n").slice(-1).join("").slice(0, 200) };
  const text = entry.files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  entry.usesKit = /dai-kit\.js/.test(text);
  entry.ownScript = /window\.dai\.database\(\)/.test(text);
  entry.oldHandle = /openDatabase|selectObjects|selectValue/.test(text);
  ledger.push(entry);
}
mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", "extract.json"), JSON.stringify(ledger, null, 1) + "\n");
for (const e of ledger) console.log(e.name, "kit", e.usesKit, "own script", e.ownScript, "old handle", e.oldHandle, "check", JSON.stringify(e.check), "build", e.build?.exit, e.parse ?? "");
