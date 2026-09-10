import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Mailbox } from "../src/mailbox.js";
import { fsMailbox } from "../src/mailbox-fs.js";
import { base64, httpMailbox } from "../src/mailbox-http.js";

/**
 * The HTTP adapter, and the wire contract it holds the relay to.
 *
 * The client is driven against a fetch that a directory mailbox stands behind,
 * so the same three calls that pass in-process pass across the wire, and the
 * relay the Durable Object implements has an exact shape to match: `POST
 * /<doc>` returns the cursor as text, `GET /<doc>/head` the head as text, `GET
 * /<doc>?since=<cursor>` a `{ cursor, batches[] }` with each batch base64. The
 * dedup-returns-original-cursor invariant is checked *through* HTTP, since that
 * is the property a counter-backed relay is most likely to break.
 */

/** A fetch that serves one `Mailbox` over the relay's contract. Stands in for the DO. */
function relayFetch(mailbox: Mailbox): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const parts = url.pathname.split("/").filter(Boolean); // [..., <doc>] or [..., <doc>, "head"]
    const method = (init?.method ?? "GET").toUpperCase();
    const ok = (body: string) => new Response(body, { status: 200 });

    if (method === "POST") {
      const doc = parts[parts.length - 1]!;
      const cursor = await mailbox.append(doc, new Uint8Array(init!.body as ArrayBuffer));
      return ok(cursor);
    }
    if (parts[parts.length - 1] === "head") {
      return ok(await mailbox.head(parts[parts.length - 2]!));
    }
    const doc = parts[parts.length - 1]!;
    const { cursor, batches } = await mailbox.since(doc, url.searchParams.get("since") ?? "");
    return new Response(JSON.stringify({ cursor, batches: batches.map(base64.encode) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const server = () => fsMailbox({ root: mkdtempSync(join(tmpdir(), "dai-mb-http-")) });
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (buffer: Uint8Array) => new TextDecoder().decode(buffer);

test.describe("the mailbox over HTTP", () => {
  test("append, head and since round-trip across the wire", async () => {
    const backend = server();
    const mailbox = httpMailbox({ base: "https://relay.test/m", fetch: relayFetch(backend) });

    const c1 = await mailbox.append("game", bytes("e4"));
    const afterFirst = await mailbox.head("game");
    expect(afterFirst).toBe(c1);
    await mailbox.append("game", bytes("e5"));

    const all = await mailbox.since("game", "");
    expect(all.batches.map(text)).toEqual(["e4", "e5"]);

    const rest = await mailbox.since("game", c1);
    expect(rest.batches.map(text)).toEqual(["e5"]);
  });

  test("a deduplicated retry returns the original cursor over HTTP, and head holds", async () => {
    const backend = server();
    const mailbox = httpMailbox({ base: "https://relay.test/m", fetch: relayFetch(backend) });

    const first = bytes("Nf3");
    const seq = await mailbox.append("game", first);
    const headAfter = await mailbox.head("game");
    const seqAgain = await mailbox.append("game", new Uint8Array(first));
    expect(seqAgain).toBe(seq);
    expect(await mailbox.head("game")).toBe(headAfter);
  });

  test("a non-200 is an error, not an empty read that would advance a cursor", async () => {
    const failing = (async () => new Response("no", { status: 503 })) as typeof fetch;
    const mailbox = httpMailbox({ base: "https://relay.test/m", fetch: failing });
    await expect(mailbox.since("game", "")).rejects.toThrow(/SINCE_503/);
    await expect(mailbox.append("game", bytes("x"))).rejects.toThrow(/APPEND_503/);
  });
});
