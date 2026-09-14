// Makes the relay's push keys (VAPID, RFC 8292). Run once; keep the private half secret.
//
//   node apps/relay/scripts/vapid-keys.mjs
//
// Prints the public key — the opener's DAI_PUSH_PUBLIC_KEY at build, and the
// relay's VAPID_PUBLIC_KEY var — and the private key as a JWK for
// `npx wrangler secret put VAPID_PRIVATE_JWK`. Rotating them invalidates every
// subscription made under the old public key; openers resubscribe on the next
// open of each document.
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
const publicKey = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

console.log("Public key (DAI_PUSH_PUBLIC_KEY for the opener, VAPID_PUBLIC_KEY for the relay):");
console.log(publicKey);
console.log("");
console.log("Private key (secret: npx wrangler secret put VAPID_PRIVATE_JWK):");
console.log(privateJwk);
