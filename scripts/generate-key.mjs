#!/usr/bin/env node
// Generates an ECDSA P-256 signing key pair for DAI containers.
//   node scripts/generate-key.mjs [outDir]
// The private key signs at compile time and must never enter a container.
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? ".");
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });

writeFileSync(resolve(outDir, "dai-signing-key.pem"), privatePem);
writeFileSync(resolve(outDir, "dai-signing-key.pub.pem"), publicPem);

const spki = publicKey.export({ type: "spki", format: "der" });
// SHA-256 of the SPKI: the base64 of the DER starts with a fixed prefix and
// would look identical for every key.
const fingerprint = createHash("sha256").update(spki).digest("hex").slice(0, 16);
console.log("private key : dai-signing-key.pem  (keep secret, never ship)");
console.log("public key  : dai-signing-key.pub.pem");
console.log("fingerprint :", fingerprint);
