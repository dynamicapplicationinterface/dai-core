import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { authorIdOf, showAuthorId, verifySignature } from "../src/identity.js";
import { batchIdOf, canonicalHeader, canonicalRows, rowsDigest, type BatchEntry } from "../src/replicated-batch.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));

/**
 * The identity vectors: the bytes a signature covers, frozen (docs/identity.md,
 * binding rule 10; test 7 of the sitting).
 *
 * The one exception to "a test imports the constants it asserts on": the subject
 * here is the literal. Every value below was derived outside `src`, from
 * node:crypto and CBOR assembled by hand, so the encoder is checked against the
 * layout and not against itself. A diff here is a format change: it bumps the
 * canonical form version, never passes as a refactor.
 *
 * The layout, version 1:
 * - Author id: SHA-256 of the raw (uncompressed, 65-byte) P-256 public key,
 *   first 16 bytes; shown as base64url.
 * - Canonical rows: a CBOR array of rows, ordered by table then `_r_seq`. Each
 *   row is `[table, [replica, seq, lc, entity, parents, deleted, session|null],
 *   [[column, value]...]]`, the columns ordered by name.
 * - Rows digest: SHA-256 of the canonical rows.
 * - Canonical header: `[version, document, author, lc, rowsDigest]`. This is
 *   what the signature covers. `pub` and `att` are not in it: `pub` is bound by
 *   the author id it must hash to, and `att` is added later by an authority
 *   without re-signing.
 * - Batch id: SHA-256 of the canonical header, first 16 bytes.
 * - Signature: ES256 over the canonical header, raw r||s (64 bytes).
 *
 * The key is the conformance suite's published test key, the same curve as the
 * publisher key.
 */
const KNOWN = {
  pub: "043132836416f18559e4fff96a16d5398c3fc2568e76e2d8b6b1fff1a30093f219f26b7886c05623ae83703eab86352311aac0f7d95e214c9d8ff7037652bc1921",
  author: "o6i1b5WRc3_KOFSjbrRYPw",
  authorHex: "a3a8b56f9591737fca3854a36eb4583f",
  document: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  rows: "8183656d6f7665738750a3a8b56f9591737fca3854a36eb4583f010750111111111111111111111111111111116000f6828263706c7901826373616e626534",
  digest: "6bcc8bf4b2faf92f67896af7f0a5203f00cd70b82590be3d9244f1a0f9e7002d",
  header:
    "8501782433663235303465302d346638392d343164332d396130632d30333035653832633333303150a3a8b56f9591737fca3854a36eb4583f0758206bcc8bf4b2faf92f67896af7f0a5203f00cd70b82590be3d9244f1a0f9e7002d",
  id: "3ba254e1dd4c7f80ebefc0aa2a62ea34",
  sig: "12cac6a36d691e830e137e953823b5bd8e0adaaf7dee1e44930a005499b7e34fa6c902b0b696bf29dfde4712ad309c313f4988be454ac3a6aa63e2fc3771479d",
};

/** The one row the vectors are built from. Its columns are given out of order on purpose. */
const ENTRY: BatchEntry = {
  table: "moves",
  row: {
    _r_replica: unhex(KNOWN.authorHex),
    _r_seq: 1,
    _r_lc: 7,
    _r_entity: new Uint8Array(16).fill(0x11),
    _r_parents: "",
    _r_deleted: 0,
    columns: { san: "e4", ply: 1 },
  },
};

test.describe("the frozen identity vectors", () => {
  test("the known public key is the one the vectors were made from", () => {
    // Guards the fixture, not the code: if the published test key changes,
    // every vector below is about a different key and this says so first.
    const jwk = createPublicKey(createPrivateKey(readFileSync(resolve(repo, "conformance/signing-key.pem"), "utf8")))
      .export({ format: "jwk" }) as { x: string; y: string };
    const raw = new Uint8Array([4, ...Buffer.from(jwk.x, "base64url"), ...Buffer.from(jwk.y, "base64url")]);
    expect(hex(raw)).toBe(KNOWN.pub);
  });

  test("the fingerprint of a known public key is the published author id", async () => {
    const id = await authorIdOf(unhex(KNOWN.pub));
    expect(hex(id)).toBe(KNOWN.authorHex);
    expect(showAuthorId(id)).toBe(KNOWN.author);
  });

  test("canonical rows and their digest are exactly the published bytes", async () => {
    expect(hex(canonicalRows([ENTRY]))).toBe(KNOWN.rows);
    expect(hex(await rowsDigest([ENTRY]))).toBe(KNOWN.digest);
  });

  test("the canonical header and the batch id are exactly the published bytes", async () => {
    const header = canonicalHeader({
      version: 1,
      document: KNOWN.document,
      author: unhex(KNOWN.authorHex),
      lc: 7,
      digest: unhex(KNOWN.digest),
    });
    expect(hex(header)).toBe(KNOWN.header);
    expect(hex(await batchIdOf(header))).toBe(KNOWN.id);
  });

  test("a known signature verifies over the canonical header, and one flipped byte does not", async () => {
    expect(await verifySignature(unhex(KNOWN.pub), unhex(KNOWN.header), unhex(KNOWN.sig))).toBe(true);
    const tampered = unhex(KNOWN.header);
    tampered[tampered.length - 1] ^= 0x01;
    expect(await verifySignature(unhex(KNOWN.pub), tampered, unhex(KNOWN.sig))).toBe(false);
  });
});
