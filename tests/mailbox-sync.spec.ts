import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openBatch, sealBatch, type Mailbox } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { catchUp, publishSealed } from "../src/mailbox-sync.js";

/**
 * The host's two moves over a mailbox, and the two rules they must keep.
 *
 * Publish re-sends the identical sealed bytes until acked, and answers with the
 * cursor. Catch-up delivers what opens and drops — without stalling — what does
 * not. The frame and the network sit on either side of this; here it is
 * exercised against the directory relay so the rules hold before the plumbing
 * carries them.
 */
const box = () => fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mbsync-")) });
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (buffer: Uint8Array) => new TextDecoder().decode(buffer);
const key = () => crypto.getRandomValues(new Uint8Array(32));

/** A relay that fails its first `drops` appends, then behaves. */
function dropping(inner: Mailbox, drops: number): Mailbox {
  let left = drops;
  return {
    append: async (id, sealed) => {
      if (left > 0) {
        left -= 1;
        throw new Error("relay unreachable");
      }
      return inner.append(id, sealed);
    },
    head: (id) => inner.head(id),
    since: (id, cursor) => inner.since(id, cursor),
  };
}

test.describe("publish: seal once, re-send until acked", () => {
  test("a dropped append is retried with the same bytes and lands once", async () => {
    const mailbox = box();
    const flaky = dropping(mailbox, 1);
    const k = key();
    const sealed = await sealBatch(bytes("e4"), k);

    const cursor = await publishSealed(flaky, "game", sealed);
    expect(cursor).toBe("1");

    // Exactly one batch: the retry sent the identical bytes, and the relay's
    // digest dedup would have collapsed it even if the first had secretly
    // landed.
    const { batches } = await mailbox.since("game", "");
    expect(batches).toHaveLength(1);
    expect(text(await openBatch(batches[0]!, k))).toBe("e4");
  });

  test("giving up throws, so a caller leaves its watermark where it was", async () => {
    const flaky = dropping(box(), 99);
    await expect(publishSealed(flaky, "game", await sealBatch(bytes("x"), key()), 3)).rejects.toThrow(
      /unreachable/,
    );
  });
});

test.describe("catch-up: deliver what opens, drop what does not", () => {
  test("delivers each new batch in order and advances the cursor", async () => {
    const mailbox = box();
    const k = key();
    await mailbox.append("game", await sealBatch(bytes("e4"), k));
    await mailbox.append("game", await sealBatch(bytes("e5"), k));

    const delivered: string[] = [];
    const cursor = await catchUp(
      mailbox,
      "game",
      "",
      (sealed) => openBatch(sealed, k),
      async (plain) => void delivered.push(text(plain)),
    );
    expect(delivered).toEqual(["e4", "e5"]);

    // From that cursor, a third batch and nothing already delivered.
    await mailbox.append("game", await sealBatch(bytes("Nf3"), k));
    const again: string[] = [];
    await catchUp(mailbox, "game", cursor, (s) => openBatch(s, k), async (p) => void again.push(text(p)));
    expect(again).toEqual(["Nf3"]);
  });

  test("a batch that will not open is dropped, and the good ones around it still arrive", async () => {
    const mailbox = box();
    const k = key();
    await mailbox.append("game", await sealBatch(bytes("good-before"), k));
    // A tampered batch: a flipped byte, which will fail the GCM tag on open.
    const bad = await sealBatch(bytes("poison"), k);
    bad[bad.length - 1] ^= 0x01;
    await mailbox.append("game", bad);
    await mailbox.append("game", await sealBatch(bytes("good-after"), k));

    const delivered: string[] = [];
    const cursor = await catchUp(
      mailbox,
      "game",
      "",
      (sealed) => openBatch(sealed, k),
      async (plain) => void delivered.push(text(plain)),
    );
    // The poison is dropped; it did not stall the batch after it.
    expect(delivered).toEqual(["good-before", "good-after"]);
    // And the cursor advanced past all three, so the game is not wedged behind
    // a blob that can never open.
    expect(cursor).toBe("3");
  });
});
