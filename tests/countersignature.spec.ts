import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { compileDirectory } from "../src/compile.js";
import { countersignaturesOf, parseContainer, verifyContainer } from "../src/container.js";
import { countersign, readCountersignatures } from "../src/cose.js";
import { fromBase64, sha256Hex, signedBytes, signedViewOf, toBase64, ZIP_EPOCH } from "../src/core.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");
const PAYLOAD_TAG_RE = /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/;

async function secondKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const kidHex = (await sha256Hex(spki)).slice(0, 16);
  const kid = new TextEncoder().encode(kidHex);
  const sign = async (bytes: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes as unknown as ArrayBuffer));
  // The kid as the verifier sees it: hex of the kid bytes.
  const kidLookup = [...kid].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { spki: toBase64(spki), kid, kidLookup, sign };
}

async function signedBuild() {
  const source = mkdtempSync(join(tmpdir(), "dai-cs-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>cs</p>', "utf8");
  return compileDirectory({ sourceDir: source, root: repo, appName: "Countersigned", signingKey: KEY, manifestVersion: 3 });
}

/** Puts a new envelope into the manifest, touching nothing else. */
function withEnvelope(html: string, envelope: Uint8Array): string {
  const parsed = parseContainer(html);
  const manifest = JSON.parse(new TextDecoder().decode(parsed.archive["runtime/manifest.json"]));
  manifest.signature = toBase64(envelope);
  const archive = { ...parsed.archive, "runtime/manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n") };
  const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
  return html.replace(PAYLOAD_TAG_RE, (_m, open: string, close: string) => open + payload + close);
}

/**
 * A second party signs the same document (spec §9.4).
 *
 * The slot is the unprotected header, so a countersignature changes no signed
 * byte: the publisher's signature is as valid with one as without. What the
 * countersignature binds is the payload, the publisher's protected header and
 * the publisher's signature together, so it cannot be moved onto another
 * signature over the same bytes. A kid this host does not hold is nothing —
 * not verified, not refused.
 */
test.describe("a countersignature", () => {
  test("adds nothing to the signed bytes, and verifies against a held key", async () => {
    const built = await signedBuild();
    const second = await secondKey();
    const payload = signedBytes(signedViewOf(built.manifest));

    const countersigned = await countersign(fromBase64(built.manifest.signature!), payload, second.kid, second.sign);
    const html = withEnvelope(built.html, countersigned);

    // The publisher's signature still verifies: nothing signed moved.
    const verified = await verifyContainer(html);
    expect(verified.signature).toBe("valid");
    expect(readCountersignatures(countersigned)).toHaveLength(1);

    // Held: valid. Not held: unheld, and nothing more is said about it.
    expect(await countersignaturesOf(verified, { [second.kidLookup]: second.spki })).toEqual([
      { kid: second.kidLookup, status: "valid" },
    ]);
    expect(await countersignaturesOf(verified, {})).toEqual([{ kid: second.kidLookup, status: "unheld" }]);

    // The wrong key for that kid: invalid, and still no refusal of the document.
    const other = await secondKey();
    expect(await countersignaturesOf(verified, { [second.kidLookup]: other.spki })).toEqual([
      { kid: second.kidLookup, status: "invalid" },
    ]);
  });

  test("cannot be moved onto a different signature over the same bytes", async () => {
    // Two builds of one application: same payload shape, different publisher
    // signatures (ECDSA draws a fresh nonce). A countersignature made over the
    // first envelope, carried into the second, does not verify — it signed the
    // publisher's signature too.
    const a = await signedBuild();
    const source = mkdtempSync(join(tmpdir(), "dai-cs-"));
    writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>cs</p>', "utf8");
    const b = await compileDirectory({
      sourceDir: source, root: repo, appName: "Countersigned", signingKey: KEY, manifestVersion: 3,
      documentUuid: a.manifest.documentUuid,
    });
    const second = await secondKey();
    const payloadA = signedBytes(signedViewOf(a.manifest));
    const csA = readCountersignatures(await countersign(fromBase64(a.manifest.signature!), payloadA, second.kid, second.sign))[0]!;

    // Graft A's countersignature onto B's envelope.
    const { decode, encode } = await import("../src/cbor.js");
    const envB = decode(fromBase64(b.manifest.signature!)) as unknown[];
    const unprotected = new Map(envB[1] as Map<unknown, unknown>);
    unprotected.set(11, [csA.protectedBytes, new Map(), csA.signature]);
    const grafted = encode([envB[0], unprotected, envB[2], envB[3]] as never);
    const html = withEnvelope(b.html, grafted);

    const verified = await verifyContainer(html);
    expect(verified.signature).toBe("valid");
    expect(await countersignaturesOf(verified, { [second.kidLookup]: second.spki })).toEqual([
      { kid: second.kidLookup, status: "invalid" },
    ]);
  });

  test("several countersigners fit in the one slot", async () => {
    const built = await signedBuild();
    const payload = signedBytes(signedViewOf(built.manifest));
    const one = await secondKey();
    const two = await secondKey();
    let envelope = fromBase64(built.manifest.signature!);
    envelope = await countersign(envelope, payload, one.kid, one.sign);
    envelope = await countersign(envelope, payload, two.kid, two.sign);
    const verified = await verifyContainer(withEnvelope(built.html, envelope));
    const verdicts = await countersignaturesOf(verified, { [one.kidLookup]: one.spki, [two.kidLookup]: two.spki });
    expect(verdicts).toEqual([
      { kid: one.kidLookup, status: "valid" },
      { kid: two.kidLookup, status: "valid" },
    ]);
  });
});
