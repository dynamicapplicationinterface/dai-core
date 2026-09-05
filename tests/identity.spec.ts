import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { verifyContainer } from "../src/container.js";
import { verifyIdentity } from "../src/identity.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = resolve(repo, "conformance", "signing-key.pem");

const sigstore = await import(pathToFileURL(resolve(repo, "scripts/lib/sigstore-test.mjs")).href) as {
  testSigstore: (name?: string) => Promise<{
    root: { name: string; fulcioRoots: string[]; rekorKeys: string[] };
    issue: (o: Record<string, unknown>) => Promise<unknown>;
  }>;
};

async function signedBuild() {
  const source = mkdtempSync(join(tmpdir(), "dai-id-"));
  writeFileSync(join(source, "index.html"), '<!doctype html><meta charset="utf-8"><p>id</p>', "utf8");
  const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Identified", signingKey: KEY, manifestVersion: 3 });
  const verified = await verifyContainer(built.html);
  return { built, key: verified.publicKey!, signature: built.manifest.signature! };
}

/**
 * Identity, checked offline (spec §9.5).
 *
 * The publisher was online when the bundle was made; the reader may never be.
 * So every check here runs against a root the reader holds and nothing it
 * fetches, and every failure is "absent" — never "verified", never a refusal.
 */
test.describe("a Sigstore bundle, verified against a held root", () => {
  test("binds the key to an identity, and the identity is shown with its issuer", async () => {
    const { key, signature } = await signedBuild();
    const { root, issue } = await sigstore.testSigstore("Test Sigstore");
    const bundle = await issue({ subjectSpki: key, identity: "https://github.com/chrisb", signatureB64: signature });

    expect(await verifyIdentity(bundle, key, signature, [root])).toEqual({
      status: "shown",
      identity: "https://github.com/chrisb",
      issuer: "https://accounts.example",
      root: "Test Sigstore",
    });
  });

  test("a root the host does not hold is absent, not an error", async () => {
    const { key, signature } = await signedBuild();
    const { issue } = await sigstore.testSigstore();
    const other = await sigstore.testSigstore("Somebody else's Sigstore");
    const bundle = await issue({ subjectSpki: key, identity: "https://github.com/chrisb", signatureB64: signature });

    expect(await verifyIdentity(bundle, key, signature, [other.root])).toMatchObject({ status: "absent", reason: /does not chain/ });
    expect(await verifyIdentity(bundle, key, signature, [])).toMatchObject({ status: "absent" });
  });

  test("a certificate for a different key than the one that signed is absent", async () => {
    const { key, signature } = await signedBuild();
    const { root, issue } = await sigstore.testSigstore();
    const stranger = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const strangerSpki = Buffer.from(await crypto.subtle.exportKey("spki", stranger.publicKey)).toString("base64");
    const bundle = await issue({ subjectSpki: strangerSpki, identity: "https://github.com/chrisb", signatureB64: signature });

    expect(await verifyIdentity(bundle, key, signature, [root])).toMatchObject({ status: "absent", reason: /different key/ });
  });

  test("a log timestamp outside the certificate window is absent", async () => {
    const { key, signature } = await signedBuild();
    const { root, issue } = await sigstore.testSigstore();
    const now = Math.floor(Date.now() / 1000);
    const bundle = await issue({
      subjectSpki: key,
      identity: "chris@example.com",
      signatureB64: signature,
      integratedTime: now,
      certWindow: [now - 7200, now - 3600],
    });
    expect(await verifyIdentity(bundle, key, signature, [root])).toMatchObject({ status: "absent", reason: /outside the certificate/ });
  });

  test("a timestamp signed by a key that is not the log's is absent", async () => {
    const { key, signature } = await signedBuild();
    const { root, issue } = await sigstore.testSigstore();
    const bundle = await issue({ subjectSpki: key, identity: "chris@example.com", signatureB64: signature, wrongLogKey: true });
    expect(await verifyIdentity(bundle, key, signature, [root])).toMatchObject({ status: "absent", reason: /timestamp does not verify/ });
  });

  test("a log entry recording a different signature is absent", async () => {
    const { key, signature } = await signedBuild();
    const other = await signedBuild();
    const { root, issue } = await sigstore.testSigstore();
    // A real bundle, for a real signature by this key — over a different document.
    const bundle = await issue({ subjectSpki: key, identity: "chris@example.com", signatureB64: other.signature });
    expect(await verifyIdentity(bundle, key, signature, [root])).toMatchObject({ status: "absent", reason: /different signature/ });
  });

  test("garbage is absent", async () => {
    const { key, signature } = await signedBuild();
    const { root } = await sigstore.testSigstore();
    expect(await verifyIdentity({ verificationMaterial: { certificate: { rawBytes: "AAAA" } } }, key, signature, [root])).toMatchObject({ status: "absent" });
    expect(await verifyIdentity(null, key, signature, [root])).toMatchObject({ status: "absent" });
    expect(await verifyIdentity("not a bundle", key, signature, [root])).toMatchObject({ status: "absent" });
  });
});

/**
 * On the card, when this host holds the root — and nowhere when it does not.
 * The roots file is what an organisation ships beside a mirror; here it is
 * answered by the test, with the conformance suite's root.
 */
test.describe("identity on the card", () => {
  test("a held root puts the identity on the card; no root, nothing", async ({ page }) => {
    test.slow();
    const { readFileSync } = await import("node:fs");
    const vectors = JSON.parse(readFileSync(resolve(repo, "conformance/identity-vectors.json"), "utf8")) as {
      roots: unknown[];
      vectors: { name: string; file: string }[];
    };
    const valid = vectors.vectors.find((v) => v.name === "identity-valid")!;
    const html = readFileSync(resolve(repo, "conformance", valid.file), "utf8");

    await page.route("**/roots.json", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ formatVersion: 1, sigstore: vectors.roots }) }),
    );
    await page.goto("http://localhost:5175/");
    await page.setInputFiles("#file", { name: "identified.dai.html", mimeType: "text/html", buffer: Buffer.from(html) });
    await expect(page.locator("#card-identity")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#card-identity")).toContainText("Signed in as https://github.com/conformance");
    await expect(page.locator("#card-identity")).toContainText("vouched for by Conformance Sigstore");
    await expect(page.locator("#card")).not.toContainText(/verified/i);
  });

  test("without a root, the same document shows no identity at all", async ({ page }) => {
    test.slow();
    const { readFileSync } = await import("node:fs");
    const vectors = JSON.parse(readFileSync(resolve(repo, "conformance/identity-vectors.json"), "utf8")) as {
      vectors: { name: string; file: string }[];
    };
    const valid = vectors.vectors.find((v) => v.name === "identity-valid")!;
    const html = readFileSync(resolve(repo, "conformance", valid.file), "utf8");
    await page.goto("http://localhost:5175/");
    await page.setInputFiles("#file", { name: "identified.dai.html", mimeType: "text/html", buffer: Buffer.from(html) });
    await expect(page.locator("#card-open")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#card-identity")).toBeHidden();
  });
});
