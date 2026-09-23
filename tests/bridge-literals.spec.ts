import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * No literal bridge strings (docs/identity.md, binding rule 8; test 9 of the
 * sitting).
 *
 * A message name has one owner: `src/bridge.ts` for the host bridge,
 * `src/frame.ts` for the frame. A literal like `"DAI_HOST_SIGN"` or
 * `"dai:sign"` written anywhere else is a second copy of the name that nothing
 * keeps in step. `check-names` is where that is caught, in the typecheck chain.
 *
 * The scan is pointed at a folder here so the test holds the check itself, not
 * the state of the tree on the day it runs. The tree has one such literal today,
 * `"DAI_FRAME_REPLICA_ID"`, filed and fixed in step 2.
 */
function checkNames(dir: string) {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-names.mjs"), "--scan", dir], {
    cwd: repo,
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

test("check-names fails on a bridge message literal outside its owner, and names it", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-literals-"));
  writeFileSync(
    join(dir, "stray.ts"),
    [
      'window.parent.postMessage({ type: "DAI_HOST_SIGN", bytes }, "*");',
      'frame.postMessage({ type: "dai:sign" }, "*");',
      "",
    ].join("\n"),
    "utf8",
  );
  const { status, output } = checkNames(dir);
  expect(status, output).toBe(1);
  expect(output).toContain("stray.ts:1");
  expect(output).toContain("DAI_HOST_SIGN");
  expect(output).toContain("stray.ts:2");
  expect(output).toContain("dai:sign");
});

test("check-names passes a folder that takes its names from the owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-literals-"));
  writeFileSync(
    join(dir, "clean.ts"),
    ['import { TO_HOST } from "./bridge.js";', 'window.parent.postMessage({ type: TO_HOST.SIGN }, "*");', ""].join("\n"),
    "utf8",
  );
  const { status, output } = checkNames(dir);
  expect(status, output).toBe(0);
});
