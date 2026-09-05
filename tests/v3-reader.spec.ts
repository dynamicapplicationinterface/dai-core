import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { encode, decode } from "../src/cbor.js";
import { compileDirectory } from "../src/compile.js";
import { auditContainer, ContainerError, parseContainer, verifyContainer } from "../src/container.js";
import { CONTAINER_ENTRY, fromBase64, toBase64, ZIP_EPOCH } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/;

async function build(options: { manifestVersion?: 2 | 3; signed?: boolean; generator?: { tool: string; model?: string } } = {}) {
  const source = mkdtempSync(join(tmpdir(), "dai-v3-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>v3</p>', "utf8");
  return compileDirectory({
    sourceDir: source,
    root: repo,
    appName: "Three",
    signingKey: options.signed === false ? undefined : KEY,
    manifestVersion: options.manifestVersion,
    generator: options.generator,
  });
}

/** Rewrites the manifest inside a viewer-form container, without re-signing. */
function withManifest(html: string, edit: (manifest: Record<string, unknown>) => void): string {
  const parsed = parseContainer(html);
  const manifest = JSON.parse(new TextDecoder().decode(parsed.archive["runtime/manifest.json"]));
  edit(manifest);
  const archive = { ...parsed.archive, "runtime/manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") };
  const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
  return html.replace(PAYLOAD_TAG_RE, (_m, open: string, close: string) => open + payload + close);
}

/**
 * manifestVersion 3, read (spec §9). The writer's default is still 2: these
 * ask the compiler for 3 explicitly, because readers deploy before writers
 * and a version 3 file must never land on a host that cannot read it.
 */
test.describe("a version 3 container, read", () => {
  test("verifies, with the shell out of the signed set and generator signed", async () => {
    const built = await build({ manifestVersion: 3, generator: { tool: "dai-core", model: "claude-fable-5-1" } });
    expect(built.manifest.manifestVersion).toBe(3);
    expect(built.manifest.signedEntries).not.toHaveProperty([CONTAINER_ENTRY]);
    expect(built.manifest.hashes).toHaveProperty([CONTAINER_ENTRY]);
    expect(built.manifest.generator).toEqual({ tool: "dai-core", model: "claude-fable-5-1" });

    const verified = await verifyContainer(built.html);
    expect(verified.signature).toBe("valid");

    // The generator is a claim the key made: change it and the signature is gone.
    const edited = withManifest(built.html, (m) => { (m.generator as { tool: string }).tool = "someone-else"; });
    await expect(verifyContainer(edited)).rejects.toMatchObject({ code: "UNVERIFIED_SIGNATURE" });
  });

  test("a version 3 container that lists the shell in the signed set is refused", async () => {
    const built = await build({ manifestVersion: 3 });
    const listed = withManifest(built.html, (m) => {
      (m.signedEntries as Record<string, string>)[CONTAINER_ENTRY] = (m.hashes as Record<string, string>)[CONTAINER_ENTRY]!;
    });
    await expect(verifyContainer(listed)).rejects.toMatchObject({ code: "SIGNED_SET_MISMATCH" });
  });

  test("signedEntries is the authority: an entry only in hashes is refused, and a shell edit still caught", async () => {
    const built = await build({ manifestVersion: 3 });
    // Something appended to the archive and to `hashes`, not to the signed set.
    const parsed = parseContainer(built.html);
    const extra = new TextEncoder().encode("SELECT 1");
    const { sha256Hex } = await import("../src/core.js");
    const digest = await sha256Hex(extra);
    const archive = { ...parsed.archive, "app/extra.sql": extra };
    const manifest = JSON.parse(new TextDecoder().decode(parsed.archive["runtime/manifest.json"]));
    manifest.hashes["app/extra.sql"] = digest;
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
    const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
    const smuggled = built.html.replace(PAYLOAD_TAG_RE, (_m, open: string, close: string) => open + payload + close);
    const refusal = await verifyContainer(smuggled).catch((e: unknown) => e);
    expect((refusal as ContainerError).code).toMatch(/DIGEST_MISMATCH|SIGNED_SET_MISMATCH/);

    // The shell is unsigned in version 3 and still checked: the live shell
    // against the sealed one, and the sealed one against `hashes`.
    const shellEdited = built.html.replace("<meta charset", "<!-- x --><meta charset");
    await expect(verifyContainer(shellEdited)).rejects.toMatchObject({ code: "SHELL_MISMATCH" });
  });

  test("a version this reader does not know is refused by name, not as damage", async () => {
    const built = await build({ manifestVersion: 3 });
    const future = withManifest(built.html, (m) => { m.manifestVersion = 4; });
    const refusal = await verifyContainer(future).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("UNSUPPORTED_MANIFEST_VERSION");
    expect((refusal as ContainerError).message).toMatch(/update/i);
    expect((refusal as ContainerError).message).not.toMatch(/modified/i);

    const audit = await auditContainer(parseContainer(future));
    expect(audit.ok).toBe(false);
    expect(audit.unavailable).toMatch(/version 4/);
  });

  test("version 2 is still read, and its reverse-reconciliation hole stays closed", async () => {
    const two = await build({ manifestVersion: 2 });
    expect(two.manifest.manifestVersion).toBe(2);
    expect(two.manifest.signedEntries).toHaveProperty([CONTAINER_ENTRY]);
    expect((await verifyContainer(two.html)).signature).toBe("valid");

    // An entry added to hashes and the archive but not the signed set, on a
    // version 2 container: refused. "Version 2 stays verified" does not mean
    // "version 2 keeps the hole".
    const parsed = parseContainer(two.html);
    const extra = new TextEncoder().encode("SELECT 1");
    const { sha256Hex } = await import("../src/core.js");
    const archive = { ...parsed.archive, "app/extra.sql": extra };
    const manifest = JSON.parse(new TextDecoder().decode(parsed.archive["runtime/manifest.json"]));
    manifest.hashes["app/extra.sql"] = await sha256Hex(extra);
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n");
    const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
    const smuggled = two.html.replace(PAYLOAD_TAG_RE, (_m, open: string, close: string) => open + payload + close);
    await expect(verifyContainer(smuggled)).rejects.toMatchObject({ code: "SIGNED_SET_MISMATCH" });
  });

  test("an envelope wrapped in tag 18 verifies; an untagged one is what we write", async () => {
    const built = await build({ manifestVersion: 3 });
    const envelope = fromBase64(built.manifest.signature!);
    // Written untagged: the first byte is an array head, not a tag.
    expect(envelope[0]! >> 5).toBe(4);

    // The same envelope, tagged the way a standard COSE library emits it.
    const tagged = new Uint8Array(envelope.length + 1);
    tagged[0] = 0xd2; // tag 18
    tagged.set(envelope, 1);
    expect(decode(tagged)).toEqual(decode(envelope));
    const wrapped = withManifest(built.html, (m) => { m.signature = toBase64(tagged); });
    expect((await verifyContainer(wrapped)).signature).toBe("valid");

    // And any other tag is not a value this reader has a meaning for.
    const other = new Uint8Array(envelope.length + 1);
    other[0] = 0xc1;
    other.set(envelope, 1);
    expect(() => decode(other)).toThrow(/tag/i);
    expect(encode).toBeDefined();
  });
});

/**
 * The bootloader is a reader too, and the one that runs inside the file. A
 * version 3 container has to get past it, or "readers accept version 3" is
 * true of everything except the thing that actually mounts the application.
 */
test.describe("a version 3 container, in the opener", () => {
  test("mounts, and its bootloader verifies the signature", async ({ page }) => {
    test.slow();
    const built = await build({ manifestVersion: 3 });
    await page.goto("http://localhost:5175/");
    await page.setInputFiles("#file", { name: "three.dai.html", mimeType: "text/html", buffer: Buffer.from(built.html) });
    await page.locator("#card-open").click({ timeout: 60_000 });
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 60_000 });
    await expect(page.frameLocator("#cartridge").frameLocator("#dai-app").locator("p")).toHaveText("v3", { timeout: 60_000 });
    // Signed, and said so by the shell's own check.
    await expect(page.locator("#sheet-note")).toContainText(/signed by/i);
  });
});
