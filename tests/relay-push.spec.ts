/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { MailboxDO } from "../apps/relay/src/mailbox-do.js";
import { acceptableEndpoint, endpointId, PUSH_TOPIC, vapidAuthorization } from "../apps/relay/src/push.js";
import { memoryBucket, memoryState, vapidKeys, verifyVapid } from "./relay-memory.js";

/**
 * The relay's half of push (Track 5, slice two), run as the deployed code runs.
 *
 * The Durable Object here is the real class, handed an in-memory storage and
 * bucket in place of Cloudflare's; the push service is a local server that
 * checks what a real one checks — a VAPID token signed by the key the
 * subscription was made for, addressed to its own origin. What it proves: a
 * move wakes every subscriber but its author, a retried batch wakes nobody
 * twice, a subscription the push service calls gone is forgotten, the push
 * carries no body and nothing that names its mailbox, and the relay sends only
 * to real push services, only so many per mailbox.
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

/** A relay object for one mailbox, with push keys, admitting the local push service. */
async function relayFor(address: string) {
  const vapid = await vapidKeys();
  const memory = memoryState();
  const relay = new MailboxDO(memory.state, {
    MAILBOX_R2: memoryBucket(),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateKey),
    PUSH_ALLOW_LOOPBACK: "1",
  });
  const call = (path: string, init?: RequestInit) => relay.fetch(new Request(`https://relay.test/m/${address}${path}`, init));
  const subscribe = (endpoint: string) => call("/subscribe", { method: "POST", body: JSON.stringify({ endpoint }) });
  return { vapid, memory, relay, call, subscribe };
}

test("the VAPID token is the one a push service accepts", async () => {
  const vapid = await vapidKeys();
  const now = Date.now();
  const claims = await verifyVapid(await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, now), vapid.publicKey);
  expect(claims.aud).toBe("https://fcm.googleapis.com");
  expect(claims.sub).toBe("https://opendai.app");
  expect(claims.exp * 1000 - now).toBeGreaterThan(0);
  expect(claims.exp * 1000 - now, "RFC 8292 caps a token at 24 hours").toBeLessThanOrEqual(24 * 60 * 60 * 1000);
});

test("a move wakes every subscriber but its author, once, with nothing in the push", async () => {
  received.length = 0;
  const address = "a".repeat(64);
  const { vapid, memory, call, subscribe } = await relayFor(address);

  const author = `${pushBase}/author`;
  const partner = `${pushBase}/partner`;
  expect((await subscribe(author)).status).toBe(200);
  expect((await subscribe(partner)).status).toBe(200);

  const move = new Uint8Array([1, 2, 3, 4]);
  const sender = await endpointId(author);
  const first = await call("", { method: "POST", body: move, headers: { "x-dai-sender": sender } });
  expect(await first.text()).toBe("1");
  await memory.settled();

  expect(received.map((r) => r.path), "the partner is woken; the author is not").toEqual(["/partner"]);
  expect(received[0]!.bodyLength, "payloadless: the push says nothing").toBe(0);
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
  goneAt.clear();

  // And an unsubscribe is honored.
  received.length = 0;
  await call("/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: author }) });
  await call("", { method: "POST", body: new Uint8Array([6]) });
  await memory.settled();
  expect(received).toEqual([]);
});

test("the push service cannot tell which mailbox a push is for, or that two devices share one", async () => {
  // Two games, a subscriber in each. If the topic named the mailbox, both
  // players of one game would carry the same topic at the push service, which
  // would see that their two devices are in the same game.
  received.length = 0;
  const one = await relayFor("c".repeat(64));
  const two = await relayFor("d".repeat(64));
  await one.subscribe(`${pushBase}/one`);
  await two.subscribe(`${pushBase}/two`);
  await one.call("", { method: "POST", body: new Uint8Array([1]) });
  await two.call("", { method: "POST", body: new Uint8Array([2]) });
  await one.memory.settled();
  await two.memory.settled();

  expect(received.map((r) => r.path).sort()).toEqual(["/one", "/two"]);
  for (const push of received) {
    expect(push.topic, "one constant topic, whatever the mailbox").toBe(PUSH_TOPIC);
    expect(push.topic).not.toContain("c".repeat(8));
    expect(push.topic).not.toContain("d".repeat(8));
  }
});

test("the relay sends only to a real push service", () => {
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QOabc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    expect(acceptableEndpoint(endpoint), endpoint).toBe(true);
  }
  for (const endpoint of [
    "https://example.com/push",
    "https://fcm.googleapis.com.example.com/x",
    "https://evilpush.apple.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x",
    "http://fcm.googleapis.com/x",
    "http://localhost:9000/x",
    "not a url",
    42,
  ]) {
    expect(acceptableEndpoint(endpoint), String(endpoint)).toBe(false);
  }
  // Loopback only when the relay's environment says this is a test.
  expect(acceptableEndpoint("http://localhost:9000/x", true)).toBe(true);
  expect(acceptableEndpoint("http://example.com/x", true)).toBe(false);
});

test("a mailbox holds a bounded number of subscriptions, and refuses the rest", async () => {
  const { subscribe, memory } = await relayFor("e".repeat(64));
  const statuses: number[] = [];
  for (let i = 0; i < 9; i += 1) statuses.push((await subscribe(`${pushBase}/device-${i}`)).status);
  expect(statuses.slice(0, 8)).toEqual(Array(8).fill(200));
  expect(statuses[8], "the ninth is refused").toBe(429);
  expect(memory.keys().filter((k) => k.startsWith("s:"))).toHaveLength(8);
  // One already held may subscribe again (a reopened app does), at the cap.
  expect((await subscribe(`${pushBase}/device-0`)).status).toBe(200);
});

test("a deployed relay refuses a loopback endpoint", async () => {
  const memory = memoryState();
  const relay = new MailboxDO(memory.state, { MAILBOX_R2: memoryBucket() });
  const response = await relay.fetch(
    new Request(`https://relay.test/m/${"f".repeat(64)}/subscribe`, { method: "POST", body: JSON.stringify({ endpoint: `${pushBase}/p` }) }),
  );
  expect(response.status).toBe(400);
});

test("without VAPID keys the relay keeps subscriptions and wakes nobody", async () => {
  received.length = 0;
  const memory = memoryState();
  const relay = new MailboxDO(memory.state, { MAILBOX_R2: memoryBucket(), PUSH_ALLOW_LOOPBACK: "1" });
  const address = "b".repeat(64);
  const subscribed = await relay.fetch(
    new Request(`https://relay.test/m/${address}/subscribe`, { method: "POST", body: JSON.stringify({ endpoint: `${pushBase}/p` }) }),
  );
  expect(subscribed.status).toBe(200);
  const cursor = await (await relay.fetch(new Request(`https://relay.test/m/${address}`, { method: "POST", body: new Uint8Array([9]) }))).text();
  await memory.settled();
  expect(cursor).toBe("1");
  expect(received).toEqual([]);
});
