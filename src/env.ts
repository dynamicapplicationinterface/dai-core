/**
 * Where a store's credentials come from, and where they must never go.
 *
 * ## Who actually needs them
 *
 * Almost nothing. Three of the four programs in this project touch a store and
 * only one of them writes to it:
 *
 * - The **opener** reads a blob over plain HTTPS from a public URL. It holds no
 *   credentials, and it must not: it runs in a browser, on a device belonging
 *   to whoever was sent a link, and anything it held would be readable by them.
 * - The **edge middleware** reads a sidecar the same way. A preview is built
 *   from a public object; there is nothing to authenticate.
 * - The **CLI and the MCP server** publish, and publishing is a write. This is
 *   the only place a secret is needed, and it runs on the machine of the person
 *   doing the publishing.
 *
 * So credentials live on one laptop, in the environment, and travel no further.
 * Not in the repository, not in Vercel, not in a browser bundle, not in a
 * container. If a credential ever needs to exist in a deployed web service,
 * something has been designed wrong.
 *
 * ## The file
 *
 * `.env.local`, beside the repository and ignored by git. Read here rather than
 * through a dependency, because a parser this small does not justify putting
 * one in everybody's tree — the same reason the argument parser is hand-rolled.
 * Real environment variables win over the file, so CI and a shell export behave
 * the way anybody would expect.
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
  "DAI_STORE_BASE",
  "DAI_S3_ENDPOINT",
  "DAI_S3_BUCKET",
  "DAI_S3_REGION",
  "DAI_S3_ACCESS_KEY_ID",
  "DAI_S3_SECRET_ACCESS_KEY",
  "DAI_S3_PUBLIC_BASE",
  "DAI_S3_ALLOW_CLEAR",
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

  const endpoint = process.env.DAI_S3_ENDPOINT;
  const bucket = process.env.DAI_S3_BUCKET;
  const accessKeyId = process.env.DAI_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.DAI_S3_SECRET_ACCESS_KEY;
  const publicBase = process.env.DAI_S3_PUBLIC_BASE;

  const anyS3 = endpoint || bucket || accessKeyId || secretAccessKey || publicBase;
  if (anyS3) {
    const missing = [
      ["DAI_S3_ENDPOINT", endpoint],
      ["DAI_S3_BUCKET", bucket],
      ["DAI_S3_ACCESS_KEY_ID", accessKeyId],
      ["DAI_S3_SECRET_ACCESS_KEY", secretAccessKey],
      ["DAI_S3_PUBLIC_BASE", publicBase],
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
      region: process.env.DAI_S3_REGION ?? "auto",
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      publicBase: publicBase!,
      pathStyle: true,
      allowClear: process.env.DAI_S3_ALLOW_CLEAR === "1",
    });
  }

  const dir = process.env.DAI_STORE_DIR;
  if (!dir) return undefined;
  const { fsStore } = await import("./store-fs.js");
  return fsStore({ root: dir, baseUrl: process.env.DAI_STORE_BASE });
}
