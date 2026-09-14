// Makes the relay's push keys (VAPID, RFC 8292), or checks a pair. Keep the private half secret.
//
//   node apps/relay/scripts/vapid-keys.mjs
//
// Prints the public key — the opener's DAI_PUSH_PUBLIC_KEY at build, and the
// relay's VAPID_PUBLIC_KEY var — and the private key as a JWK for
// `npx wrangler secret put VAPID_PRIVATE_JWK`. Rotating them invalidates every
// subscription made under the old public key; openers resubscribe on the next
// open of each document.
//
//   node apps/relay/scripts/vapid-keys.mjs --verify [path/to/private.jwk]
//
// Checks that a private JWK and VAPID_PUBLIC_KEY in apps/relay/wrangler.toml
// are one pair, before a deploy: a mismatch fails silently, at signing. The
// JWK comes from the file named, or else from the VAPID_PRIVATE_JWK
// environment variable. Two checks, because they prove different things: the
// public key rebuilt from the JWK's own x and y (0x04 || x || y) must equal
// the var, and a signature made with its private scalar d must verify under
// the var — the first alone would pass a JWK whose x/y were copied beside the
// wrong d. The private key is never printed. Exits 1 on any mismatch.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text) => new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

if (process.argv[2] === "--verify") {
  const wrangler = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.toml"), "utf8");
  const configured = /^\s*VAPID_PUBLIC_KEY\s*=\s*"([^"]*)"/m.exec(wrangler)?.[1] ?? "";
  if (!configured) {
    console.log("VAPID_PUBLIC_KEY in wrangler.toml is empty: nothing to compare against.");
    process.exit(1);
  }
  const raw = fromB64url(configured);
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    console.log(`VAPID_PUBLIC_KEY is not a P-256 public key (${raw.length} bytes; want 65, starting 0x04).`);
    process.exit(1);
  }
  console.log(`wrangler.toml VAPID_PUBLIC_KEY: a valid P-256 point (${raw.length} bytes, uncompressed).`);

  const source = process.argv[3] ? readFileSync(process.argv[3], "utf8") : process.env.VAPID_PRIVATE_JWK;
  if (!source) {
    console.log("No private JWK given (a file path, or VAPID_PRIVATE_JWK in the environment): pair not checked.");
    process.exit(1);
  }
  let jwk;
  try {
    jwk = JSON.parse(source);
  } catch {
    console.log("The private key is not JSON; expected the JWK this script printed.");
    process.exit(1);
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    console.log("The JWK is not a P-256 private key (needs kty EC, crv P-256, x, y, d).");
    process.exit(1);
  }

  const rebuilt = b64url(new Uint8Array([0x04, ...fromB64url(jwk.x), ...fromB64url(jwk.y)]));
  const pointsMatch = rebuilt === configured;
  console.log(`Public key rebuilt from the JWK's x and y: ${rebuilt}`);
  console.log(`  ${pointsMatch ? "MATCHES" : "DOES NOT MATCH"} VAPID_PUBLIC_KEY`);

  let signs = false;
  try {
    const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const message = crypto.getRandomValues(new Uint8Array(32));
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message);
    signs = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, message);
  } catch {
    signs = false;
  }
  console.log(`A signature made with the JWK's private key ${signs ? "VERIFIES" : "DOES NOT VERIFY"} under VAPID_PUBLIC_KEY`);

  const ok = pointsMatch && signs;
  console.log(ok ? "\nPair confirmed." : "\nNOT a pair: push would fail at signing. Do not deploy these together.");
  process.exit(ok ? 0 : 1);
}

const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const publicKey = b64url(raw);
const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

console.log("Public key (DAI_PUSH_PUBLIC_KEY for the opener, VAPID_PUBLIC_KEY for the relay):");
console.log(publicKey);
console.log("");
console.log("Private key (secret: npx wrangler secret put VAPID_PRIVATE_JWK):");
console.log(privateJwk);
