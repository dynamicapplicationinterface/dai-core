import { expect, test } from "@playwright/test";
import handler from "../apps/runner/api/forget.js";
import { retireDigest } from "../src/store.js";

/**
 * Retiring a shared document.
 *
 * The store holds the hash of a token; whoever presents the token has the
 * document, its record and its icon removed. Wrong token, nothing happens.
 * Already gone, the answer is that it is gone.
 */
const HASH = "c".repeat(64);
const TOKEN = "A".repeat(43);

const ENV = {
  DAI_STORE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  DAI_STORE_BUCKET: "dai-store",
  DAI_STORE_REGION: "auto",
  DAI_STORE_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
  DAI_STORE_SECRET_ACCESS_KEY: "not-a-real-secret-for-signing-tests-only",
  DAI_STORE_PUBLIC_BASE: "https://store.example/",
};

/** A store played by a fetch: a sidecar to read, and deletes to record. */
function storeWith(sidecar: unknown | undefined) {
  const deleted: { url: URL; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (init?.method === "DELETE") {
      deleted.push({ url, method: init.method });
      return new Response(null, { status: 204 });
    }
    if (url.href === `https://store.example/${HASH}.json`) {
      return sidecar === undefined
        ? new Response("not here", { status: 404 })
        : new Response(JSON.stringify(sidecar), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, deleted };
}

async function call(body: unknown, fetchImpl: typeof fetch, address = "203.0.113.20") {
  const response = await handler(
    new Request("https://opendai.app/api/forget", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify(body),
    }),
    fetchImpl,
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test.describe("retiring a shared document", () => {
  test.beforeAll(() => Object.assign(process.env, ENV));
  test.afterAll(() => {
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  test("the right token removes the document, its record and its icon, with signed deletes", async () => {
    const store = storeWith({ size: 10, retire: await retireDigest(TOKEN) });
    const { status, json } = await call({ hash: HASH, token: TOKEN }, store.fetchImpl);
    expect(status).toBe(200);
    expect(json.gone).toBe(true);
    expect(store.deleted.map((d) => d.url.pathname)).toEqual([
      `/dai-store/${HASH}.png`,
      `/dai-store/${HASH}.json`,
      `/dai-store/${HASH}`,
    ]);
    for (const { url } of store.deleted) {
      expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    }
  });

  test("a wrong token removes nothing", async () => {
    const store = storeWith({ size: 10, retire: await retireDigest(TOKEN) });
    const { status } = await call({ hash: HASH, token: "B".repeat(43) }, store.fetchImpl, "203.0.113.21");
    expect(status).toBe(403);
    expect(store.deleted).toEqual([]);
  });

  test("a document shared before tokens existed cannot be retired by anyone", async () => {
    const store = storeWith({ size: 10 });
    const { status, json } = await call({ hash: HASH, token: TOKEN }, store.fetchImpl, "203.0.113.22");
    expect(status).toBe(403);
    expect(String(json.error)).toMatch(/before links could be retired/);
    expect(store.deleted).toEqual([]);
  });

  test("a document already gone is reported gone, not as an error", async () => {
    const store = storeWith(undefined);
    const { status, json } = await call({ hash: HASH, token: TOKEN }, store.fetchImpl, "203.0.113.23");
    expect(status).toBe(200);
    expect(json).toEqual({ gone: true, already: true });
  });

  test("the wrong shape is refused before the store is asked", async () => {
    const store = storeWith({ size: 10, retire: await retireDigest(TOKEN) });
    for (const body of [null, [], { hash: "x", token: TOKEN }, { hash: HASH, token: "short" }, { hash: HASH }]) {
      const { status } = await call(body, store.fetchImpl, "203.0.113.24");
      expect(status, JSON.stringify(body)).toBe(400);
    }
    expect(store.deleted).toEqual([]);
  });
});
