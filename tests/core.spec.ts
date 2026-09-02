import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import {
  buildContainer,
  canonicalPayload,
  fromBase64,
  sha256Hex,
  toBase64,
} from "../src/core.js";
import { CONTAINER_TEMPLATE, RUNTIME_SOURCE } from "../dist/templates.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "../dist");

/**
 * The template and runtime are build outputs, read once here purely to supply
 * the core with strings. Everything the core itself does is in memory: these
 * tests never hand it a path, and it never opens one.
 */
const TEMPLATE = readFileSync(resolve(dist, "template.html"), "utf8");
const RUNTIME = readFileSync(resolve(dist, "dai-runtime.js"), "utf8");

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function minimalInput() {
  return {
    files: {
      "index.html": bytes("<!doctype html><body><script src='./app.js'></script>"),
      "app.js": bytes("console.log('hi')"),
    },
    template: TEMPLATE,
    runtime: RUNTIME,
    appName: "in-memory",
  };
}

function payloadOf(html: string): Record<string, Uint8Array> {
  const base64 = html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim();
  return unzipSync(Buffer.from(base64, "base64"));
}

test.describe("buildContainer", () => {
  test("compiles a container entirely from in-memory bytes", async () => {
    const built = await buildContainer(minimalInput());

    expect(built.html).toContain("<!DOCTYPE html>");
    expect(built.html).not.toContain("<!--DAI_RUNTIME-->");
    expect(built.html).toContain("<title>in-memory</title>");

    // The payload tag must hold base64, not the placeholder. The placeholder
    // literal still appears elsewhere in the document, inside the bootloader,
    // which needs it to reseal the container on save — which is exactly why the
    // substitution is anchored to the tag rather than done by plain replace.
    expect(built.html).toMatch(/id="dai-payload">[A-Za-z0-9+/=]{100,}<\/script>/);
    expect(built.html).toContain("<!--DAI_PAYLOAD-->");

    const archive = payloadOf(built.html);
    expect(Object.keys(archive).sort()).toEqual([
      "app/app.js",
      "app/index.html",
      "document.sqlite",
      "runtime/container.html",
      "runtime/manifest.json",
    ]);

    // Unsigned by default, but always sealed and always identified.
    expect(built.manifest.signature).toBeUndefined();
    expect(built.documentUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    expect(built.manifest.integrityPolicy).toBe("required");
  });

  test("seals every entry except the manifest itself", async () => {
    const built = await buildContainer(minimalInput());
    const archive = payloadOf(built.html);

    const covered = Object.keys(archive)
      .filter((name) => name !== "runtime/manifest.json")
      .sort();
    expect(Object.keys(built.manifest.hashes).sort()).toEqual(covered);

    for (const name of covered) {
      expect(built.manifest.hashes[name], name).toBe(await sha256Hex(archive[name]!));
    }
  });

  test("carries the engine and glue when given them", async () => {
    const built = await buildContainer({
      ...minimalInput(),
      sqlite: bytes("seed"),
      wasm: bytes("fake-engine"),
      glue: bytes("export default () => {}"),
    });

    const archive = payloadOf(built.html);
    expect(new TextDecoder().decode(archive["runtime/sqlite3.wasm"]!)).toBe("fake-engine");
    expect(new TextDecoder().decode(archive["document.sqlite"]!)).toBe("seed");
    expect(archive["runtime/sqlite3.mjs"]).toBeTruthy();
  });

  test("drops the glue when there is no engine to drive", async () => {
    const built = await buildContainer({
      ...minimalInput(),
      glue: bytes("export default () => {}"),
    });

    expect(payloadOf(built.html)["runtime/sqlite3.mjs"]).toBeUndefined();
  });

  test("signs with a caller-supplied key and never embeds it", async () => {
    // Generated in-process: the core is handed PEM text, not a path.
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = Buffer.from(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ).toString("base64");
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;

    const built = await buildContainer({ ...minimalInput(), signingKey: pem });
    const manifest = built.manifest;

    expect(manifest.signatureAlgorithm).toBe("ECDSA-P256-SHA256");
    expect(built.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    // The private key must not appear anywhere in the artifact.
    expect(built.html).not.toContain(pkcs8.slice(0, 40));
    expect(built.html).not.toContain("PRIVATE KEY");

    // The signature must verify against the public half, over the same bytes
    // the bootloader will reconstruct.
    const spki = built.html.match(/name="dai-public-key" content="([^"]*)"/)![1]!;
    const publicKey = await crypto.subtle.importKey(
      "spki",
      Buffer.from(spki, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(manifest.signature!, "base64"),
      new TextEncoder().encode(
        canonicalPayload(built.documentUuid, manifest.signedEntries!),
      ),
    );
    expect(ok).toBe(true);

    // The mutable database stays outside the signed set.
    expect(manifest.signedEntries!["document.sqlite"]).toBeUndefined();
  });

  test("is reproducible when identity and clock are supplied", async () => {
    const fixed = {
      ...minimalInput(),
      documentUuid: "11111111-2222-4333-8444-555555555555",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };

    const first = await buildContainer(fixed);
    const second = await buildContainer(fixed);

    // Nothing may vary between builds of identical inputs: a container that
    // differs run to run cannot be diffed, cached or independently rebuilt.
    expect(second.html).toBe(first.html);
  });

  test("emits an advisory policy when verification is turned off", async () => {
    const built = await buildContainer({ ...minimalInput(), verifyIntegrity: false });
    expect(built.html).toContain('content="advisory"');
    expect(built.manifest.integrityPolicy).toBe("advisory");
  });

  test("rejects inputs it cannot compile", async () => {
    await expect(
      buildContainer({ ...minimalInput(), files: {} }),
    ).rejects.toThrow(/no application files/);

    await expect(
      buildContainer({ ...minimalInput(), template: "<html>no placeholders</html>" }),
    ).rejects.toThrow(/DAI_RUNTIME/);

    await expect(
      buildContainer({ ...minimalInput(), template: TEMPLATE.replace("<!--DAI_PAYLOAD-->", "") }),
    ).rejects.toThrow(/DAI_PAYLOAD/);
  });
});

test.describe("base64 helper", () => {
  test("round-trips every byte value and every padding case", async () => {
    // All 256 byte values, so no sign-extension or high-bit bug can hide.
    const all = new Uint8Array(256).map((_, i) => i);
    expect(Array.from(fromBase64(toBase64(all)))).toEqual(Array.from(all));

    // Lengths 0..8 cover both padding remainders repeatedly.
    for (let length = 0; length <= 8; length++) {
      const sample = all.slice(0, length);
      expect(Array.from(fromBase64(toBase64(sample))), `length ${length}`).toEqual(
        Array.from(sample),
      );
    }
  });

  test("agrees with the platform implementation", async () => {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([0]),
      new Uint8Array([0, 255]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([251, 255, 191, 254]),
      new TextEncoder().encode("the quick brown fox — ünïcödé"),
      new Uint8Array(5000).map((_, i) => (i * 31) % 256),
    ];

    for (const bytes of cases) {
      const ours = toBase64(bytes);
      expect(ours).toBe(Buffer.from(bytes).toString("base64"));
      expect(Buffer.from(fromBase64(ours))).toEqual(Buffer.from(bytes));
    }
  });

  test("tolerates whitespace and missing padding when decoding", async () => {
    const encoded = toBase64(new TextEncoder().encode("hello world"));
    const mangled = encoded.replace(/=+$/, "").replace(/(.{4})/g, "$1\n  ");
    expect(new TextDecoder().decode(fromBase64(mangled))).toBe("hello world");
  });

  test("does not depend on atob or btoa", async () => {
    // Prove it rather than assert it in prose: hide the globals and rebuild a
    // real container through the core.
    const globals = globalThis as unknown as Record<string, unknown>;
    const savedAtob = globals.atob;
    const savedBtoa = globals.btoa;
    globals.atob = undefined;
    globals.btoa = undefined;

    try {
      const built = await buildContainer(minimalInput());
      expect(built.html).toMatch(/id="dai-payload">[A-Za-z0-9+/=]{100,}/);
    } finally {
      globals.atob = savedAtob;
      globals.btoa = savedBtoa;
    }
  });
});

test.describe("generated template module", () => {
  test("compiles a container from the published constants alone", async () => {
    // The path a browser-hosted compiler takes: no disk, no fetch.
    const built = await buildContainer({
      files: { "index.html": bytes("<!doctype html><body>studio") },
      template: CONTAINER_TEMPLATE,
      runtime: RUNTIME_SOURCE,
      appName: "from-constants",
    });

    expect(built.html).toContain("<title>from-constants</title>");
    expect(built.html).toContain('content="required"');
    expect(payloadOf(built.html)["app/index.html"]).toBeTruthy();

    // The constants must match what the plugin writes beside itself, or the
    // Studio would emit containers that differ from terminal builds.
    expect(CONTAINER_TEMPLATE).toBe(TEMPLATE);
    expect(RUNTIME_SOURCE).toBe(RUNTIME);
  });
});
