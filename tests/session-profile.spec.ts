import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { zipSync } from "fflate";
import { compileDirectory } from "../src/compile.js";
import {
  MANIFEST_ENTRY,
  ZIP_EPOCH,
  signedBytes,
  signedViewOf,
  toBase64,
  type ContainerManifest,
} from "../src/core.js";
import { ContainerError, parseContainer, verifyContainer } from "../src/container.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The session profile's manifest surface and its guards (T1-D26, T1-D27).
 *
 * Two properties carry the roster bound. For a signed document, `max_parties`
 * is under the signature because `signedBytes` and `signedViewOf` both name the
 * field — so tampering recomputes bytes the signature was not made over. For any
 * document, signed or not, the `session` block and `requires: ["session"]` are
 * one declaration, and half of one is refused as malformed rather than opened as
 * plain replicated.
 */

const SESSION_SCHEMA = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;

const PLAIN_SCHEMA = `-- dai:replicated
CREATE TABLE moves (
  ply INTEGER NOT NULL,
  san TEXT NOT NULL
);
`;

function build(schema: string): Promise<{ html: string; manifest: ContainerManifest }> {
  const dir = mkdtempSync(join(tmpdir(), "dai-session-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><meta charset="utf-8"><p id="app">x</p>', "utf8");
  writeFileSync(join(dir, "schema.sql"), schema, "utf8");
  return compileDirectory({ sourceDir: dir, root: repoRoot, appName: "Session" }).then((built) => ({
    html: built.html,
    manifest: JSON.parse(
      new TextDecoder().decode(parseContainer(built.html).archive[MANIFEST_ENTRY]!),
    ) as ContainerManifest,
  }));
}

/**
 * A container with its manifest rewritten. Unsigned and the manifest is excluded
 * from `hashes`, so editing it leaves every entry digest intact — the point is
 * to reach `checkSessionProfile`, which runs before any digest or signature
 * check, not to defeat those.
 */
async function withManifest(schema: string, edit: (m: Record<string, unknown>) => void): Promise<string> {
  const built = await build(schema);
  const parsed = parseContainer(built.html);
  const archive = { ...parsed.archive };
  const manifest = JSON.parse(new TextDecoder().decode(archive[MANIFEST_ENTRY]!)) as Record<string, unknown>;
  edit(manifest);
  archive[MANIFEST_ENTRY] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const payload = toBase64(zipSync(archive, { level: 9, mtime: ZIP_EPOCH }));
  return built.html.replace(
    /(<script type="application\/octet-stream" id="dai-payload">)([\s\S]*?)(<\/script>)/,
    (_m, open: string, _old: string, close: string) => open + payload + close,
  );
}

test.describe("the manifest surface (T1-D26)", () => {
  test("a session document declares the capability and carries the signed bound at v4", async () => {
    const { manifest } = await build(SESSION_SCHEMA);
    expect(manifest.manifestVersion).toBe(4);
    expect(manifest.requires).toEqual(["replicated", "session"]);
    expect(manifest.session).toEqual({ max_parties: 2 });
    expect(manifest.replication?.tables).toEqual(["moves"]);
  });

  test("close=creator rides in the signed block; the default any leaves the block minimal (T1-D32)", async () => {
    const creator = await build(`-- dai:profile session max_parties=2 close=creator
-- dai:replicated
CREATE TABLE moves ( ply INTEGER NOT NULL, san TEXT NOT NULL );
`);
    expect(creator.manifest.session).toEqual({ max_parties: 2, close: "creator" });

    // Default (any) is slice-one shape — no close key, so an unrestricted session
    // signs the bytes it would have before the policy existed.
    const any = await build(SESSION_SCHEMA);
    expect(any.manifest.session).toEqual({ max_parties: 2 });
  });

  test("the close policy is under the signature — stripping or downgrading it moves the signed bytes (T1-D32)", async () => {
    const { manifest } = await build(`-- dai:profile session max_parties=2 close=creator
-- dai:replicated
CREATE TABLE moves ( ply INTEGER NOT NULL, san TEXT NOT NULL );
`);
    const base = signedBytes(signedViewOf(manifest));
    // Downgrade creator -> any: the bytes a verifier recomputes must move.
    const downgraded = signedBytes(signedViewOf({ ...manifest, session: { max_parties: 2 } }));
    expect(Buffer.from(downgraded).equals(Buffer.from(base))).toBe(false);
  });

  test("a plain replicated document carries neither the capability nor the block", async () => {
    const { manifest } = await build(PLAIN_SCHEMA);
    expect(manifest.requires).toEqual(["replicated"]);
    expect(manifest.session).toBeUndefined();
  });
});

test.describe("the bound is under the signature (T1-D27)", () => {
  /*
   * The verifier recomputes `signedBytes(signedViewOf(manifest))` and checks it
   * against the detached signature (container.ts, verifySignature). So a change
   * that moves those bytes is a change that fails verification. These assert the
   * bytes move, which is the property without needing a key: symmetry between
   * the two functions is the whole guarantee.
   */
  test("editing max_parties, stripping the block, or adding one all move the signed bytes", async () => {
    const { manifest } = await build(SESSION_SCHEMA);
    const base = signedBytes(signedViewOf(manifest));

    // Untampered round-trips to identical bytes — the baseline the others move.
    expect(Buffer.from(signedBytes(signedViewOf(manifest)))).toEqual(Buffer.from(base));

    const edited = signedBytes(signedViewOf({ ...manifest, session: { max_parties: 99 } }));
    expect(Buffer.from(edited).equals(Buffer.from(base))).toBe(false);

    const stripped = signedBytes(signedViewOf({ ...manifest, session: undefined }));
    expect(Buffer.from(stripped).equals(Buffer.from(base))).toBe(false);

    // Adding a block to a plain replicated document also moves its bytes, so a
    // signed plain document cannot be dressed up as a session after the fact.
    const plain = await build(PLAIN_SCHEMA);
    const plainBase = signedBytes(signedViewOf(plain.manifest));
    const forged = signedBytes(signedViewOf({ ...plain.manifest, session: { max_parties: 2 } }));
    expect(Buffer.from(forged).equals(Buffer.from(plainBase))).toBe(false);
  });
});

test.describe("the pairing is enforced structurally (T1-D27)", () => {
  test("a session block without the capability is malformed, not plain replicated", async () => {
    // The dangerous half: without this an unsigned document could carry a block
    // a reader ignores while looking like a session.
    const html = await withManifest(PLAIN_SCHEMA, (m) => {
      m["session"] = { max_parties: 2 };
    });
    const refusal = await verifyContainer(html).catch((e) => e as ContainerError);
    expect(refusal).toBeInstanceOf(ContainerError);
    expect((refusal as ContainerError).code).toBe("MALFORMED_SESSION_PROFILE");
  });

  test("the capability without a block is malformed", async () => {
    const html = await withManifest(PLAIN_SCHEMA, (m) => {
      m["requires"] = ["replicated", "session"];
    });
    const refusal = await verifyContainer(html).catch((e) => e as ContainerError);
    expect((refusal as ContainerError).code).toBe("MALFORMED_SESSION_PROFILE");
  });

  test("a max_parties that is not a positive integer is malformed", async () => {
    for (const bad of [0, -1, 1.5, "2"]) {
      const html = await withManifest(PLAIN_SCHEMA, (m) => {
        m["requires"] = ["replicated", "session"];
        m["session"] = { max_parties: bad };
      });
      const refusal = await verifyContainer(html).catch((e) => e as ContainerError);
      expect((refusal as ContainerError).code, String(bad)).toBe("MALFORMED_SESSION_PROFILE");
    }
  });

  test("a well-formed session document is refused by capability, not opened half-built", async () => {
    // Structural check passes; the reader still does not implement `session`, so
    // it refuses by name rather than opening without the roster (T1-D26).
    const { html } = await build(SESSION_SCHEMA);
    const refusal = await verifyContainer(html).catch((e) => e as ContainerError);
    expect((refusal as ContainerError).code).toBe("UNSUPPORTED_CAPABILITY");
    expect((refusal as ContainerError).message).toContain("session");
  });
});
