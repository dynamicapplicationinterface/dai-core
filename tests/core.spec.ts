import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { Encoder } from "cbor-x";
import { unzipSync, zipSync } from "fflate";
import {
  buildContainer,
  signedBytes,
  signedViewOf,
  fromBase64,
  payloadFingerprint,
  sha256Hex,
  toBase64,
} from "../src/core.js";
import { CONTAINER_TEMPLATE, RUNTIME_SOURCE } from "../dist/templates.js";
import {
  auditContainer,
  parseContainer,
  resealContainer,
  verifyContainer,
} from "../src/container.js";
import {
  buildLaunchers,
  escapeForBatch,
  escapeForShell,
  macLauncher,
  windowsLauncher,
} from "../src/launchers.js";

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
      // The kit rides in every container, from the engine.
      "app/dai-kit.js",
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

  test("embeds default DAI SVG favicon when no custom favicon is provided", async () => {
    const built = await buildContainer(minimalInput());
    expect(built.html).toContain('<link rel="icon" href="data:image/svg+xml,');
    expect(built.html).toContain('<link rel="apple-touch-icon" href="data:image/svg+xml,');
    expect(built.manifest.favicon).toContain("data:image/svg+xml,");
  });

  test("embeds custom Base64 or SVG favicon when supplied in manifest metadata", async () => {
    const customIcon = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const input = { ...minimalInput(), favicon: customIcon };
    const built = await buildContainer(input);
    expect(built.html).toContain(`<link rel="icon" href="${customIcon}">`);
    expect(built.manifest.favicon).toBe(customIcon);
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

    expect(manifest.signatureAlgorithm).toBe("COSE-ES256");
    expect(built.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    // The private key must not appear anywhere in the artifact.
    expect(built.html).not.toContain(pkcs8.slice(0, 40));
    expect(built.html).not.toContain("PRIVATE KEY");

    /*
     * Verified the way a stranger would: from the RFC and a CBOR library,
     * without calling anything in this repository except to rebuild the
     * payload the signature is detached from.
     *
     * This is the whole reason for adopting COSE. The canonical string it
     * replaced was not broken, but it had one implementation and one reader,
     * so "the signature is correct" meant reading our own code back to
     * ourselves. Here the envelope is taken apart by somebody else's decoder,
     * Sig_structure is rebuilt from RFC 9052 §4.4, and the check is plain
     * WebCrypto.
     */
    const spki = built.html.match(/name="dai-public-key" content="([^"]*)"/)![1]!;
    const publicKey = await crypto.subtle.importKey(
      "spki",
      Buffer.from(spki, "base64"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const cbor = new Encoder({ tagUint8Array: false, useRecords: false, mapsAsObjects: false });
    const envelope = cbor.decode(Buffer.from(manifest.signature!, "base64")) as [
      Uint8Array,
      Map<unknown, unknown>,
      unknown,
      Uint8Array,
    ];

    const [protectedBytes, , payload, signature] = envelope;
    // Detached: the envelope carries no payload of its own.
    expect(payload).toBeNull();

    // alg = ES256 lives in the protected header, so it is covered by the
    // signature and cannot be downgraded by editing the file.
    const header = cbor.decode(Buffer.from(protectedBytes)) as Map<number, number>;
    expect(header.get(1)).toBe(-7);

    const sigStructure = cbor.encode([
      "Signature1",
      Buffer.from(protectedBytes),
      Buffer.alloc(0),
      Buffer.from(signedBytes(signedViewOf(manifest))),
    ]);

    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signature,
      sigStructure,
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

test.describe("desktop launchers", () => {
  test("targets the container beside the launcher, not an absolute path", async () => {
    const { bat, command } = buildLaunchers("notes.dai.html");

    // %~dp0 and $(dirname $0) keep the pair portable: moving the folder, or
    // handing it to someone else, must not break the link.
    expect(bat).toContain('set "DAI_FILE=%~dp0notes.dai.html"');
    expect(command).toContain('dir="$(cd "$(dirname "$0")" && pwd)"');
    expect(command).toContain('file="$dir/notes.dai.html"');

    // Both open a chromeless window rather than a tab.
    expect(bat).toContain('--app="file:///%DAI_FILE%"');
    expect(command).toContain('--app="$url"');
  });

  test("uses CRLF in the batch file", async () => {
    const { bat } = buildLaunchers("notes.dai.html");
    // cmd.exe mis-parses batch files with bare LF endings.
    expect(bat).not.toMatch(/[^\r]\n/);
    expect(bat.startsWith("@echo off\r\n")).toBe(true);
  });

  test("escapes names that would otherwise be interpreted", async () => {
    // A percent starts a variable expansion in batch; undoubled, "100%" would
    // expand to nothing and the launcher would look for the wrong file.
    expect(escapeForBatch("my 100% notes.dai.html")).toBe("my 100%% notes.dai.html");
    expect(windowsLauncher("a%PATH%b.dai.html")).toContain("a%%PATH%%b.dai.html");

    // The name is interpolated into a double-quoted string, so an apostrophe is
    // already literal and must be left alone — escaping it the way a
    // single-quoted context requires would put the escape into the filename.
    expect(escapeForShell("it's mine.dai.html")).toBe("it's mine.dai.html");
    expect(macLauncher("it's mine.dai.html")).toContain(`file="$dir/it's mine.dai.html"`);

    // What does need escaping there: expansion, quoting and the escape itself.
    expect(escapeForShell("a$HOME.dai.html")).toBe("a\\$HOME.dai.html");
    expect(escapeForShell('a"b.dai.html')).toBe('a\\"b.dai.html');
    expect(escapeForShell("a`b.dai.html")).toBe("a\\`b.dai.html");
    expect(escapeForShell("a\\b.dai.html")).toBe("a\\\\b.dai.html");
    expect(macLauncher("$HOME.dai.html")).toContain(`file="$dir/\\$HOME.dai.html"`);

    // Spaces need no escaping in either form, but must survive intact.
    expect(windowsLauncher("my notes.dai.html")).toContain('%~dp0my notes.dai.html"');
    expect(macLauncher("my notes.dai.html")).toContain(`file="$dir/my notes.dai.html"`);
  });

  test("encodes the URL at run time, since the directory is unknown", async () => {
    const { command } = buildLaunchers("notes.dai.html");
    // The launcher cannot know where it will live, so a directory containing a
    // space or a '#' has to be encoded on the machine that runs it.
    expect(command).toContain("s/%/%25/g");
    expect(command).toContain("s/ /%20/g");
    expect(command).toContain("s/#/%23/g");
    // The '%' rule must come first or it re-encodes its own output.
    expect(command.indexOf("s/%/%25/g")).toBeLessThan(command.indexOf("s/ /%20/g"));
  });

  test("checks the container exists and falls back to a plain open", async () => {
    const { bat, command } = buildLaunchers("notes.dai.html");

    expect(bat).toContain('if not exist "%DAI_FILE%"');
    expect(command).toContain('if [ ! -f "$file" ]; then');

    // Missing Chromium means a windowed open, never a silent failure.
    expect(bat.trimEnd().endsWith('start "" "%DAI_FILE%"')).toBe(true);
    expect(command.trimEnd().endsWith('open "$file"')).toBe(true);
  });
});

test.describe("mobile shell", () => {
  test("ships the tags an iOS home-screen launch needs", async () => {
    const built = await buildContainer({ ...minimalInput(), appName: "Field Notes" });

    expect(built.html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(built.html).toContain(
      'name="apple-mobile-web-app-status-bar-style" content="black-translucent"',
    );
    expect(built.html).toContain("viewport-fit=cover");
    // The home-screen title follows the document, not a hardcoded string.
    expect(built.html).toContain('name="apple-mobile-web-app-title" content="Field Notes"');
  });

  test("keeps the shell control clear of the safe area", async () => {
    const built = await buildContainer(minimalInput());
    // Without insets the App Mode button sits under the notch on a phone.
    expect(built.html).toContain("env(safe-area-inset-top)");
    expect(built.html).toContain("env(safe-area-inset-right)");
  });
});

test.describe("head integrity", () => {
  /**
   * These assert the *parsed* DOM, not the source text. The favicon bug that
   * motivated them left the markup looking correct in source order while the
   * parser closed <head> early, moving the CSP into <body> where a meta policy
   * is ignored outright. A string search for the meta tag passed throughout.
   */
  async function parsedHead(page: import("@playwright/test").Page, html: string) {
    return page.evaluate((source) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
      const integrity = doc.querySelector('meta[name="dai-integrity"]');
      const icon = doc.querySelector('link[rel="icon"]');
      return {
        cspInHead: !!csp && doc.head.contains(csp),
        integrityInHead: !!integrity && doc.head.contains(integrity),
        iconInHead: !!icon && doc.head.contains(icon),
        // Anything the parser had to relocate lands here.
        strayInBody: [...doc.body.children].some((el) =>
          ["META", "LINK", "TITLE"].includes(el.tagName),
        ),
        cspText: csp?.getAttribute("content") ?? "",
      };
    }, html);
  }

  test("the default favicon does not break out of its attribute", async ({ page }) => {
    await page.goto("about:blank");
    const built = await buildContainer(minimalInput());
    const head = await parsedHead(page, built.html);

    expect(head.iconInHead).toBe(true);
    expect(head.cspInHead).toBe(true);
    expect(head.integrityInHead).toBe(true);
    expect(head.strayInBody).toBe(false);
    // The air gap is only real if the policy is actually parsed.
    expect(head.cspText).toContain("connect-src 'none'");
  });

  test("a caller-supplied favicon cannot relocate the CSP either", async ({ page }) => {
    await page.goto("about:blank");

    // Raw quotes and a closing tag: the shape that broke the parser before.
    const hostile =
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#000"/></svg>';
    const built = await buildContainer({ ...minimalInput(), favicon: hostile });
    const head = await parsedHead(page, built.html);

    expect(head.cspInHead).toBe(true);
    expect(head.strayInBody).toBe(false);
    expect(head.cspText).toContain("connect-src 'none'");
  });
});

test.describe("verifyContainer", () => {
  const CONTAINER = resolve(here, "fixture/fixture.dai.html");

  function repack(html: string, archive: Record<string, Uint8Array>): string {
    return html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );
  }

  function archiveOf(html: string): Record<string, Uint8Array> {
    return unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
  }

  test("accepts an intact, signed container", async () => {
    const verified = await verifyContainer(readFileSync(CONTAINER, "utf8"));

    expect(verified.signature).toBe("valid");
    expect(verified.integrityPolicy).toBe("required");
    expect(verified.manifest.documentUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    // The document is returned verbatim; hosts mount this, never a rebuild.
    expect(verified.html).toBe(readFileSync(CONTAINER, "utf8"));
  });

  test("rejects a mismatched digest", async () => {
    const html = readFileSync(CONTAINER, "utf8");
    const archive = archiveOf(html);
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>swapped");

    await expect(verifyContainer(repack(html, archive))).rejects.toThrow(/has been modified/);
  });

  test("rejects an entry the manifest never listed", async () => {
    // The reverse direction. Without it, content could simply be appended.
    const html = readFileSync(CONTAINER, "utf8");
    const archive = archiveOf(html);
    archive["app/smuggled.js"] = new TextEncoder().encode("console.log('extra')");

    await expect(verifyContainer(repack(html, archive))).rejects.toThrow(
      /not listed in the manifest/,
    );
  });

  test("rejects a rewritten bootloader even when every digest matches", async () => {
    // The check a container cannot make about itself: its own verification runs
    // inside the shell that was rewritten.
    const html = readFileSync(CONTAINER, "utf8").replace(
      'content="required"',
      'content="advisory"',
    );

    await expect(verifyContainer(html)).rejects.toThrow(/does not match the sealed copy/);
  });

  test("rejects a payload re-sealed by someone without the private key", async () => {
    // The attacker recomputes every digest correctly, defeating integrity
    // entirely. Only the signature catches this.
    const html = readFileSync(CONTAINER, "utf8");
    const archive = archiveOf(html);
    const manifest = JSON.parse(
      Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"),
    );

    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>forged");
    const digest = createHash("sha256")
      .update(Buffer.from(archive["app/index.html"]))
      .digest("hex");
    manifest.hashes["app/index.html"] = digest;
    manifest.signedEntries["app/index.html"] = digest;
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    await expect(verifyContainer(repack(html, archive))).rejects.toThrow(/not authentic/);
  });

  test("rejects a file that is not a container", async () => {
    await expect(verifyContainer("<!doctype html><body>just a page")).rejects.toThrow(
      /no DAI payload/,
    );
  });

  test("resealing keeps the container verifiable and the signature valid", async () => {
    const verified = await verifyContainer(readFileSync(CONTAINER, "utf8"));
    const resealed = await resealContainer(verified, new TextEncoder().encode("new database"));

    // The database is outside the signed set, so a save must not invalidate the
    // publisher's claim — otherwise the first save would destroy it forever.
    const reverified = await verifyContainer(resealed.html);
    expect(reverified.signature).toBe("valid");
    expect(new TextDecoder().decode(reverified.database)).toBe("new database");
    expect(reverified.manifest.documentUuid).toBe(verified.manifest.documentUuid);
  });
});

test.describe("payload fingerprint", () => {
  const FIXTURE = resolve(here, "fixture/fixture.dai.html");

  test("two verifiers of the same file agree", async () => {
    // The point of the value: a host and a container each derive it from what
    // they verified, and compare one string instead of a table of digests.
    const a = await verifyContainer(readFileSync(FIXTURE, "utf8"));
    const b = await verifyContainer(readFileSync(FIXTURE, "utf8"));

    expect(await payloadFingerprint(a.manifest.documentUuid, a.manifest.hashes)).toBe(
      await payloadFingerprint(b.manifest.documentUuid, b.manifest.hashes),
    );
  });

  test("a different payload produces a different value", async () => {
    const original = await verifyContainer(readFileSync(FIXTURE, "utf8"));
    const changed = await resealContainer(original, new TextEncoder().encode("other db"));

    expect(await payloadFingerprint(changed.manifest.documentUuid, changed.manifest.hashes)).not.toBe(
      await payloadFingerprint(original.manifest.documentUuid, original.manifest.hashes),
    );
  });

  test("it does not depend on entry order", async () => {
    // Two hosts may hold the same archive in different insertion orders. A
    // value that changed with order would report drift where there is none.
    const { manifest } = await verifyContainer(readFileSync(FIXTURE, "utf8"));
    const reversed = Object.fromEntries(Object.entries(manifest.hashes).reverse());

    expect(await payloadFingerprint(manifest.documentUuid, reversed)).toBe(
      await payloadFingerprint(manifest.documentUuid, manifest.hashes),
    );
  });

  test("it is bound to the document, not only its contents", async () => {
    // Two documents could in principle carry identical entries; they are still
    // different documents, and a shared fingerprint would hide a swap.
    const { manifest } = await verifyContainer(readFileSync(FIXTURE, "utf8"));

    expect(await payloadFingerprint("11111111-2222-4333-8444-555555555555", manifest.hashes)).not.toBe(
      await payloadFingerprint(manifest.documentUuid, manifest.hashes),
    );
  });
});

test.describe("expiry", () => {
  const HOUR = 3600;
  const now = () => Math.floor(Date.now() / 1000);

  async function signedInput() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    );
    return { ...minimalInput(), signingKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----` };
  }

  test("a container with no expiry runs forever", async () => {
    // The default, and the promise the format makes about archived documents.
    const built = await buildContainer(minimalInput());
    expect(built.manifest.validUntil).toBeUndefined();
    await expect(verifyContainer(built.html)).resolves.toBeTruthy();
  });

  test("an unexpired container runs", async () => {
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() + HOUR });
    const verified = await verifyContainer(built.html);
    expect(verified.signature).toBe("valid");
    expect(verified.manifest.validUntil).toBeGreaterThan(now());
  });

  test("an expired container is refused", async () => {
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() - HOUR });
    await expect(verifyContainer(built.html)).rejects.toThrow(/expired/i);
  });

  test("the expiry cannot be extended without the signing key", async () => {
    // The point of signing it. No other manifest field is covered by the
    // signature, so an expiry left as a plain field could be edited away.
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() - HOUR });

    const archive = unzipSync(
      Buffer.from(built.html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));
    manifest.validUntil = now() + HOUR * 24;
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    const tampered = built.html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    // Not "expired" — the signature no longer matches, which is the stronger
    // complaint and the one that survives an attacker who moves the date.
    await expect(verifyContainer(tampered)).rejects.toThrow(/not authentic/i);
  });

  test("deleting the expiry breaks the signature too", async () => {
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() - HOUR });

    const archive = unzipSync(
      Buffer.from(built.html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    const manifest = JSON.parse(Buffer.from(archive["runtime/manifest.json"]!).toString("utf8"));
    delete manifest.validUntil;
    archive["runtime/manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    const tampered = built.html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    await expect(verifyContainer(tampered)).rejects.toThrow(/not authentic/i);
  });

  test("a container with no expiry carries no expiry in its signed bytes", async () => {
    // Absent rather than null or zero: a perpetual document should not be
    // describing an expiry it does not have, and a reader should not have to
    // know which falsy value means "forever".
    const built = await buildContainer(await signedInput());
    const verified = await verifyContainer(built.html);

    expect(verified.signature).toBe("valid");
    // Absent from the signed bytes entirely, not present and empty: a reader
    // should not have to know which falsy value means "forever".
    const fields = new Encoder({ mapsAsObjects: false }).decode(
      Buffer.from(signedBytes(signedViewOf(built.manifest))),
    ) as Map<string, unknown>;
    expect(fields.has("validUntil")).toBe(false);
  });
});

test.describe("auditContainer", () => {
  const FIXTURE = resolve(here, "fixture/fixture.dai.html");

  function repack(html: string, archive: Record<string, Uint8Array>): string {
    return html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );
  }

  function archiveOf(html: string): Record<string, Uint8Array> {
    return unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
  }

  test("reports every entry, not just the first failure", async () => {
    // The reason this exists: a first-failure exception cannot tell a tool
    // which entries are fine, and a playground needs to show all of them.
    const html = readFileSync(FIXTURE, "utf8");
    const archive = archiveOf(html);
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>changed");
    archive["app/smuggled.js"] = new TextEncoder().encode("console.log('extra')");

    const report = await auditContainer(parseContainer(repack(html, archive)));

    expect(report.ok).toBe(false);
    const byName = Object.fromEntries(report.entries.map((e) => [e.name, e.status]));
    expect(byName["app/index.html"]).toBe("mismatch");
    expect(byName["app/smuggled.js"]).toBe("unlisted");
    // The untouched entries are still reported as passing.
    expect(byName["runtime/sqlite3.wasm"]).toBe("ok");
    expect(report.entries.filter((e) => e.status === "ok").length).toBeGreaterThan(1);
  });

  test("reports a missing entry the manifest still lists", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const archive = archiveOf(html);
    delete archive["app/index.html"];

    const report = await auditContainer(parseContainer(repack(html, archive)));
    expect(report.entries.find((e) => e.name === "app/index.html")?.status).toBe("missing");
    expect(report.ok).toBe(false);
  });

  test("passes a sound container and names the publisher", async () => {
    const report = await auditContainer(parseContainer(readFileSync(FIXTURE, "utf8")));

    expect(report.ok).toBe(true);
    expect(report.shell.status).toBe("ok");
    expect(report.signature.status).toBe("valid");
    expect(report.signature.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(report.expiry.status).toBe("none");
    expect(report.entries.every((e) => e.status === "ok")).toBe(true);
  });

  test("separates a rewritten shell from a broken payload", async () => {
    // Every digest matches; only the outer document changed. A tool should be
    // able to say which of the two happened.
    const html = readFileSync(FIXTURE, "utf8").replace(
      'content="required"',
      'content="advisory"',
    );
    const report = await auditContainer(parseContainer(html));

    expect(report.entries.every((e) => e.status === "ok")).toBe(true);
    expect(report.shell.status).toBe("mismatch");
    expect(report.ok).toBe(false);
  });

  test("never throws where verifyContainer would", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const archive = archiveOf(html);
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><body>broken");
    const tampered = repack(html, archive);

    await expect(verifyContainer(tampered)).rejects.toThrow();
    await expect(auditContainer(parseContainer(tampered))).resolves.toBeTruthy();
  });
});

test.describe("parsing bytes and malformed input", () => {
  const FIXTURE = resolve(here, "fixture/fixture.dai.html");

  test("accepts a container as bytes as well as text", async () => {
    // A host reading from disk or from a native bridge has bytes, not a string.
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const fromBytes = await verifyContainer(bytes);
    const fromText = await verifyContainer(readFileSync(FIXTURE, "utf8"));

    expect(fromBytes.manifest.documentUuid).toBe(fromText.manifest.documentUuid);
    expect(fromBytes.signature).toBe("valid");
  });

  test("rejects a corrupted payload rather than guessing", async () => {
    // The PAYLOAD_UNREADABLE case: base64 that is not a zip.
    const html = readFileSync(FIXTURE, "utf8").replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) => open + "bm90IGEgemlwIGF0IGFsbA==" + close,
    );

    await expect(async () => parseContainer(html)).rejects.toThrow(/could not be read/i);
  });

  test("rejects a manifest missing the fields verification depends on", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const archive = unzipSync(
      Buffer.from(html.match(/id="dai-payload">([\s\S]*?)<\/script>/)![1]!.trim(), "base64"),
    );
    // No algorithm, no hashes: structurally a manifest, semantically useless.
    archive["runtime/manifest.json"] = new TextEncoder().encode(
      JSON.stringify({ manifestVersion: 1, documentUuid: "x" }),
    );
    const stripped = html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_m, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );

    const report = await auditContainer(parseContainer(stripped));
    // Reported as unsupported rather than crashing on the absent hashes table.
    // The version gate (spec §9.1) answers first, since a version 1 manifest
    // is one this reader does not read whatever else it lacks.
    expect(report.unavailable).toMatch(/older compiler|algorithm/i);
    expect(report.ok).toBe(false);
    await expect(verifyContainer(stripped)).rejects.toMatchObject({ code: "UNSUPPORTED_MANIFEST_VERSION" });
  });
});

test.describe("expiry boundaries", () => {
  const now = () => Math.floor(Date.now() / 1000);

  async function signedInput() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    );
    return {
      ...minimalInput(),
      signingKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    };
  }

  test("a second before expiry still runs", async () => {
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() + 1 });
    const report = await auditContainer(parseContainer(built.html));
    expect(report.expiry.status).toBe("current");
    expect(report.ok).toBe(true);
  });

  test("a second after expiry does not", async () => {
    const built = await buildContainer({ ...(await signedInput()), validUntil: now() - 1 });
    const report = await auditContainer(parseContainer(built.html));
    expect(report.expiry.status).toBe("expired");
    expect(report.ok).toBe(false);
    // Everything else about the container is still sound, and says so — the
    // failure is a policy one, not evidence of tampering.
    expect(report.entries.every((e) => e.status === "ok")).toBe(true);
    expect(report.signature.status).toBe("valid");
  });

  test("validUntil is an instant, not the whole second it names", async () => {
    // "Expires at T" is ambiguous, so the semantics are pinned here: the check
    // is Date.now() > validUntil * 1000, which makes T an instant. A container
    // stamped with the current second is already past it by however many
    // milliseconds have elapsed within that second — it does not stay live
    // until the second ends.
    const nextSecond = Math.ceil(Date.now() / 1000);
    const live = await buildContainer({ ...(await signedInput()), validUntil: nextSecond });
    expect((await auditContainer(parseContainer(live.html))).expiry.status).toBe("current");

    const past = await buildContainer({
      ...(await signedInput()),
      validUntil: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await auditContainer(parseContainer(past.html))).expiry.status).toBe("expired");
  });

  test("a far-future expiry is not treated as an error", async () => {
    // Beyond 2038, which is where a 32-bit seconds field would wrap.
    const built = await buildContainer({
      ...(await signedInput()),
      validUntil: 2_600_000_000,
    });
    const report = await auditContainer(parseContainer(built.html));
    expect(report.expiry.status).toBe("current");
    expect(report.expiry.validUntil).toBe(2_600_000_000);
    expect(report.ok).toBe(true);
  });
});

test.describe("reproducibility limits", () => {
  test("an unsigned container is byte-identical across builds", async () => {
    const fixed = {
      ...minimalInput(),
      documentUuid: "22222222-3333-4444-8555-666666666666",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    };
    expect((await buildContainer(fixed)).html).toBe((await buildContainer(fixed)).html);
  });

  test("a signed container is not, and its payload fingerprint still is", async () => {
    // ECDSA draws a fresh nonce per signature, so identical inputs produce
    // different signatures — which changes the manifest, the payload and the
    // file. Byte comparison is the wrong test for a signed cartridge; this
    // records that so nobody builds a verification tool around it.
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    );
    const fixed = {
      ...minimalInput(),
      documentUuid: "33333333-4444-4555-8666-777777777777",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      signingKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    };

    const first = await buildContainer(fixed);
    const second = await buildContainer(fixed);

    expect(second.html).not.toBe(first.html);
    expect(second.manifest.signature).not.toBe(first.manifest.signature);

    // What a third party should compare instead: stable, and covers everything
    // the signature attests to.
    expect(await payloadFingerprint(second.documentUuid, second.manifest.hashes)).toBe(
      await payloadFingerprint(first.documentUuid, first.manifest.hashes),
    );
  });
});


test.describe("what the signature covers", () => {
  /**
   * The signature used to cover the identity, the entry digests and the expiry,
   * and nothing else — so every descriptive field could be edited while it went
   * on verifying. A container could be renamed, given somebody else's icon, and
   * passed on still claiming to be signed.
   *
   * Each field below is re-checked by editing the manifest inside a built
   * container and confirming the signature no longer holds.
   */
  async function signedBuild() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    );
    return buildContainer({
      ...minimalInput(),
      signingKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
    });
  }

  async function tamperedManifest(
    edit: (manifest: Record<string, unknown>) => void,
  ): Promise<string> {
    const built = await signedBuild();
    const archive = unzipSync(built.zipped);

    const manifest = JSON.parse(new TextDecoder().decode(archive["runtime/manifest.json"]!));
    edit(manifest);
    archive["runtime/manifest.json"] = new TextEncoder().encode(
      JSON.stringify(manifest, null, 2) + "\n",
    );

    return built.html.replace(
      /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
      (_whole, open: string, close: string) =>
        open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
    );
  }

  const fields: Record<string, (manifest: Record<string, unknown>) => void> = {
    // The name a host shows in its title bar and its window list.
    appName: (manifest) => (manifest.appName = "Payroll Portal"),
    // The icon beside it, which is most of what anybody actually recognises.
    favicon: (manifest) => (manifest.favicon = "data:image/svg+xml,%3Csvg/%3E"),
    // When it claims to have been made.
    createdAt: (manifest) => (manifest.createdAt = "2001-01-01T00:00:00.000Z"),
    // The fingerprint a host pins on first use and shows on every later open.
    publicKeyFingerprint: (manifest) => (manifest.publicKeyFingerprint = "0".repeat(16)),
    // To a version this reader knows: an unknown one is refused by name before
    // the signature is looked at (§9.1), which is a different test.
    manifestVersion: (manifest) => (manifest.manifestVersion = manifest.manifestVersion === 2 ? 3 : 2),
    integrityPolicy: (manifest) => (manifest.integrityPolicy = "advisory"),
  };

  for (const [field, edit] of Object.entries(fields)) {
    test(`editing ${field} invalidates the signature`, async () => {
      const tampered = await tamperedManifest(edit);
      await expect(verifyContainer(tampered)).rejects.toThrow(/not authentic|modified/i);
    });
  }
});

/**
 * The same inputs make the same file.
 *
 * `roadmap.md` has claimed since the beginning that an unsigned container
 * built twice from identical inputs is byte-identical, and it was not: a zip
 * records a modification time per entry and fflate wrote the clock, so two
 * builds differed by a few bytes with nothing to show for it. Nobody noticed
 * because nobody compared two builds a second apart.
 *
 * It matters beyond tidiness. A thin container is re-fattened by putting the
 * engine back and rebuilding the payload, and "the same file as the fat build"
 * is only a checkable claim if building twice is the same file at all.
 */
test.describe("building twice", () => {
  const twice = async (): Promise<[string, string]> => {
    const fixed = {
      documentUuid: "11111111-2222-3333-4444-555555555555",
      now: () => new Date(0),
    };
    const files = () => ({
      "index.html": new TextEncoder().encode("<!doctype html><p>hi"),
      "app.js": new TextEncoder().encode("console.log(1)"),
    });
    const shell = { template: CONTAINER_TEMPLATE, runtime: RUNTIME_SOURCE };
    const first = await buildContainer({ files: files(), appName: "Twice", ...shell, ...fixed });
    // Across a clock second, which is what used to change the bytes. A DOS
    // timestamp has two-second granularity, so a shorter wait proved nothing.
    await new Promise((wait) => setTimeout(wait, 2200));
    const second = await buildContainer({ files: files(), appName: "Twice", ...shell, ...fixed });
    return [first.html, second.html];
  };

  test("an unsigned container built twice from identical inputs is the same file", async () => {
    test.slow();
    const [first, second] = await twice();
    expect(second).toBe(first);
  });
});
