import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileDirectory } from "../src/compile.js";
import { MANIFEST_ENTRY, type ContainerManifest } from "../src/core.js";
import { parseContainer } from "../src/container.js";
import { declaresReplication, siblingTest, whyNotSibling } from "../src/sibling.js";

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
  /*
   * The host must not ask the frame this. The frame is the sandbox; the host
   * decides whether a merge is offered. A flag from the frame would be a fact
   * supplied by the party the decision exists to contain.
   *
   * The answer is the signed manifest. It was a heuristic over the database
   * bytes until the compiler emitted `replication.tables`, because nothing
   * else survived into a container: `-- dai:replicated` is consumed at build
   * and `runtime/schema.json` carries a digest rather than schema text.
   */
  test("a document whose schema declared a replicated table says so", () => {
    expect(declaresReplication({ replication: { tables: ["moves"], level: 1 } })).toBe(true);
  });

  test("an ordinary document does not", () => {
    expect(declaresReplication({})).toBe(false);
  });

  test("a declaration of no tables is not a declaration", () => {
    // The compiler writes the field only when there is something in it, so an
    // empty list should not exist. Reading one as "replicated" would offer a
    // merge over nothing and report success having changed nothing, which is
    // exactly what NOT_REPLICATED exists to say instead.
    expect(declaresReplication({ replication: { tables: [], level: 1 } })).toBe(false);
  });

  test("the field is what the compiler actually writes", async () => {
    /*
     * The end of the chain, checked end to end rather than against a literal
     * this test wrote itself. A hand-built object proves the reader; only a
     * real build proves the reader and the writer agree, which is the pair
     * that was wrong while the rewrite had no caller.
     */
    const built = await compileDirectory({
      sourceDir: resolve(repoRoot, "tests/fixture/chess"),
      root: repoRoot,
      appName: "Velvet Chess",
    });
    const manifest = JSON.parse(
      new TextDecoder().decode(parseContainer(built.html).archive[MANIFEST_ENTRY]!),
    ) as ContainerManifest;
    expect(declaresReplication(manifest)).toBe(true);
    expect(manifest.replication?.tables).toEqual(["game_events", "games", "moves"]);
    expect(manifest.replication?.level).toBe(1);
    expect(manifest.manifestVersion).toBe(4);
    expect(manifest.requires).toEqual(["replicated"]);
  });
});

test.describe("the host holds one opinion about what is replicated", () => {
  /*
   * `looksReplicated` searched a data section for the rewrite's own column
   * names, as a stand-in for a manifest field that did not exist yet. It has
   * been deleted, and this is what keeps it deleted.
   *
   * A stand-in still present after the real thing arrives is a second opinion
   * about a trust decision — the host consulting two sources about what is
   * replicated, which is the negotiation the frame was not allowed to have,
   * arriving by another door. It also had a false positive the field does not:
   * a table holding both column names as content read as replicated.
   */
  const read = (path: string): string => readFileSync(resolve(repoRoot, path), "utf8");

  test("the heuristic is gone and does not come back", () => {
    expect(read("src/sibling.ts")).not.toContain("looksReplicated");
  });

  test("nothing consults it", () => {
    for (const path of ["apps/runner/src/main.ts", "apps/runner/src/card.ts"]) {
      expect(read(path), `${path} still calls looksReplicated`).not.toContain("looksReplicated");
    }
  });
});
