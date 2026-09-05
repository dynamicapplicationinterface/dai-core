import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { ContainerError, parseContainer, verifyContainer } from "../src/container.js";
import { CONTAINER_ENTRY, sha256Hex } from "../src/core.js";
import { DICTIONARY_ID } from "../src/dictionary.js";
import { packInline, unpackInline } from "../src/inline.js";
import { compressPublicKey, decompressPublicKey } from "../src/p256.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");

const HOST = {
  template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
  runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
};

const engine = await (async () => {
  const held = new Map<string, Uint8Array>();
  for (const file of ["sqlite3.wasm", "index.mjs"]) {
    const bytes = new Uint8Array(
      readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist", file)),
    );
    held.set(await sha256Hex(bytes), bytes);
  }
  return (digest: string) => held.get(digest);
})();

async function example(name: string, signed = false) {
  return compileDirectory({
    sourceDir: resolve(repo, "examples", name),
    root: repo,
    appName: name,
    signingKey: signed ? KEY : undefined,
  });
}

/**
 * The compact carrier: send what is the document's, rebuild what is the host's.
 *
 * The claim under test is the strong one. Not "opens", not "equivalent": when
 * the sender's host and the receiver's host agree, the file that comes out is
 * the file the complete build produced, byte for byte, and it verifies with
 * the signature the publisher put on it. Everything the link leaves out is
 * proven against a sealed digest before it is used.
 */
test.describe("the compact inline carrier", () => {
  test("a signed app goes out small and comes back as the identical file", async () => {
    test.slow();
    const built = await example("chore-chart", true);
    const value = await packInline(parseContainer(built.html), HOST);

    // The number that made the cap decision moot: from 115 KB to this.
    expect(value.length).toBeLessThan(4 * 1024);

    const back = await unpackInline(value, HOST, { supply: engine });
    expect(back).toBe(built.html);
    expect((await verifyContainer(back)).signature).toBe("valid");
  });

  test("a shell this host cannot rebuild is carried, and the link still opens", async () => {
    test.slow();
    // A publisher who built with a different template: the sealed shell is not
    // one this host can reproduce, so the sender must not leave it out.
    const template = HOST.template.replace("<meta charset", "<!-- another compiler -->\n<meta charset");
    const built = await compileDirectory({
      sourceDir: resolve(repo, "examples/packing-list"),
      root: repo,
      appName: "Foreign",
      templatePath: (() => {
        const dir = mkdtempSync(join(tmpdir(), "dai-foreign-"));
        const path = join(dir, "template.html");
        writeFileSync(path, template, "utf8");
        return path;
      })(),
    });

    const value = await packInline(parseContainer(built.html), HOST);
    const back = await unpackInline(value, HOST, { supply: engine });
    expect(back).toBe(built.html);
    expect((await verifyContainer(back)).signature).toBe("unsigned");

    // And it cost what a shell costs. A link that quietly carried the shell
    // would be a link somebody was surprised by.
    const withOwnShell = await packInline(parseContainer((await example("packing-list")).html), HOST);
    expect(value.length).toBeGreaterThan(withOwnShell.length * 3);
  });

  test("a link naming a dictionary this host does not have is refused by name", async () => {
    const built = await example("packing-list");
    const value = await packInline(parseContainer(built.html), HOST);
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    bytes[1] = (bytes[1]! + 1) & 0xff; // not our dictionary
    const foreign = bytes.toString("base64url");

    const refusal = await unpackInline(foreign, HOST).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("LINK_UNSUPPORTED");
    // Never inflated against the wrong dictionary and handed on as a document.
    expect((refusal as ContainerError).message).toMatch(/dictionary/i);
  });

  test("a link cut in transit is refused rather than read in part", async () => {
    const built = await example("packing-list");
    const value = await packInline(parseContainer(built.html), HOST);
    const cut = value.slice(0, Math.floor(value.length * 0.7));

    const refusal = await unpackInline(cut, HOST, { supply: engine }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("LINK_DAMAGED");
  });

  test("a link whose elided digest does not match this host's copy does not run", async () => {
    test.slow();
    const built = await example("packing-list", true);
    const value = await packInline(parseContainer(built.html), HOST);

    // The receiver holds a different bootloader from the sender. The link says
    // "you have the same shell as I sealed"; this host must check, not believe.
    const other = { ...HOST, runtime: HOST.runtime + "\n// a newer bootloader\n" };
    const refusal = await unpackInline(value, other, { supply: engine }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("LINK_UNRECONSTRUCTABLE");
    expect((refusal as ContainerError).message).toContain(CONTAINER_ENTRY);
  });

  test("a carried file changed in the link fails the signature", async () => {
    test.slow();
    // The digests do not travel; they are recomputed. So a byte changed in the
    // application changes its digest, the signed view no longer matches, and
    // the signature — which travels — fails over it. There is no field an
    // attacker could edit to say otherwise.
    const built = await example("packing-list", true);
    const parsed = parseContainer(built.html);
    parsed.archive["app/index.html"] = new TextEncoder().encode(
      new TextDecoder().decode(parsed.archive["app/index.html"]).replace("Beach", "Bank"),
    );
    const value = await packInline(parsed, HOST);

    const back = await unpackInline(value, HOST, { supply: engine });
    const refusal = await verifyContainer(back).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ContainerError);
    // The registry name for a signature that does not check out over the bytes present.
    expect((refusal as ContainerError).code).toBe("UNVERIFIED_SIGNATURE");
  });

  test("the dictionary id is the digest of the dictionary", async () => {
    const bytes = readFileSync(resolve(repo, "conformance/inline-dictionary.bin"));
    expect((await sha256Hex(new Uint8Array(bytes))).slice(0, 8)).toBe(
      Buffer.from(DICTIONARY_ID).toString("hex"),
    );
  });
});

test.describe("a P-256 key in 33 bytes", () => {
  test("compresses and decompresses to the same key, for keys of both parities", async () => {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < 12; i++) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
      const small = compressPublicKey(spki);
      expect(small.length).toBe(33);
      if (small[0] === 0x02) even++;
      else odd++;
      expect(Buffer.from(decompressPublicKey(small))).toEqual(Buffer.from(spki));
      // And WebCrypto agrees it is a key.
      await crypto.subtle.importKey("spki", decompressPublicKey(small), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }
    // Twelve random keys and both signs seen: the parity bit is being read,
    // not defaulted.
    expect(even).toBeGreaterThan(0);
    expect(odd).toBeGreaterThan(0);
  });

  test("an x with no point on the curve is refused", () => {
    const bogus = new Uint8Array(33);
    bogus[0] = 0x02;
    bogus.fill(0xff, 1);
    expect(() => decompressPublicKey(bogus)).toThrow();
  });
});
