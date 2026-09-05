import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { REFUSALS } from "../src/refusals.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const page = (name: string): string => readFileSync(resolve(repo, "website", name), "utf8");

/**
 * What the site says about how this works, held against what it does.
 *
 * Every claim here was true when it was written and stopped being true when
 * the code moved. A page that describes a signature the compiler no longer
 * makes is worse than a page that says nothing: somebody reads it, believes
 * it, and decides something. These are the sentences that have already gone
 * stale once.
 */
test.describe("the site describes the system it actually sits on", () => {
  test("every refusal name in the registry is in the reference table", () => {
    // The registry is the source. A name added to it and not to the table is
    // a host emitting something a reader has no way to look up.
    const doc = page("docs/host-bridge.md");
    for (const name of Object.keys(REFUSALS)) {
      expect(doc, `${name} is missing from the refusal table`).toContain(`\`${name}\``);
    }
  });

  test("nothing claims a page or the desktop window signs what it builds", () => {
    // A browser has nowhere to keep a key, and one minted per build and
    // discarded signs nothing anybody can check. Both pages said otherwise.
    expect(page("make-your-own.md")).not.toMatch(/key that is thrown away/i);
    expect(page("make-your-own.md")).toMatch(/unsigned/i);
    expect(page("desktop.md")).not.toMatch(/compiles and signs/i);
    expect(page("desktop.md")).toMatch(/unsigned/i);
  });

  test("the security pages describe trust as it now works", () => {
    const tamper = page("tamper-proof.md");
    // Publishers are pinned across documents, not one document at a time.
    expect(tamper).toMatch(/each publisher signs with|key each publisher/i);
    // And the flat claim that a new document can never be placed is gone,
    // because a known publisher's new document now can be.
    expect(tamper).not.toMatch(/no amount of signing fixes that/i);
    // Never the word "verified" as a claim about a publisher.
    expect(tamper).toMatch(/not "verified"|never "verified"/i);

    const security = page("docs/security.md");
    // Version 3 took the shell out of the signed set.
    expect(security).not.toMatch(/and the sealed shell are signed/i);
    expect(security).toMatch(/signedEntries/);
    expect(security).toMatch(/known.*new.*conflict/is);
  });

  test("the playground page names the signed bytes as they are encoded", () => {
    const playground = page("playground.md");
    // The signature has been over deterministic CBOR since the envelope became
    // COSE; the page still called it a canonical payload string.
    expect(playground).not.toMatch(/canonical payload string/i);
    expect(playground).toMatch(/CBOR/);
  });
});
