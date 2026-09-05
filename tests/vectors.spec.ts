import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { decode } from "../src/cbor.js";
import { countersignerHeader, countersignStructure, protectedHeader, sigStructure } from "../src/cose.js";
import { fromBase64, signedBytes, type SignedView } from "../src/core.js";
import { inlineFrom } from "../src/link.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Vectors {
  signedPayload: { view: SignedView; cbor: string };
  protectedHeader: { kid: string; cbor: string };
  sigStructure: { cbor: string };
  envelope: { base64: string; cbor: string; tagged: string };
  countersignStructure: { kidHex: string; protectedHeader: string; cbor: string };
  inlineCarrier: { version: number; dictionaryId: string; length: number; head: string; fragment: string };
  footer: { generation: number; hex: string };
  header: { hex: string };
}

const vectors = JSON.parse(readFileSync(resolve(repo, "conformance/vectors.json"), "utf8")) as Vectors;

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string): Uint8Array =>
  Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));

/**
 * The byte vectors, against the encoders that made them (docs/cddl.md).
 *
 * The CDDL says what the shapes are; the vectors say what the bytes are. This
 * is the guard that stops them drifting apart silently: a change to an encoder
 * that nobody meant shows up here as a diff, rather than months later as a
 * signature that will not verify against a file somebody already has.
 *
 * The Python reader checks the same file from the specification alone. Two
 * implementations agreeing on bytes is the point; this half only proves ours
 * still produces what it published.
 */
test.describe("the frozen byte vectors", () => {
  test("the signed payload encodes to exactly the published bytes", () => {
    expect(hex(signedBytes(vectors.signedPayload.view))).toBe(vectors.signedPayload.cbor);
  });

  test("the protected header and the signature structure are unchanged", () => {
    const header = protectedHeader(vectors.protectedHeader.kid);
    expect(hex(header)).toBe(vectors.protectedHeader.cbor);
    expect(hex(sigStructure(header, signedBytes(vectors.signedPayload.view)))).toBe(
      vectors.sigStructure.cbor,
    );
  });

  test("the countersignature structure binds the publisher's signature", () => {
    const envelope = decode(unhex(vectors.envelope.cbor)) as unknown[];
    const bodyProtected = envelope[0] as Uint8Array;
    const signature = envelope[3] as Uint8Array;
    const signProtected = countersignerHeader(unhex(vectors.countersignStructure.kidHex));

    expect(hex(signProtected)).toBe(vectors.countersignStructure.protectedHeader);
    expect(
      hex(countersignStructure(bodyProtected, signProtected, signedBytes(vectors.signedPayload.view), signature)),
    ).toBe(vectors.countersignStructure.cbor);
  });

  test("the envelope is written untagged and reads the same with tag 18", () => {
    const untagged = unhex(vectors.envelope.cbor);
    // Major type 4: an array head, not a tag.
    expect(untagged[0]! >> 5).toBe(4);
    expect(hex(fromBase64(vectors.envelope.base64))).toBe(vectors.envelope.cbor);
    expect(decode(unhex(vectors.envelope.tagged))).toEqual(decode(untagged));
  });

  test("the sectioned header and footer have the layout §2 states", () => {
    const header = unhex(vectors.header.hex);
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    expect([...header.subarray(0, 4)]).toEqual([0x44, 0x41, 0x49, 0x00]);
    expect(view.getUint16(4, true)).toBe(2);
    expect(view.getUint16(6, true)).toBe(0);
    expect(view.getUint32(8, true)).toBe(3);

    const footer = unhex(vectors.footer.hex);
    expect(footer.length).toBe(64);
    const f = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
    expect(Number(f.getBigUint64(0, true))).toBe(vectors.footer.generation);
    // Reserved is zero, and the trailing magic is the leading one backwards.
    expect([...footer.subarray(40, 60)].every((b) => b === 0)).toBe(true);
    expect([...footer.subarray(60)]).toEqual([0x00, 0x49, 0x41, 0x44]);
  });

  test("the inline carrier's header is a version and a dictionary id", async () => {
    const value = inlineFrom(vectors.inlineCarrier.fragment)!;
    expect(value).toBeTruthy();
    const bytes = fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
    expect(bytes.length).toBe(vectors.inlineCarrier.length);
    expect(bytes[0]).toBe(vectors.inlineCarrier.version);
    expect(hex(bytes.subarray(1, 5))).toBe(vectors.inlineCarrier.dictionaryId);
    expect(hex(bytes.subarray(0, 32))).toBe(vectors.inlineCarrier.head);

    // The dictionary named in the vector is the one this build holds; a
    // mismatch means the table moved and every published link with it.
    const { CONFUSABLES_ID } = await import("../src/confusables-id.js");
    expect(CONFUSABLES_ID).toMatch(/^[0-9a-f]{8}$/);
    const { DICTIONARY_ID } = await import("../src/dictionary.js");
    expect(hex(DICTIONARY_ID)).toBe(vectors.inlineCarrier.dictionaryId);
  });
});
