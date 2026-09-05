import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { SUBSTITUTABLE_ENTRIES } from "../src/core.js";
import {
  ContainerError,
  parseContainer,
  refatten,
  thinned,
  verifyContainer,
} from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A container published without its engine.
 *
 * The engine is the largest thing in a container by an order of magnitude —
 * some 850 kB against 60 kB for everything else — and it is the same bytes in
 * every container built by the same compiler. A host that already holds that
 * exact copy gains nothing by carrying another, and a link that has to fit in
 * a URL cannot carry one at all.
 *
 * What makes it safe is that the manifest does not change. Every digest is
 * still there and the signature is the one the complete build carries, so the
 * two forms are one build; a host can only put back bytes it already had, and
 * only where the manifest says those exact bytes belong.
 */
const KEY = resolve(repo, "conformance", "signing-key.pem");

async function build(thin: boolean) {
  const source = mkdtempSync(join(tmpdir(), "dai-thin-"));
  writeFileSync(
    join(source, "index.html"),
    '<!doctype html><meta charset="utf-8"><p id="app">thin</p>',
    "utf8",
  );
  return compileDirectory({
    sourceDir: source,
    root: repo,
    appName: "Thin",
    signingKey: KEY,
    // One identity and one clock, so the only difference between the two
    // builds is the thing being tested.
    documentUuid: "9f1d2c3b-4a5e-6f70-8192-a3b4c5d6e7f8",
    thin,
  });
}

/** What a host that ships this engine would hand back, keyed on digest. */
function engineFrom(complete: { archive: Record<string, Uint8Array> }, digests: Record<string, string>) {
  const held = new Map<string, Uint8Array>();
  for (const name of SUBSTITUTABLE_ENTRIES) {
    const bytes = complete.archive[name];
    if (bytes) held.set(digests[name]!, bytes);
  }
  return (digest: string): Uint8Array | undefined => held.get(digest);
}

test.describe("the thin profile", () => {
  test("the engine is the only thing missing, and the manifest still covers it", async () => {
    test.slow();
    const fat = await build(false);
    const thin = await build(true);

    const fatArchive = parseContainer(fat.html).archive;
    const thinArchive = parseContainer(thin.html).archive;

    const gone = Object.keys(fatArchive).filter((name) => !(name in thinArchive));
    expect(gone.sort()).toEqual([...SUBSTITUTABLE_ENTRIES].sort());

    // The claims are unchanged: same entries listed, same digests.
    expect(thin.manifest.hashes).toEqual(fat.manifest.hashes);
    expect(Object.keys(thin.manifest.hashes)).toEqual(
      expect.arrayContaining([...SUBSTITUTABLE_ENTRIES]),
    );

    // And it is smaller by the size of an engine, which is the entire point.
    expect(thin.html.length).toBeLessThan(fat.html.length / 2);
  });

  test("thin and complete are one build, carrying one signature", async () => {
    /*
     * Derived from the built container rather than built again.
     *
     * ECDSA draws a fresh nonce for every signature, so two builds of
     * identical inputs are never the same file — signing twice would produce
     * two documents wearing one name, and "the same signature" would be a
     * sentence nothing could check. Thinning takes bytes out of a build that
     * has already been signed, which is what makes the claim true.
     */
    test.slow();
    const fat = await build(false);
    const thin = thinned(parseContainer(fat.html));

    const before = parseContainer(fat.html).manifest;
    const after = parseContainer(thin).manifest;
    expect(after.signature).toBe(before.signature);
    expect(after.signedEntries).toEqual(before.signedEntries);
    expect(after.hashes).toEqual(before.hashes);
  });

  test("built thin, it makes the same claims as a complete build", async () => {
    // Not the same signature bytes — nothing signed twice ever is — but the
    // same statement: the same entries, covered by the same digests.
    test.slow();
    const fat = await build(false);
    const thin = await build(true);
    expect(thin.manifest.hashes).toEqual(fat.manifest.hashes);
    expect(thin.manifest.signedEntries).toEqual(fat.manifest.signedEntries);
  });

  test("a host that cannot supply the engine refuses it, by name", async () => {
    test.slow();
    const thin = await build(true);

    const refusal = await verifyContainer(thin.html).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ContainerError);
    const error = refusal as ContainerError;

    // Not "this container has been modified": nothing was. Saying so would
    // send somebody looking for an attacker over a file that arrived exactly
    // as it was published.
    expect(error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(error.message).not.toMatch(/modified/i);
    expect(error.message).toMatch(/without its engine/i);
  });

  test("a host that holds those exact bytes opens it, and verifies every one", async () => {
    test.slow();
    const fat = await build(false);
    const thin = await build(true);
    const supply = engineFrom(parseContainer(fat.html), fat.manifest.hashes);

    const opened = await verifyContainer(thin.html, { supply });
    expect(opened.signature).toBe("valid");
    expect(opened.supplied.sort()).toEqual([...SUBSTITUTABLE_ENTRIES].sort());
    expect(opened.absent).toEqual([]);
  });

  test("a host offering the wrong bytes is caught by the entry check", async () => {
    test.slow();
    const thin = await build(true);

    // A supplier that answers every digest with something else. §6.1 says a
    // substitution never satisfies the entry check, and this is that: the
    // bytes go in and are hashed against the manifest like any other.
    const refusal = await verifyContainer(thin.html, {
      supply: () => new TextEncoder().encode("not the engine"),
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("DIGEST_MISMATCH");
  });

  test("filled back in, it is the complete build — byte for byte", async () => {
    test.slow();
    const fat = await build(false);
    const thin = thinned(parseContainer(fat.html));
    const supply = engineFrom(parseContainer(fat.html), fat.manifest.hashes);

    const completed = refatten(parseContainer(thin, { supply }));

    // The same file, not an equivalent one. Anything less would make a thin
    // container a lesser edition of the document rather than the document.
    expect(completed).toBe(fat.html);
    // And it stands on its own now, with nothing supplied.
    expect((await verifyContainer(completed)).signature).toBe("valid");
  });

  test("an entry that is not the engine going missing is still damage", async () => {
    test.slow();
    const fat = await build(false);

    // The application, removed. A reader must not mistake this for a document
    // published to be completed: only the engine and its glue may be absent,
    // and everything else missing is a container somebody took a piece out of.
    const parsed = parseContainer(fat.html);
    const stripped = { ...parsed.archive };
    delete stripped["app/index.html"];

    const { zipSync } = await import("fflate");
    const { toBase64, ZIP_EPOCH } = await import("../src/core.js");
    const payload = toBase64(zipSync(stripped, { level: 9, mtime: ZIP_EPOCH }));
    const damaged = fat.html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_match, open: string, close: string) => open + payload + close,
    );

    const refusal = await verifyContainer(damaged, {
      supply: () => new Uint8Array([1, 2, 3]),
    }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("DIGEST_MISMATCH");
  });
});
