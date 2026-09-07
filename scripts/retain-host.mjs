/**
 * Keeps what the opener rebuilds compact links from, by content.
 *
 * A compact link leaves out the shell and the kit because the opener can
 * rebuild them and prove the rebuild by digest. That is true of the opener
 * as it was when the link was made — and a deploy that changed the runtime
 * by a byte changed every rebuilt shell, so every link made before it
 * stopped opening. So each host the opener has been is kept here, under a
 * name that is the digest of its parts, and an opener whose own rebuild does
 * not match a link tries the ones it used to be.
 *
 * Run after `npm run build`; it is part of it. Writes nothing when the
 * current host is already kept. Commit what it writes: the retention is only
 * worth anything if it is deployed.
 *
 * Run: node scripts/retain-host.mjs
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_SOURCE } from "../dist/kit.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOSTS_DIR = join(repo, "apps/runner/public/hosts");

const template = readFileSync(join(repo, "dist/template.html"), "utf8");
const runtime = readFileSync(join(repo, "dist/dai-runtime.js"), "utf8");

/** The name a host is kept under: the digest of everything it rebuilds from. */
export function hostId(parts) {
  const hash = createHash("sha256");
  for (const part of [parts.template, parts.runtime, parts.kit]) {
    hash.update(Buffer.from(part, "utf8"));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex").slice(0, 16);
}

export function currentHost() {
  return { template, runtime, kit: KIT_SOURCE };
}

export function retain() {
  const host = currentHost();
  const id = hostId(host);
  const indexPath = join(HOSTS_DIR, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : [];
  const dir = join(HOSTS_DIR, id);
  if (index.includes(id) && existsSync(join(dir, "runtime.js"))) return { id, written: false };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.html"), host.template);
  writeFileSync(join(dir, "runtime.js"), host.runtime);
  writeFileSync(join(dir, "kit.js"), host.kit);
  // Newest first: a link is most often from the host just before this one.
  const next = [id, ...index.filter((known) => known !== id)];
  writeFileSync(indexPath, JSON.stringify(next, null, 2) + "\n");
  return { id, written: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { id, written } = retain();
  console.log(written ? `kept host ${id}` : `host ${id} already kept`);
}
