import { expect, test } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { rewriteReplicated } from "../src/replicated.js";
import { looksReplicated, siblingTest, whyNotSibling } from "../src/sibling.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether a merge is offered at all (docs/replicated-tables.md §7).
 *
 * The host's half of the decision, and the half a person sees: this is what
 * puts *Merge into my copy* on the launch card or replaces it with a sentence
 * saying why not. The frame's half — whether the merge can actually run — is
 * separate, because only the frame has both databases open.
 *
 * Every refusal here has words, not a code alone. A card that says a merge is
 * unavailable and stops has told somebody their document is broken.
 */

const KEY = "aabbccddeeff0011";
const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const signed = { documentUuid: UUID, publicKeyFingerprint: KEY, replicated: true };
const unsigned = { documentUuid: UUID, replicated: true };

test.describe("when a merge is offered", () => {
  test("two signed copies of one document, by the same publisher", () => {
    expect(siblingTest(signed, signed)).toEqual({ sibling: true });
  });

  test("two unsigned copies of one document", () => {
    // Ordinary here, and the weakest case: at Level 1 a replica id is a claim,
    // so this is a merge with whoever sent the file. §10 says so plainly.
    expect(siblingTest(unsigned, unsigned)).toEqual({ sibling: true });
  });
});

test.describe("when it is not", () => {
  test("a different document is unrelated, not a failure", () => {
    const other = { ...signed, documentUuid: "11111111-2222-4333-8444-555555555555" };
    expect(siblingTest(other, signed)).toEqual({ sibling: false, because: "unrelated" });
    expect(whyNotSibling("unrelated")).toMatch(/different document/i);
  });

  test("the same id under a different key is refused", () => {
    const stranger = { ...signed, publicKeyFingerprint: "ffffffffffffffff" };
    expect(siblingTest(stranger, signed)).toEqual({ sibling: false, because: "different-publisher" });
  });

  test("signed on one side and not the other is refused, because two absences are not a match", () => {
    /*
     * T1-D4. Draft 1 assumes a signed document and compares SPKIs; treating
     * "both absent" as agreement would let any unsigned file claiming this
     * UUID present itself as a sibling. Both signed by one key, or both
     * unsigned — one of each is a refusal.
     */
    expect(siblingTest(unsigned, signed)).toEqual({ sibling: false, because: "different-publisher" });
    expect(siblingTest(signed, unsigned)).toEqual({ sibling: false, because: "different-publisher" });
  });

  test("a document with no replicated tables is succession, not a failed merge", () => {
    const plain = { ...signed, replicated: false };
    expect(siblingTest(plain, signed)).toEqual({ sibling: false, because: "not-replicated" });
    expect(siblingTest(signed, plain)).toEqual({ sibling: false, because: "not-replicated" });
    expect(whyNotSibling("not-replicated")).toMatch(/whole|newer copy/i);
  });

  test("this device's own copy coming back is not a sibling", () => {
    // Merging a copy with itself. The offer would be nonsense on screen:
    // *merge into my copy*, pointing at the copy it already is.
    expect(siblingTest(signed, signed, { sameReplica: true })).toEqual({
      sibling: false,
      because: "same-copy",
    });
  });

  test("every refusal has words a person can act on", () => {
    for (const because of ["unrelated", "different-publisher", "not-replicated", "same-copy"] as const) {
      const said = whyNotSibling(because);
      expect(said.length, because).toBeGreaterThan(20);
      expect(said, because).not.toMatch(/error|failed|invalid/i);
    }
  });
});

test.describe("the host works out for itself what is replicated", () => {
  /** A real database, since the point is what survives into stored bytes. */
  function bytesFor(schema: string): Uint8Array {
    const db = new DatabaseSync(":memory:");
    db.exec(rewriteReplicated(schema).sql);
    const path = `${process.env["TEMP"] ?? "/tmp"}/dai-detect-${Math.random().toString(36).slice(2)}.db`;
    db.exec(`VACUUM INTO '${path.split("\\").join("/")}'`);
    db.close();
    const bytes = new Uint8Array(readFileSync(path));
    rmSync(path);
    return bytes;
  }

  test("a replicated document is recognised from bytes the host already verified", () => {
    /*
     * The host must not ask the frame this. The frame is the sandbox; the host
     * decides whether a merge is offered. A flag from the frame would be a
     * fact supplied by the party the decision exists to contain.
     */
    const replicated = bytesFor("-- dai:replicated\nCREATE TABLE moves (san TEXT NOT NULL);\n");
    expect(looksReplicated(replicated)).toBe(true);
  });

  test("an ordinary document is not", () => {
    expect(looksReplicated(bytesFor("CREATE TABLE notes (body TEXT);\n"))).toBe(false);
  });

  test("the declaration itself is gone, which is why the columns are what it looks for", () => {
    // The compiler consumes `-- dai:replicated`, and runtime/schema.json holds
    // a digest and migrations rather than schema text. The rewrite's own
    // columns are what survives into bytes, stored verbatim by SQLite.
    const replicated = bytesFor("-- dai:replicated\nCREATE TABLE moves (san TEXT NOT NULL);\n");
    const text = new TextDecoder().decode(replicated);
    expect(text).toContain("_r_replica");
    expect(text).not.toContain("dai:replicated");
  });

  test("both markers are required, so one column name cannot fake it", () => {
    // A heuristic until the manifest carries replication.tables, and its
    // failure is safe in the only direction that matters: a false positive is
    // an offer the frame then refuses by name, never a wrong merge.
    const decoy = new TextEncoder().encode("a table storing the words _r_replica and nothing else");
    expect(looksReplicated(decoy)).toBe(false);
  });
});

test.describe("the heuristic has an expiry, and it is enforced", () => {
  /*
   * `looksReplicated` reads a data section for the rewrite's columns because
   * the authority it stands in for does not exist yet: the compiler does not
   * emit `replication.tables` into the signed manifest.
   *
   * The day it does, this file must lose the heuristic. A stand-in still
   * present after the real thing arrives is a second opinion about a trust
   * decision — the host consulting two sources about what is replicated,
   * which is the negotiation the frame was not allowed to have, arriving by
   * another door.
   *
   * So the expiry is a test rather than an intention. It goes red on the
   * commit that lands the wiring and stays red until the heuristic is gone.
   */
  const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

  test("when the compiler emits replication.tables, looksReplicated must be gone", () => {
    const emitsManifestField =
      /replication\s*:\s*\{/.test(read("src/compile.ts")) ||
      /"replication"\s*:/.test(read("src/core.ts"));

    if (!emitsManifestField) {
      // Not yet. The heuristic is the only answer the host has, and it is
      // expected to be here.
      expect(read("src/sibling.ts")).toContain("export function looksReplicated");
      return;
    }

    expect(
      read("src/sibling.ts"),
      "The compiler now emits replication.tables, so the manifest is the authority. " +
        "Delete looksReplicated and read the manifest instead — leaving both is the host " +
        "holding two opinions about a trust decision.",
    ).not.toContain("export function looksReplicated");
  });

  test("nothing consults the heuristic once the manifest can answer", () => {
    const emitsManifestField =
      /replication\s*:\s*\{/.test(read("src/compile.ts")) ||
      /"replication"\s*:/.test(read("src/core.ts"));
    if (!emitsManifestField) return;

    for (const path of ["apps/runner/src/main.ts", "apps/runner/src/card.ts"]) {
      expect(read(path), `${path} still calls looksReplicated`).not.toContain("looksReplicated(");
    }
  });
});
