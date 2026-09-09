import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The runtime and the merge module are versioned together, by construction.
 *
 * The merge reaches the frame as source the host sends beside the sibling —
 * lazily, so a document that never merges never loads it, and from the host,
 * so a document cannot supply its own. That leaves one question: is what
 * arrived the merge this runtime was built against?
 *
 * The frame answers it by hashing what it received against a digest compiled
 * into the bundle. These hold the build side of that: the digest is really
 * there, it is really the digest of the file the conformance fixtures import,
 * and the placeholder it replaced is gone. Whether the frame refuses on a
 * mismatch is the end-to-end test's half.
 */
test.describe("the runtime pins the merge module", () => {
  const runtime = () => readFileSync(join(repo, "dist", "dai-runtime.js"), "utf8");
  const digestOfMerge = () =>
    createHash("sha256").update(readFileSync(join(repo, "dist", "dai-merge.js"))).digest("hex");

  test("the built runtime carries the digest of the built merge module", () => {
    expect(runtime()).toContain(digestOfMerge());
  });

  test("the placeholder is gone, because unreplaced it refuses every merge", () => {
    /*
     * Fail-closed, and this is the test that says so out loud. If the stamping
     * step never ran, the constant is still `__DAI_MERGE_DIGEST__`, nothing
     * hashes to that, and every merge is refused — safe, and baffling to
     * anybody who has not read this. Catching it here makes the reason legible.
     */
    expect(runtime()).not.toContain("__DAI_MERGE_DIGEST__");
  });

  test("the pinned module is the one the fixtures import", () => {
    /*
     * The point of the whole arrangement (ruling C, condition 2). If these
     * ever differ, the frame is running a merge no fixture exercised, and
     * "three readers agree" stops describing what actually executes.
     */
    const fixtureModule = createHash("sha256")
      .update(readFileSync(join(repo, "dist", "dai-merge.js")))
      .digest("hex");
    const served = createHash("sha256")
      .update(readFileSync(join(repo, "apps", "runner", "public", "runtime", "dai-merge.js")))
      .digest("hex");
    expect(served).toBe(fixtureModule);
    expect(runtime()).toContain(served);
  });
});
