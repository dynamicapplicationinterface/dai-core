import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The impact map is built from the tracked files, not the working tree.
 *
 * CI regenerates the map from the pushed tree and fails `checks` when the
 * committed one differs, so a spec on disk that the push does not carry must
 * not enter it. Run on a copy of the generator in a scratch repository, so the
 * real tree is never touched.
 */
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("an untracked spec, or an untracked file a tracked spec imports, does not enter the map", () => {
  const root = mkdtempSync(join(tmpdir(), "impact-map-"));
  try {
    const put = (file: string, text = "") => {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    mkdirSync(join(root, "scripts"));
    copyFileSync(join(repo, "scripts", "impact-map.mjs"), join(root, "scripts", "impact-map.mjs"));
    // What the generator reads unconditionally: the build's configuration and the runtime's entries.
    put("tsup.config.ts");
    put("tests/global-setup.ts");
    put("src/runtime/bootloader.ts");
    put("src/replicated-frame.ts");
    put("tests/tracked.spec.ts", 'import "./untracked-helper";\n');
    put("tests/untracked-helper.ts");
    put("tests/untracked.spec.ts");

    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "scripts", "tsup.config.ts", "src", "tests/global-setup.ts", "tests/tracked.spec.ts");

    execFileSync(process.execPath, [join(root, "scripts", "impact-map.mjs"), "--write"], { cwd: root, stdio: "pipe" });
    const map = JSON.parse(readFileSync(join(root, "tests", "impact-map.json"), "utf8"));
    expect(Object.keys(map.specs)).toEqual(["tests/tracked.spec.ts"]);
    expect(map.specs["tests/tracked.spec.ts"]).toEqual(["tests/tracked.spec.ts"]);

    // Once added, both are in it: the scratch repository really is read through git.
    git("add", "tests/untracked.spec.ts", "tests/untracked-helper.ts");
    execFileSync(process.execPath, [join(root, "scripts", "impact-map.mjs"), "--write"], { cwd: root, stdio: "pipe" });
    const added = JSON.parse(readFileSync(join(root, "tests", "impact-map.json"), "utf8"));
    expect(Object.keys(added.specs).sort()).toEqual(["tests/tracked.spec.ts", "tests/untracked.spec.ts"]);
    expect(added.specs["tests/tracked.spec.ts"]).toEqual(["tests/tracked.spec.ts", "tests/untracked-helper.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
