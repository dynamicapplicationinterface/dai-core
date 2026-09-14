/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { MailboxDO } from "../apps/relay/src/mailbox-do.js";
import { endpointId, vapidAuthorization } from "../apps/relay/src/push.js";
import { memoryBucket, memoryState, vapidKeys, verifyVapid } from "./relay-memory.js";

/**
 * The relay's half of push (Track 5, slice two), run as the deployed code runs.
 *
 * The Durable Object here is the real class, handed an in-memory storage and
 * bucket in place of Cloudflare's; the push service is a local server that
 * checks what a real one checks — a VAPID token signed by the key the
 * subscription was made for, addressed to its own origin. What it proves: a
 * move wakes every subscriber but its author, a retried batch wakes nobody
 * twice, a subscription the push service calls gone is forgotten, and the push
 * carries no body at all.
 */

let pushService: Server;
let pushBase = "";
const received: { path: string; authorization: string; bodyLength: number; topic: string }[] = [];
const goneAt = new Set<string>();

test.beforeAll(async () => {
  pushService = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const path = req.url ?? "/";
      received.push({
        path,
        authorization: String(req.headers["authorization"] ?? ""),
        bodyLength: Buffer.concat(chunks).length,
        topic: String(req.headers["topic"] ?? ""),
      });
      res.writeHead(goneAt.has(path) ? 410 : 201);
      res.end();
    });
  });
  await new Promise<void>((r) => pushService.listen(0, r));
  pushBase = `http://localhost:${(pushService.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  pushService?.closeAllConnections();
  await new Promise<void>((r) => (pushService ? pushService.close(() => r()) : r()));
});

test("the VAPID token is the one a push service accepts", async () => {
  const vapid = await vapidKeys();
  const now = Date.now();
  const claims = await verifyVapid(await vapidAuthorization("https://push.example.net/wake/abc", vapid, now), vapid.publicKey);
  expect(claims.aud).toBe("https://push.example.net");
  expect(claims.sub).toBe("https://opendai.app");
  expect(claims.exp * 1000 - now).toBeGreaterThan(0);
  expect(claims.exp * 1000 - now, "RFC 8292 caps a token at 24 hours").toBeLessThanOrEqual(24 * 60 * 60 * 1000);
});

test("a move wakes every subscriber but its author, once, with nothing in the push", async () => {
  received.length = 0;
  const vapid = await vapidKeys();
  const memory = memoryState();
  const relay = new MailboxDO(memory.state, {
    MAILBOX_R2: memoryBucket(),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateKey),
  });
  const address = "a".repeat(64);
  const call = (path: string, init?: RequestInit) => relay.fetch(new Request(`https://relay.test/m/${address}${path}`, init));
  const subscribe = (endpoint: string) => call("/subscribe", { method: "POST", body: JSON.stringify({ endpoint }) });

  const author = `${pushBase}/author`;
  const partner = `${pushBase}/partner`;
  expect((await subscribe(author)).status).toBe(200);
  expect((await subscribe(partner)).status).toBe(200);
  // Only a push service may be subscribed: HTTPS, or loopback for a test.
  expect((await subscribe("http://example.com/x")).status).toBe(400);
  expect((await subscribe("not a url")).status).toBe(400);

  const move = new Uint8Array([1, 2, 3, 4]);
  const sender = await endpointId(author);
  const first = await call("", { method: "POST", body: move, headers: { "x-dai-sender": sender } });
  expect(await first.text()).toBe("1");
  await memory.settled();

  expect(received.map((r) => r.path), "the partner is woken; the author is not").toEqual(["/partner"]);
  expect(received[0]!.bodyLength, "payloadless: the push says nothing").toBe(0);
  expect(received[0]!.topic, "collapses per mailbox").toBe(address.slice(0, 32));
  const claims = await verifyVapid(received[0]!.authorization, vapid.publicKey);
  expect(claims.aud).toBe(pushBase);

  // The same batch again (a retry after a lost ack) lands where it did and wakes nobody.
  received.length = 0;
  expect(await (await call("", { method: "POST", body: move })).text()).toBe("1");
  await memory.settled();
  expect(received).toEqual([]);

  // A subscription the push service calls gone is forgotten; the rest stay.
  goneAt.add("/partner");
  await call("", { method: "POST", body: new Uint8Array([5]) });
  await memory.settled();
  expect(received.map((r) => r.path).sort()).toEqual(["/author", "/partner"]);
  expect(memory.keys().filter((k) => k.startsWith("s:")).sort()).toEqual([`s:${sender}`]);

  // And an unsubscribe is honored.
  received.length = 0;
  await call("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: author }) });
  await call("", { method: "POST", body: new Uint8Array([6]) });
  await memory.settled();
  expect(received).toEqual([]);
});

test("without VAPID keys the relay keeps subscriptions and wakes nobody", async () => {
  received.length = 0;
  const memory = memoryState();
  const relay = new MailboxDO(memory.state, { MAILBOX_R2: memoryBucket() });
  const address = "b".repeat(64);
  await relay.fetch(new Request(`https://relay.test/m/${address}/subscribe`, { method: "POST", body: JSON.stringify({ endpoint: `${pushBase}/p` }) }));
  const cursor = await (await relay.fetch(new Request(`https://relay.test/m/${address}`, { method: "POST", body: new Uint8Array([9]) }))).text();
  await memory.settled();
  expect(cursor).toBe("1");
  expect(received).toEqual([]);
});
