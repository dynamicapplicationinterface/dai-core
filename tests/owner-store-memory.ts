/// <reference path="../apps/relay/src/cloudflare.d.ts" />
import { createServer, type Server } from "node:http";
import { memoryState } from "./relay-memory.js";
import worker, { StoreDO } from "../apps/owner-store/src/worker.js";

/**
 * The local test store (docs/store.md, "The local test store"): the owner's
 * store's own Worker and Durable Objects, run in this process behind a local
 * HTTP server, as `relay-memory.ts` runs the mailbox. Cloudflare's storage is
 * a map per object; the routing, the objects and their checks are the code
 * that deploys.
 *
 * It can write out everything it holds and every request it received, so a
 * test can search them for planted values (R-Z, "The store cannot read the
 * records"), and it can be told to go unavailable, or to answer a route its
 * own way, so the failure paths run.
 */

export interface Received {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ServedStore {
  base: string;
  /** Every value every object holds, each as bytes: a string as UTF-8, bytes as they are, anything else as JSON. */
  held: () => Buffer[];
  /** Every request received, in order, including any refused or answered while unavailable. */
  received: () => Received[];
  /** "unavailable": every request is answered 503 and reaches no object. */
  setMode: (mode: "up" | "unavailable") => void;
  /** Answers a route its own way: given the path and the store's own answer, return the answer to send. */
  rewrite: (fn: ((path: string, answer: Response) => Promise<Response> | Response) | null) => void;
  /** The names of the objects that exist. */
  objects: () => string[];
  close: () => Promise<void>;
}

export const valueBytes = (value: unknown): Buffer =>
  typeof value === "string"
    ? Buffer.from(value, "utf8")
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Buffer.from(JSON.stringify(value) ?? "", "utf8");

export async function serveOwnerStore(): Promise<ServedStore> {
  const objects = new Map<string, { store: StoreDO; memory: ReturnType<typeof memoryState> }>();
  const env = {
    STORE: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: (request: Request) => objectFor(String(id)).store.fetch(request) }),
    } as DurableObjectNamespace,
  };
  const objectFor = (name: string) => {
    let held = objects.get(name);
    if (!held) {
      const memory = memoryState();
      held = { store: new StoreDO(memory.state, env), memory };
      objects.set(name, held);
    }
    return held;
  };
  const received: Received[] = [];
  let mode: "up" | "unavailable" = "up";
  let rewriting: ((path: string, answer: Response) => Promise<Response> | Response) | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
        received.push({ method: req.method ?? "", url: req.url ?? "", headers, body });
        const url = new URL(req.url ?? "/", "http://store.test");
        if (mode === "unavailable" && req.method !== "OPTIONS") {
          res.writeHead(503, { "access-control-allow-origin": "*" });
          res.end();
          return;
        }
        let answer = await worker.fetch(
          new Request(url.href, { method: req.method, headers, ...(req.method === "GET" || req.method === "OPTIONS" ? {} : { body }) }),
          env,
        );
        if (rewriting) answer = await rewriting(url.pathname, answer);
        res.writeHead(answer.status, Object.fromEntries(answer.headers));
        res.end(Buffer.from(await answer.arrayBuffer()));
      })().catch((error: unknown) => {
        res.writeHead(500, { "access-control-allow-origin": "*" });
        res.end(String(error));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  return {
    base: `http://localhost:${port}`,
    held: () => {
      const out: Buffer[] = [];
      for (const [name, { memory }] of objects) {
        out.push(Buffer.from(name, "utf8"));
        for (const key of memory.keys()) {
          out.push(Buffer.from(key, "utf8"));
          out.push(valueBytes(memory.peek(key)));
        }
      }
      return out;
    },
    received: () => [...received],
    setMode: (next) => {
      mode = next;
    },
    rewrite: (fn) => {
      rewriting = fn;
    },
    objects: () => [...objects.keys()],
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
