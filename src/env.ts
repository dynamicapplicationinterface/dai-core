/**
 * Where a store's credentials come from, and where they must never go.
 *
 * ## Who holds the secret
 *
 * Exactly three places, and the list is the design:
 *
 * - **Vercel environment variables**, production and preview kept separate, for
 *   the presign endpoint — the one deployed thing that has it.
 * - **GitHub Actions secrets**, for anything CI publishes.
 * - **`.env.local`** on a developer's machine, ignored by git.
 *
 * Everything else uploads through a presigned URL and never sees a key:
 *
 * - The **opener** and the **desktop app** ask the presign endpoint for a URL
 *   they may PUT to for a few minutes. They run on somebody else's device, so
 *   anything they held would be readable by whoever holds the device.
 * - The **edge middleware** reads a sidecar over plain HTTPS. A preview is
 *   built from a public object; there is nothing to authenticate.
 * - **Reads are public throughout.** A blob is fetched from a URL with no
 *   credential anywhere in the request.
 *
 * The token itself is scoped to the one bucket, object read/write only, one per
 * environment. A token that can do more than write objects to `dai-store` is a
 * token whose loss is a bigger event than it needs to be.
 *
 * ## The file
 *
 * `.env.local`, beside the repository and ignored by git. Read here rather than
 * through a dependency, because a parser this small does not justify putting
 * one in everybody's tree — the same reason the argument parser is hand-rolled.
 * Real environment variables win over the file, so Vercel, GitHub Actions and a
 * shell export all behave the way anybody would expect.
 *
 * `.env.example` is committed and holds names with no values. It is the
 * documentation, and it is the thing that stays in step with the code.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Store } from "./store.js";

/** Names this project reads. Kept here so `.env.example` has one source. */
export const STORE_VARIABLES = [
  "DAI_STORE_DIR",
  // Where a local directory is served from. Only meaningful with DAI_STORE_DIR;
  // the bucket's public address is DAI_STORE_PUBLIC_BASE.
  "DAI_STORE_BASE",
  "DAI_STORE_ENDPOINT",
  "DAI_STORE_BUCKET",
  "DAI_STORE_REGION",
  "DAI_STORE_ACCESS_KEY_ID",
  "DAI_STORE_SECRET_ACCESS_KEY",
  "DAI_STORE_PUBLIC_BASE",
  "DAI_STORE_ALLOW_CLEAR",
] as const;

/**
 * Reads `.env.local` into `process.env`, without overwriting what is there.
 *
 * `KEY=value`, `#` comments, blank lines, and quotes stripped from a value that
 * has them. Nothing else — no interpolation, no multi-line values, no export
 * keyword. A format that does more is a format with surprises in it, and this
 * one is read by a program that is about to use the result as a secret.
 */
export function loadEnvFile(cwd: string = process.cwd()): string | undefined {
  const path = resolve(cwd, ".env.local");
  if (!existsSync(path)) return undefined;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;

    const name = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    // A real environment variable is a deliberate act and outranks a file.
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return path;
}

/**
 * The store this machine is configured to publish to, if any.
 *
 * S3 when it has been given somewhere to write and something to write with; a
 * directory when it has been given a directory; nothing otherwise, which is the
 * honest answer and the one that produces a link somebody can be told about
 * rather than a failure they have to interpret.
 *
 * A partly-configured S3 store throws rather than falling back. Silently
 * writing to a local directory because one variable was misspelled is how
 * somebody hands out a `file:` link believing they published something.
 */
export async function storeFromEnvironment(cwd?: string): Promise<Store | undefined> {
  loadEnvFile(cwd);

  const endpoint = process.env.DAI_STORE_ENDPOINT;
  const bucket = process.env.DAI_STORE_BUCKET;
  const accessKeyId = process.env.DAI_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DAI_STORE_SECRET_ACCESS_KEY;
  const publicBase = process.env.DAI_STORE_PUBLIC_BASE;

  const anyS3 = endpoint || bucket || accessKeyId || secretAccessKey || publicBase;
  if (anyS3) {
    const missing = [
      ["DAI_STORE_ENDPOINT", endpoint],
      ["DAI_STORE_BUCKET", bucket],
      ["DAI_STORE_ACCESS_KEY_ID", accessKeyId],
      ["DAI_STORE_SECRET_ACCESS_KEY", secretAccessKey],
      ["DAI_STORE_PUBLIC_BASE", publicBase],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name as string);

    if (missing.length > 0) {
      throw new Error(
        `This machine is part-configured for an S3 store and cannot publish to it. ` +
          `Missing: ${missing.join(", ")}. See .env.example.`,
      );
    }

    const { s3Store } = await import("./store-s3.js");
    return s3Store({
      endpoint: endpoint!,
      bucket: bucket!,
      // R2 takes "auto"; a real S3 takes its region name.
      region: process.env.DAI_STORE_REGION ?? "auto",
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      publicBase: publicBase!,
      pathStyle: true,
      allowClear: process.env.DAI_STORE_ALLOW_CLEAR === "1",
    });
  }

  const dir = process.env.DAI_STORE_DIR;
  if (!dir) return undefined;
  const { fsStore } = await import("./store-fs.js");
  return fsStore({ root: dir, baseUrl: process.env.DAI_STORE_BASE });
}
