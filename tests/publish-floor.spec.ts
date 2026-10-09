import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A publish raises the sequence floor the way a sign and a save do (pass B's
 * B4, D105).
 *
 * The publish was the one raise that skipped the claim: it raised the floor to
 * the frame's `head`, unconditionally, outside the library lock. The frame
 * belongs to the document (docs/identity.md, rule 3), so its number is not the
 * host's to rely on, and an unclaimed raise does not ask whether another tab
 * moved the floor since this mount saw it. The host reads the top seq from the
 * batch that is about to leave (`publishedLeaving`), and claims it from where
 * this mount saw the floor, under the lock.
 *
 * Read from the source, as `library-record.spec` reads the library writes: a
 * frame cannot be made to lie about `head` without building a second runtime,
 * and the property is that the number is never read at all.
 */
const MAIN = readFileSync(resolve(repo, "apps/runner/src/main.ts"), "utf8");
const MAILBOX = readFileSync(resolve(repo, "apps/runner/src/mailbox-session.ts"), "utf8");

/** The text of the `beforePublish` callback main.ts hands the mailbox session. */
function beforePublish(): string {
  const at = MAIN.indexOf("beforePublish:");
  expect(at, "main.ts hands the session a beforePublish").toBeGreaterThan(0);
  const open = MAIN.indexOf("{", at);
  let depth = 0;
  for (let index = open; index < MAIN.length; index += 1) {
    if (MAIN[index] === "{") depth += 1;
    else if (MAIN[index] === "}" && --depth === 0) return MAIN.slice(at, index + 1);
  }
  throw new Error("beforePublish has no end");
}

test.describe("the floor at a publish", () => {
  test("the session hands the host the batch, not the frame's head", () => {
    expect(MAILBOX).toMatch(/beforePublish\?: \(batch: Uint8Array\) => Promise<void>/);
    expect(MAILBOX).toMatch(/config\.beforePublish\?\.\(batchBytes\)/);
  });

  test("the floor is claimed from the batch, under the lock, never raised unclaimed", () => {
    const body = beforePublish();
    expect(body, "no unclaimed raise").not.toMatch(/raiseSeqFloor/);
    expect(body, "the claim D105 makes").toMatch(/withLibraryLock\([\s\S]*claimFloor\(/);
    expect(body, "from the batch's own top seq").toMatch(/publishedLeaving\(batch[^)]*\)[\s\S]*\.top/);
    expect(body, "no head in sight").not.toMatch(/\bhead\b/);
  });
});
