#!/usr/bin/env node
/**
 * Builds the matched pair the website uses to demonstrate tamper detection.
 *
 * Both files come from one compile, so the only difference between them is the
 * tampering. A pair built from two separate compiles would differ in timestamps
 * and identifiers as well, and a sceptic would be right to ask which difference
 * the check actually caught.
 *
 * The tampering is deliberately the interesting kind: one entry is swapped and
 * every digest around it left alone. That is what an attacker who edits a file
 * produces, and it is caught by the manifest. The harder case — an attacker who
 * recomputes the digests too — is caught only by the signature, which is why
 * both files are signed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { buildContainer } from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "website/public");

const template = readFileSync(resolve(root, "dist/template.html"), "utf8");
const runtime = readFileSync(resolve(root, "dist/dai-runtime.js"), "utf8");

// A fixed identity and clock, so everything except the signature is stable
// between builds.
const DOCUMENT_UUID = "5a1e0b7c-9d2f-4a13-8e6b-71c4d90fa2e3";
const BUILT_AT = new Date("2026-01-01T00:00:00.000Z");

/**
 * A throwaway key, published on purpose.
 *
 * It exists so the publisher fingerprint stays stable in the documentation. A
 * freshly generated key would change it on every build.
 *
 * The files still differ byte for byte between runs, and cannot be made not to:
 * ECDSA draws a fresh nonce for every signature, so signing the same bytes twice
 * produces two different signatures. Only unsigned containers are reproducible.
 *
 * Anyone can sign anything with it, which is the point of a demonstration key
 * and the reason it must never sign anything real. It attests to nothing.
 */
const DEMO_KEY = {
  kty: "EC",
  crv: "P-256",
  d: "E9F7dQoKmsOYMSpGdnVsZE8LGcc5H4jkwhXaR7PhpT0",
  x: "SJwk5VtJ34cDa7wTIAWmPYDq8HDin7Jzntwkzczsv4s",
  y: "1puN-lDXyW3ZFWUA5jHiLqAWWRQmGc9cBgzOj7nTMhA",
};

const privateKey = await crypto.subtle.importKey(
  "jwk",
  { ...DEMO_KEY, ext: true },
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign"],
);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");

const indexHtml = `<!doctype html>
<html lang="en">
<head><meta charset="UTF-8"><title>Signed Sample</title>
<style>
  body { font: 16px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 40px;
         background: #0f172a; color: #e2e8f0; text-align: center; }
  .card { max-width: 30rem; margin: 0 auto; padding: 32px; background: #1e293b;
          border: 1px solid #334155; border-radius: 12px; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 8px 0; color: #94a3b8; }
  strong { color: #4ade80; }
</style>
</head>
<body>
  <div class="card">
    <h1>This cartridge is intact</h1>
    <p>Every entry matched the digest recorded when it was sealed, and the
       signature matched the publisher key it carries.</p>
    <p id="proof">checking…</p>
  </div>
  <script src="./app.js"></script>
</body>
</html>`;

const appJs = `// Reports what the container knows about itself, so the page is evidence
// rather than a claim printed in HTML.
const proof = document.getElementById("proof");
const dai = window.dai;
proof.innerHTML = dai
  ? "Document <strong>" + dai.documentUuid.slice(0, 8) + "</strong>, signature <strong>" +
    dai.signature + "</strong>."
  : "Opened without a DAI runtime.";
`;

const built = await buildContainer({
  files: {
    "index.html": new TextEncoder().encode(indexHtml),
    "app.js": new TextEncoder().encode(appJs),
  },
  template,
  runtime,
  appName: "Signed Sample",
  signingKey: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`,
  documentUuid: DOCUMENT_UUID,
  now: () => BUILT_AT,
});

writeFileSync(resolve(out, "sample-intact.dai"), built.html, "utf8");

// Now break it, from the very same bytes.
const payload = built.html.match(/id="dai-payload">([\s\S]*?)<\/script>/)[1].trim();
const archive = unzipSync(Buffer.from(payload, "base64"));

archive["app/index.html"] = new TextEncoder().encode(
  indexHtml
    .replace("This cartridge is intact", "This cartridge was altered")
    .replace(
      "Every entry matched the digest recorded when it was sealed, and the\n       signature matched the publisher key it carries.",
      "One entry was replaced after sealing. Nothing else was touched.",
    ),
);

const tampered = built.html.replace(
  /(<script[^>]*id="dai-payload"[^>]*>)[\s\S]*?(<\/script>)/,
  (_m, open, close) => open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
);

writeFileSync(resolve(out, "sample-tampered.dai"), tampered, "utf8");

// The site compiles a cartridge live on the walkthrough page, so it needs the
// shell, the bootloader and the SQLite engine as static assets. Copied here
// rather than imported from dist/, which would make the site's build depend on
// the core's having run first — the coupling the standalone layout avoids.
const runtimeDir = resolve(out, "runtime");
mkdirSync(runtimeDir, { recursive: true });

const assets = {
  "template.html": resolve(root, "dist/template.html"),
  "dai-runtime.js": resolve(root, "dist/dai-runtime.js"),
  "sqlite3.wasm": resolve(root, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm"),
  "sqlite3.mjs": resolve(root, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs"),
};
for (const [name, from] of Object.entries(assets)) {
  writeFileSync(resolve(runtimeDir, name), readFileSync(from));
}

console.log("Wrote the demonstration pair to website/public:");
console.log("  sample-intact.dai    verifies");
console.log("  sample-tampered.dai  one entry replaced, every other byte identical");
console.log(`  document ${DOCUMENT_UUID}`);
console.log(`  publisher ${built.publicKeyFingerprint}`);
console.log("Copied the shell, bootloader and SQLite engine to website/public/runtime.");
