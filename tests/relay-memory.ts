/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { createServer, type Server } from "node:http";
import { expect } from "@playwright/test";
import { MailboxDO } from "../apps/relay/src/mailbox-do.js";
import { base64url, type Vapid } from "../apps/relay/src/push.js";

/**
 * The relay's own Durable Object, run in Node for a test.
 *
 * Cloudflare's storage and bucket are replaced by maps; the class, its routes
 * and its push wake are the code that deploys. `serveRelay` puts one object
 * per mailbox address behind a local HTTP server, the way the Worker routes
 * `/m/<address>` to `idFromName(address)` — with CORS open to any origin,
 * since the test opener is on localhost and the Worker's allowlist names only
 * the production origins.
 */

export function memoryState(): { state: DurableObjectState; settled: () => Promise<void>; keys: () => string[] } {
  const data = new Map<string, unknown>();
  const waiting: Promise<unknown>[] = [];
  const storage = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put<T>(keyOrEntries: string | Record<string, T>, value?: T) {
      if (typeof keyOrEntries === "string") data.set(keyOrEntries, value);
      else for (const [k, v] of Object.entries(keyOrEntries)) data.set(k, v);
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)) as [string, T][]);
    },
  } as DurableObjectStorage;
  return {
    state: { storage, waitUntil: (p) => void waiting.push(p) },
    settled: async () => {
      while (waiting.length > 0) await Promise.all(waiting.splice(0));
    },
    keys: () => [...data.keys()],
  };
}

export function memoryBucket(): R2Bucket {
  const objects = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      objects.set(key, new Uint8Array(value as ArrayBuffer));
    },
    async get(key) {
      const held = objects.get(key);
      return held ? { arrayBuffer: async () => held.slice().buffer } : null;
    },
  };
}

export async function vapidKeys(): Promise<Vapid> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    subject: "https://opendai.app",
  };
}

const decode = (part: string): Uint8Array<ArrayBuffer> => {
  const bytes = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
};

/** Checks a VAPID header the way a push service does; returns the claims. */
export async function verifyVapid(header: string, publicKey: string): Promise<{ aud: string; exp: number; sub: string }> {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match, `a VAPID authorization header: ${header}`).not.toBeNull();
  expect(match![2]).toBe(publicKey);
  const [h, c, s] = match![1]!.split(".");
  const key = await crypto.subtle.importKey("raw", decode(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, decode(s!), new TextEncoder().encode(`${h}.${c}`));
  expect(valid, "the token is signed by the subscription's key").toBe(true);
  return JSON.parse(Buffer.from(decode(c!)).toString()) as { aud: string; exp: number; sub: string };
}

export interface ServedRelay {
  /** The base the opener's `httpMailbox` takes, ending in `/m`. */
  base: string;
  /** Every address anything was appended to. */
  appended: Set<string>;
  /** The subscription names a mailbox holds (`s:<sha256 of endpoint>`). */
  subscriptions: (address: string) => string[];
  /** How many requests of any kind have reached a mailbox — a poll is one. */
  requests: (address: string) => number;
  /** Those requests, oldest first, as "METHOD route" — e.g. "GET head", "POST append". */
  requestLog: (address: string) => string[];
  /** Waits for every push wake the relay has started. */
  settled: () => Promise<void>;
  close: () => Promise<void>;
}

export async function serveRelay(vapid?: Vapid): Promise<ServedRelay> {
  const bucket = memoryBucket();
  const objects = new Map<string, { relay: MailboxDO; memory: ReturnType<typeof memoryState> }>();
  const objectFor = (address: string) => {
    let held = objects.get(address);
    if (!held) {
      const memory = memoryState();
      const env = {
        MAILBOX_R2: bucket,
        // The push service a test stands up is on loopback.
        PUSH_ALLOW_LOOPBACK: "1",
        ...(vapid ? { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_JWK: JSON.stringify(vapid.privateKey) } : {}),
      };
      held = { relay: new MailboxDO(memory.state, env), memory };
      objects.set(address, held);
    }
    return held;
  };
  const appended = new Set<string>();
  const logs = new Map<string, string[]>();
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,if-none-match,x-dai-sender",
    "access-control-expose-headers": "etag",
  };
  const server: Server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://relay.test");
        const match = /^\/m\/([0-9a-zA-Z._-]{1,128})(\/head|\/subscribe|\/unsubscribe)?\/?$/.exec(url.pathname);
        if (!match) {
          res.writeHead(404, cors);
          res.end();
          return;
        }
        const route = match[2] ? match[2].slice(1) : req.method === "POST" ? "append" : "since";
        logs.set(match[1]!, [...(logs.get(match[1]!) ?? []), `${req.method} ${route}`]);
        if (req.method === "POST" && !match[2]) appended.add(match[1]!);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const response = await objectFor(match[1]!).relay.fetch(
          new Request(url.href, {
            method: req.method,
            headers,
            ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...cors });
        res.end(Buffer.from(await response.arrayBuffer()));
      })().catch((error: unknown) => {
        res.writeHead(500, cors);
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return {
    base: `http://localhost:${(server.address() as { port: number }).port}/m`,
    appended,
    subscriptions: (address) => objects.get(address)?.memory.keys().filter((k) => k.startsWith("s:")) ?? [],
    requests: (address) => logs.get(address)?.length ?? 0,
    requestLog: (address) => [...(logs.get(address) ?? [])],
    settled: async () => {
      for (const { memory } of objects.values()) await memory.settled();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
