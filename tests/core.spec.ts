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
