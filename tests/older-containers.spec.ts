import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";
import { buildContainer, MANIFEST_VERSION } from "../src/core.js";
import { ContainerError, verifyContainer } from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAYLOAD_RE = /(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(<\/script>)/;

/**
 * What a reader says about a container built before the signature changed.
 *
 * This happened to somebody. The website and the runner deploy separately, so
 * for a while one was building containers with the old string signature and the
 * other was refusing them — with "Unsupported signature algorithm:
 * ECDSA-P256-SHA256", which is accurate and tells the person holding the file
 * nothing they can do.
 *
 * `manifestVersion` exists for exactly this and was not bumped when the format
 * changed, so a reader had nothing to go on but a value it did not recognise.
 */
const older = async (): Promise<string> => {
  const built = await buildContainer({
    files: { "index.html": new TextEncoder().encode("<!doctype html><p>hi") },
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "Older",
    signingKey: readFileSync(resolve(repo, "conformance/signing-key.pem"), "utf8"),
  });

  const parts = PAYLOAD_RE.exec(built.html)!;
  const archive = unzipSync(Buffer.from(parts[2]!, "base64"));
  const manifest = JSON.parse(new TextDecoder().decode(archive["runtime/manifest.json"]!));

  // Exactly what the older compiler wrote: the same fields, the previous
  // signature scheme, the previous manifest version.
  manifest.manifestVersion = 1;
  manifest.signatureAlgorithm = "ECDSA-P256-SHA256";
  archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest));

  return built.html.replace(
    PAYLOAD_RE,
    (_m, open: string, __: string, close: string) =>
      open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
  );
};

test("the manifest version marks the change of signature format", () => {
  // If this drops back to 1, a reader loses the only thing that lets it tell an
  // older container apart from a corrupt one.
  expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(2);
});

test("an older container is refused in words its owner can act on", async () => {
  const html = await older();

  const refusal = await verifyContainer(html).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(ContainerError);

  // Refused by name (spec §9.1): a version this reader does not read, with the
  // remedy that fits it, since a rebuild is what fixes a version 1 file.
  expect((refusal as ContainerError).code).toBe("UNSUPPORTED_MANIFEST_VERSION");
  const message = (refusal as ContainerError).message;
  expect(message).toContain("older compiler");
  expect(message).toContain("Rebuild it");
  // The constant is what the reader knows and what the person does not.
  expect(message).not.toContain("ECDSA-P256-SHA256");
});

test("the shell says something when a viewer will not run scripts", () => {
  /*
   * A preview that renders the document without executing it leaves the boot
   * line on screen for ever, describing work that never started — which is what
   * a phone showed when the same file was opened from its Files app. This is
   * the only message that can reach somebody in that state.
   */
  const template = readFileSync(resolve(repo, "dist/template.html"), "utf8");
  expect(template).toContain("<noscript>");
  expect(template).toMatch(/needs scripting/i);
});

test("the shell's first line explains itself if nothing else runs", () => {
  /*
   * The one thing guaranteed to render.
   *
   * A viewer that will not execute the bootloader leaves this line on screen
   * for ever, so it has to read as an answer rather than as a spinner. On a
   * phone, opened from a Files app, that is exactly what somebody saw: the
   * word "Opening" and then nothing, with no way to know whether to wait.
   */
  const template = readFileSync(resolve(repo, "dist/template.html"), "utf8");
  // Collapsed first: the sentence wraps in the source, and a reader sees it as
  // one line however it is written.
  const status = (/<p id="dai-boot-status">([\s\S]*?)<\/p>/.exec(template)?.[1] ?? "").replace(
    /\s+/g,
    " ",
  );

  expect(status).toMatch(/will not run the file/i);
  expect(status).toContain("opendai.app");
});
