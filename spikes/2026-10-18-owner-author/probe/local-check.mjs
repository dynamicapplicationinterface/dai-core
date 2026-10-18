/**
 * The probe's flow on Chromium with a virtual platform authenticator, against
 * `wrangler dev` (http://localhost:8787). Not the experiment: the phone is.
 * This only shows the page, the store and the ceremonies work end to end
 * before anyone holds a phone.
 *
 *     npx wrangler dev --port 8787 --local      (in this directory)
 *     node spikes/2026-10-18-owner-author/probe/local-check.mjs
 *
 * Context 1 makes the owner passkey and writes; context 2 gets the same
 * passkey (copied between virtual authenticators, as iCloud Keychain shares
 * it) and its own author key, and writes; context 3 is context 1 after a
 * wipe: same passkey, empty storage. It restores, and must hold both rows.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.PROBE ?? "http://localhost:8787/";
const browser = await chromium.launch();

async function contextWith(credential) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
  if (credential) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  await page.goto(BASE);
  await page.waitForFunction(() => document.getElementById("author").textContent !== "…");
  return { context, page, cdp, authenticatorId };
}

const readings = async (page) => page.locator("#readings").inputValue();
const line = (text, key) => text.split("\n").find((l) => l.startsWith(key)) ?? `${key}: (missing)`;
const click = async (page, id) => {
  await page.click(`#${id}`);
  await page.waitForTimeout(800);
};

const one = await contextWith();
await click(one.page, "create");
await one.page.fill("#text", "row from context 1");
await click(one.page, "add");
const r1 = await readings(one.page);
const { credentials } = await one.cdp.send("WebAuthn.getCredentials", { authenticatorId: one.authenticatorId });

const two = await contextWith(credentials[0]);
await click(two.page, "signin");
await two.page.fill("#text", "row from context 2");
await click(two.page, "add");
const r2 = await readings(two.page);

await one.context.close(); // the wipe: context 1's storage is gone
const three = await contextWith(credentials[0]);
await click(three.page, "signin");
await click(three.page, "restore");
await click(three.page, "list");
const r3 = await readings(three.page);

for (const [name, r] of [["context 1", r1], ["context 2", r2], ["context 3 (after wipe)", r3]]) {
  console.log(`--- ${name}`);
  for (const key of ["author id", "author key extractable", "owner", "PRF at", "PRF secret", "local rows", "enrolled", "last restore", "checkpoints"]) {
    for (const l of r.split("\n").filter((x) => x.startsWith(key))) console.log(l);
  }
  console.log(line(r, "log").length ? r.split("log:\n")[1] : "");
}
await browser.close();
