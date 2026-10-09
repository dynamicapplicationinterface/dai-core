import { readdirSync, readFileSync } from "node:fs";
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
    // The builder keeps no publisher key (the opener's key signs rows as a
    // device, not containers), and one minted per build and discarded signs
    // nothing anybody can check. Both pages said otherwise.
    expect(page("make-your-own.md")).not.toMatch(/key that is thrown away/i);
    expect(page("make-your-own.md")).toMatch(/unsigned/i);
    expect(page("desktop.md")).not.toMatch(/compiles and signs/i);
    expect(page("desktop.md")).toMatch(/unsigned/i);
    // Pass C's H9 was in the builder itself, not in the page about it.
    expect(page("components/MakeYourOwn.vue")).not.toMatch(/thrown away/i);
    expect(page("components/MakeYourOwn.vue")).toMatch(/It is not signed\./);
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
    // The page says the opener keeps a key in the browser's storage, so it
    // cannot also say a page has nowhere to keep one.
    expect(tamper).toMatch(/key lives in the browser's\s+storage/);
    expect(tamper).not.toMatch(/nowhere to keep a key/i);

    const security = page("docs/security.md");
    // Version 3 took the shell out of the signed set.
    expect(security).not.toMatch(/and the sealed shell are signed/i);
    expect(security).toMatch(/signedEntries/);
    expect(security).toMatch(/known.*new.*conflict/is);
  });

  test("the security page says a lost key has no recovery, until one is built", () => {
    // Pass C's H4: clearing the site's data loses the key and the device writes
    // as a new author. Nothing recovers it today. The linked successor on loss
    // (backlog, V1.0 rulings, 5) is the session that makes this false, and it
    // has to change this sentence and this test together.
    expect(page("docs/security.md")).toMatch(/No recovery\s+is built\./);
  });

  test("the security page does not say removing a document removes everything", () => {
    // Pass C's H4, its other half: removing a document from the library keeps
    // the records of what the device already sent for it (its floors), so
    // "they are gone" was false for everything but the document.
    const security = page("docs/security.md");
    expect(security).not.toMatch(/and they are gone/);
    expect(security).toMatch(/It does not remove the records/);
  });

  test("no container the site serves says the signature covers the shell", () => {
    // Pass C's H10, in the files rather than the pages. A served container
    // carries the shell it was built with, comments included, and drift does
    // not rebuild these, so a sentence fixed in the template stays served
    // until each file is rebuilt. From manifest 3 the shell is outside the
    // signed set; every served file is read, and each says what the template
    // says now.
    const served = readdirSync(resolve(repo, "website", "public")).filter((name) => /\.dai(\.html)?$/.test(name));
    expect(served.length, "the site serves containers").toBeGreaterThanOrEqual(8);
    for (const name of served) {
      const file = page(`public/${name}`);
      expect(file, `${name} carries H10's old sentence`).not.toMatch(/the signature covers the shell's own digest/);
      expect(file, `${name} says what the template says now`).toMatch(/From manifest 3 the shell is outside the signed set/);
    }
  });

  test("the playground page names the signed bytes as they are encoded", () => {
    const playground = page("playground.md");
    // The signature has been over deterministic CBOR since the envelope became
    // COSE; the page still called it a canonical payload string.
    expect(playground).not.toMatch(/canonical payload string/i);
    expect(playground).toMatch(/CBOR/);
  });
});
