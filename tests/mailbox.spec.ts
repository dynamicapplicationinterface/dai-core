import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openBatch, sealBatch } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";

/**
 * The relay's three calls, and the seal over them (Track 5, slice one).
 *
 * What is checked here is the mechanism in isolation: append grows the mailbox,
 * head names where it is, since returns exactly what arrived after a cursor,
 * and the batches are opaque to the relay — sealed under a key it never holds,
 * and dropped rather than trusted if a byte of one changed. The rows inside a
 * batch, and their merge, are the frame's and are tested there.
 */
const box = () => fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mailbox-")) });
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (buffer: Uint8Array) => new TextDecoder().decode(buffer);

test.describe("the mailbox: append, head, since", () => {
  test("an empty mailbox has an empty head and yields nothing", async () => {
    const mailbox = box();
    const head = await mailbox.head("doc-a");
    const { batches } = await mailbox.since("doc-a", "");
    expect(batches).toEqual([]);
    // The head of an empty mailbox, passed back to since, still reads nothing.
    const again = await mailbox.since("doc-a", head);
    expect(again.batches).toEqual([]);
  });

  test("since a cursor returns exactly what arrived after it, in order", async () => {
    const mailbox = box();
    await mailbox.append("doc-a", bytes("one"));
    const afterFirst = await mailbox.head("doc-a");
    await mailbox.append("doc-a", bytes("two"));
    await mailbox.append("doc-a", bytes("three"));

    // Everything from the start.
    const all = await mailbox.since("doc-a", "");
    expect(all.batches.map(text)).toEqual(["one", "two", "three"]);

    // Only what arrived after the first was read.
    const rest = await mailbox.since("doc-a", afterFirst);
    expect(rest.batches.map(text)).toEqual(["two", "three"]);

    // And the cursor rest returns reads nothing further until another append.
    const caughtUp = await mailbox.since("doc-a", rest.cursor);
    expect(caughtUp.batches).toEqual([]);
  });

  test("mailboxes are separate per document", async () => {
    const mailbox = box();
    await mailbox.append("doc-a", bytes("a1"));
    await mailbox.append("doc-b", bytes("b1"));
    expect((await mailbox.since("doc-a", "")).batches.map(text)).toEqual(["a1"]);
    expect((await mailbox.since("doc-b", "")).batches.map(text)).toEqual(["b1"]);
  });

  test("head moves only when something is appended", async () => {
    const mailbox = box();
    const empty = await mailbox.head("doc-a");
    await mailbox.append("doc-a", bytes("x"));
    const one = await mailbox.head("doc-a");
    expect(one).not.toBe(empty);
    // No append: the head is where it was, so a poller reads nothing new.
    expect(await mailbox.head("doc-a")).toBe(one);
  });
});

test.describe("the seal: opaque to the relay, dropped if changed", () => {
  const key = () => crypto.getRandomValues(new Uint8Array(32));

  test("a sealed batch opens to exactly what went in, and not before", async () => {
    const k = key();
    const plain = bytes("a batch of rows");
    const sealed = await sealBatch(plain, k);
    // The relay would store `sealed`; it is not the plaintext.
    expect(text(sealed)).not.toContain("a batch of rows");
    expect(text(await openBatch(sealed, k))).toBe("a batch of rows");
  });

  test("a different key cannot open it", async () => {
    const sealed = await sealBatch(bytes("secret move"), key());
    await expect(openBatch(sealed, key())).rejects.toThrow();
  });

  test("a single flipped byte fails the tag rather than opening to garbage", async () => {
    const k = key();
    const sealed = await sealBatch(bytes("Nf3"), k);
    const tampered = new Uint8Array(sealed);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(openBatch(tampered, k)).rejects.toThrow();
  });

  test("a truncated batch is refused, not read as empty", async () => {
    await expect(openBatch(new Uint8Array(5), key())).rejects.toThrow(/TRUNCATED/);
  });

  test("the round trip survives the relay, end to end", async () => {
    const mailbox = box();
    const k = key();
    await mailbox.append("game", await sealBatch(bytes("e4"), k));
    await mailbox.append("game", await sealBatch(bytes("e5"), k));
    const { batches } = await mailbox.since("game", "");
    const opened = await Promise.all(batches.map((b) => openBatch(b, k)));
    expect(opened.map(text)).toEqual(["e4", "e5"]);
  });
});
