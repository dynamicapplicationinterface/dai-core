import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import {
  CAPABILITY_REGISTRY,
  ContainerError,
  IMPLEMENTED_CAPABILITIES,
  SUPPORTED_MANIFEST_VERSIONS,
  checkManifestVersion,
  checkRequires,
  parseContainer,
  verifyContainer,
} from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The version gate, and the capability list behind it.
 *
 * Version 4 exists so a reader can refuse what it cannot honour. The rule it
 * enforces is that there is no degraded mode: for rosters, sessions and
 * confidentiality, opening a document without the feature it declares is the
 * vulnerability the feature was added to close. A reader that quietly ignored
 * `requires` would be exactly that hole.
 *
 * Readers before writers. Nothing here writes version 4; the compiler still
 * emits 3, and these hold the reading half that has to ship first.
 */

/**
 * A container with its manifest rewritten, the way a future compiler would
 * emit it. Unsigned, so no signature has to be reproduced — and the manifest
 * is excluded from `hashes`, so editing it leaves every entry digest intact.
 */
async function withManifest(edit: (m: Record<string, unknown>) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dai-v4-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><p id="app">here</p>', "utf8");
  const built = await compileDirectory({ sourceDir: dir, root: repo, appName: "Gate" });

  const { zipSync } = await import("fflate");
  const { MANIFEST_ENTRY, ZIP_EPOCH, toBase64 } = await import("../src/core.js");
  const parsed = parseContainer(built.html);
  const archive = { ...parsed.archive };
  const manifest = JSON.parse(
    new TextDecoder().decode(archive[MANIFEST_ENTRY]!),
  ) as Record<string, unknown>;
  edit(manifest);
  archive[MANIFEST_ENTRY] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
  return built.html.replace(
    /(<script type="application\/octet-stream" id="dai-payload">)([\s\S]*?)(<\/script>)/,
    (_m, open: string, _old: string, close: string) => open + payload + close,
  );
}

test.describe("the version gate", () => {
  test("version 4 is accepted and older versions still open — read down, never up", () => {
    // Read down is a hard rule: an old document makes no new claims, so a
    // newer reader applies nothing the document does not declare.
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(2);
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(3);
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(4);

    for (const version of [2, 3, 4]) {
      expect(() => checkManifestVersion({ manifestVersion: version }), `v${version}`).not.toThrow();
    }
  });

  test("a version above this reader is refused by name, which is how a pre-4 reader meets a version-4 file", () => {
    /*
     * `pre4-reader-refuses-v4` generalised. A reader pinned to 3 refuses a 4
     * by exactly this path, and once this reader knows 4 the same mechanism
     * has to keep working for 5 — otherwise the next bump has no gate.
     */
    const refusal = (() => {
      try {
        checkManifestVersion({ manifestVersion: 5 });
        return null;
      } catch (error) {
        return error as ContainerError;
      }
    })();
    expect(refusal).toBeInstanceOf(ContainerError);
    expect(refusal!.code).toBe("UNSUPPORTED_MANIFEST_VERSION");
    // Named as something to fix, not as damage.
    expect(refusal!.message).toMatch(/update the app/i);
  });

  test("older compilers get the other remedy", () => {
    // Version 1 predates the signature envelope; rebuilding is what fixes it.
    try {
      checkManifestVersion({ manifestVersion: 1 });
      throw new Error("should have refused");
    } catch (error) {
      expect((error as ContainerError).code).toBe("UNSUPPORTED_MANIFEST_VERSION");
      expect((error as ContainerError).message).toMatch(/rebuild/i);
    }
  });
});

test.describe("the capability list", () => {
  test("nothing is implemented yet, and the registry names what version 4 defines", () => {
    // Track 0 ships the gate before any capability. This assertion is meant to
    // change: each track adds its own name as it lands.
    expect(IMPLEMENTED_CAPABILITIES).toEqual([]);
    expect(CAPABILITY_REGISTRY).toEqual([
      "session",
      "shared-dataset",
      "replicated",
      "passphrase",
      "recipient-bound",
      "relay",
    ]);
  });

  test("a document requiring nothing is unaffected — which is every document that exists today", () => {
    expect(() => checkRequires({})).not.toThrow();
    expect(() => checkRequires({ requires: [] })).not.toThrow();
  });

  test("a document requiring what this reader lacks is refused, and the refusal names it", async () => {
    const refusal = (() => {
      try {
        checkRequires({ requires: ["session", "relay"] });
        return null;
      } catch (error) {
        return error as ContainerError;
      }
    })();
    expect(refusal).toBeInstanceOf(ContainerError);
    expect(refusal!.code).toBe("UNSUPPORTED_CAPABILITY");
    // Both named: "this app cannot open it" sends somebody looking for damage
    // that is not there.
    expect(refusal!.message).toContain("session");
    expect(refusal!.message).toContain("relay");
    expect(refusal!.message).toMatch(/update the app/i);
  });

  test("a real container declaring a capability is refused rather than opened without it", async () => {
    const html = await withManifest((m) => {
      m["manifestVersion"] = 4;
      m["requires"] = ["session"];
    });
    await expect(verifyContainer(html)).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });

  test("a version-4 container that needs nothing opens", async () => {
    const html = await withManifest((m) => {
      m["manifestVersion"] = 4;
    });
    const verified = await verifyContainer(html);
    expect(verified.manifest.manifestVersion).toBe(4);
  });

  test("the field is honoured on an older version too, rather than silently ignored", async () => {
    // A document that declares a dependency is declaring it. Ignoring the
    // field because the version is older would be the silent degradation the
    // whole gate exists to prevent.
    const html = await withManifest((m) => {
      m["requires"] = ["replicated"];
    });
    await expect(verifyContainer(html)).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
