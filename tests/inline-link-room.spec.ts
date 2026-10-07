import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { INLINE_CAP, INLINE_KEY, inlineLink } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The request example still travels inside its own link (D186).
 *
 * Every session document carries its rewritten schema, so the session schema
 * and the request app grow the inline link together, and past the cap the link
 * silently falls back to a reference link through a store. The room was
 * measured once and written in the backlog; here it is measured on every run
 * of the gate (`npm run drift`), signed with the conformance test key as
 * `arrival-link-state` builds it, and printed, so the figure in D186 is read
 * from the code rather than remembered.
 */
test("the request example's inline link fits under the cap", async () => {
  const built = await compileDirectory({
    sourceDir: join(repo, "examples", "request"),
    root: repo,
    appName: "Shared request",
    signingKey: resolve(repo, "conformance", "signing-key.pem"),
    allowTestKey: true,
  });
  const link = await inlineLink(built.html, "http://localhost:5175/", {
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
  });
  // inlineLink answers undefined over the cap, so this is the check that it fits.
  expect(link, "the request example no longer fits in a link; see D186").toBeTruthy();
  // What the cap is held against: the fragment value, as inlineLink measures it.
  const length = link!.split(`#${INLINE_KEY}=`)[1]!.length;
  console.log(`inline link: the request example is ${length} characters, ${INLINE_CAP - length} under the cap of ${INLINE_CAP}`);
  expect(length).toBeLessThanOrEqual(INLINE_CAP);
});
