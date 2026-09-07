import { expect, test } from "@playwright/test";
import handler from "../apps/runner/api/presign.js";
import { presignPut } from "../src/store-s3.js";
import { ICON_CAP } from "../src/store.js";

/**
 * What a presigned upload is allowed to be.
 *
 * The first version of the endpoint signed only the content type and the
 * host. A review checked what that meant against production: a request
 * declaring one kilobyte was granted a URL, sixty-four kilobytes went through
 * it, and the object landed under a name that is not its hash — the public
 * store was an anonymous file host with a size cap that was advice.
 *
 * So the size and the digest are signed into the URL, and the bucket refuses
 * a body that differs from either. These tests hold that the endpoint asks
 * for both, refuses what it should, and puts both inside the signature.
 */

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);

const ENV = {
  DAI_STORE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  DAI_STORE_BUCKET: "dai-store",
  DAI_STORE_REGION: "auto",
  DAI_STORE_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST",
  DAI_STORE_SECRET_ACCESS_KEY: "not-a-real-secret-for-signing-tests-only",
  DAI_STORE_PUBLIC_BASE: "https://store.example/",
};

async function call(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await handler(
    new Request("https://opendai.app/api/presign", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test.describe("the presign endpoint", () => {
  test.beforeAll(() => {
    Object.assign(process.env, ENV);
  });
  test.afterAll(() => {
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  test("binds the size and the digest into what it signs", async () => {
    const { status, json } = await call({ hash: HASH, size: 4096 });
    expect(status).toBe(200);

    const headers = json.headers as Record<string, string>;
    // What the uploader must send, and every one of them is signed.
    expect(headers["content-length"]).toBe("4096");
    expect(headers["x-amz-content-sha256"]).toBe(HASH);
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["cache-control"]).toContain("immutable");

    const url = new URL(json.url as string);
    const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
    for (const name of ["content-length", "x-amz-content-sha256", "content-type", "cache-control", "host"]) {
      expect(signed.split(";"), `${name} must be in the signature`).toContain(name);
    }
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.pathname).toBe(`/dai-store/${HASH}`);
  });

  test("for the document itself, the name is the digest and cannot be overridden", async () => {
    // Not asked for: the key already says what the bytes must hash to.
    const plain = await call({ hash: HASH, size: 10 });
    expect((plain.json.headers as Record<string, string>)["x-amz-content-sha256"]).toBe(HASH);

    // And a claim that they hash to something else is refused rather than
    // signed, which would have put a different document under this name.
    const lying = await call({ hash: HASH, size: 10, sha256: OTHER });
    expect(lying.status).toBe(400);
    expect(String(lying.json.error)).toMatch(/name is the digest/);
  });

  test("a preflight is answered with no body, and the headers a browser needs", async () => {
    // A 204 with a body is refused by the Response constructor itself, and
    // every cross-origin upload used to die at the preflight.
    const response = await handler(new Request("https://opendai.app/api/presign", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("valid JSON of the wrong shape is refused, not thrown on", async () => {
    for (const body of ["null", "[]", '"x"', "42"]) {
      const response = await handler(
        new Request("https://opendai.app/api/presign", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
          body,
        }),
      );
      expect(response.status, body).toBe(400);
    }
  });

  test("only whoever stored the document may write its sidecar and icon", async () => {
    // Anyone who has seen a link knows the hash. That must not be enough to
    // rewrite what a preview says about the document.
    const stranger = await call({ hash: HASH, size: 200, kind: "sidecar", sha256: OTHER });
    expect(stranger.status).toBe(403);
    expect(String(stranger.json.error)).toMatch(/whoever stored the document/);

    const blob = await call({ hash: HASH, size: 4096 });
    expect(blob.status).toBe(200);
    const token = blob.json.token as string;
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);

    // The token that came back with the blob opens the sidecar and the icon.
    const sidecar = await call({ hash: HASH, size: 200, kind: "sidecar", sha256: OTHER, token });
    expect(sidecar.status).toBe(200);
    const icon = await call({ hash: HASH, size: 2000, kind: "icon", sha256: OTHER, token });
    expect(icon.status).toBe(200);
    // Neither of them hands out a token of its own.
    expect(sidecar.json.token).toBeUndefined();

    // A token for one document does not open another's, and a tampered one opens nothing.
    const other = await call({ hash: OTHER, size: 200, kind: "sidecar", sha256: HASH, token });
    expect(other.status).toBe(403);
    const forged = await call({ hash: HASH, size: 200, kind: "sidecar", sha256: OTHER, token: token.slice(0, -1) + (token.endsWith("A") ? "B" : "A") });
    expect(forged.status).toBe(403);
    const expired = await call({ hash: HASH, size: 200, kind: "sidecar", sha256: OTHER, token: "1." + token.split(".")[1] });
    expect(expired.status).toBe(403);
  });

  test("the sidecar and the icon must declare their own digest", async () => {
    const unsaid = await call({ hash: HASH, size: 512, kind: "sidecar" });
    expect(unsaid.status).toBe(400);
    expect(String(unsaid.json.error)).toMatch(/sha256 must be/);

    const token = (await call({ hash: HASH, size: 4096 })).json.token as string;
    const said = await call({ hash: HASH, size: 512, kind: "sidecar", sha256: OTHER, token });
    expect(said.status).toBe(200);
    expect((said.json.headers as Record<string, string>)["x-amz-content-sha256"]).toBe(OTHER);
    expect((said.json.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(new URL(said.json.url as string).pathname).toBe(`/dai-store/${HASH}.json`);
  });

  test("an icon is capped where the store caps it, not at the document cap", async () => {
    const token = (await call({ hash: HASH, size: 4096 })).json.token as string;
    const big = await call({ hash: HASH, size: ICON_CAP + 1, kind: "icon", sha256: OTHER, token });
    expect(big.status).toBe(413);
    expect(String(big.json.error)).toMatch(/preview icon/);

    const fine = await call({ hash: HASH, size: ICON_CAP, kind: "icon", sha256: OTHER, token });
    expect(fine.status).toBe(200);
  });

  test("refuses a size that is not a whole number of bytes, or is nothing", async () => {
    for (const size of [0, -1, 1.5, "1024", null]) {
      const { status } = await call({ hash: HASH, size });
      expect(status, `size=${JSON.stringify(size)}`).toBe(400);
    }
  });

  test("refuses a name that is not a hash", async () => {
    for (const hash of ["../x", "a".repeat(63), "a".repeat(64) + "/y", "g".repeat(64)]) {
      const { status } = await call({ hash, size: 10 });
      expect(status, hash).toBe(400);
    }

    // Hex has two spellings and one meaning: the key is written lowercase
    // whichever way it was asked for, so one object cannot have two names.
    const upper = await call({ hash: "A".repeat(64), size: 10 });
    expect(upper.status).toBe(200);
    expect(new URL(upper.json.url as string).pathname).toBe(`/dai-store/${"a".repeat(64)}`);
  });
});

test.describe("presignPut", () => {
  test("puts every binding header in the canonical request, in order", async () => {
    const signed = await presignPut(
      {
        endpoint: ENV.DAI_STORE_ENDPOINT,
        bucket: ENV.DAI_STORE_BUCKET,
        region: "auto",
        accessKeyId: ENV.DAI_STORE_ACCESS_KEY_ID,
        secretAccessKey: ENV.DAI_STORE_SECRET_ACCESS_KEY,
        publicBase: ENV.DAI_STORE_PUBLIC_BASE,
        pathStyle: true,
      },
      HASH,
      "application/octet-stream",
      { size: 123, sha256: HASH },
      300,
      new Date("2026-09-06T00:00:00Z"),
    );

    const url = new URL(signed.url);
    // SigV4 requires the signed header list sorted; a verifier rebuilds the
    // canonical request from it, so the order is part of the signature.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "cache-control;content-length;content-type;host;x-amz-content-sha256",
    );
    // Host is the browser's to set and is not handed back to be sent by hand.
    expect(signed.headers).not.toHaveProperty("host");
    expect(signed.headers["content-length"]).toBe("123");
    expect(signed.headers["x-amz-content-sha256"]).toBe(HASH);

    // Deterministic for a fixed clock, so a change to the canonical request
    // shows up as a changed signature rather than as a silent drift.
    const again = await presignPut(
      {
        endpoint: ENV.DAI_STORE_ENDPOINT,
        bucket: ENV.DAI_STORE_BUCKET,
        region: "auto",
        accessKeyId: ENV.DAI_STORE_ACCESS_KEY_ID,
        secretAccessKey: ENV.DAI_STORE_SECRET_ACCESS_KEY,
        publicBase: ENV.DAI_STORE_PUBLIC_BASE,
        pathStyle: true,
      },
      HASH,
      "application/octet-stream",
      { size: 123, sha256: HASH },
      300,
      new Date("2026-09-06T00:00:00Z"),
    );
    expect(again.url).toBe(signed.url);

    // And a different size is a different signature: that is the whole point.
    const larger = await presignPut(
      {
        endpoint: ENV.DAI_STORE_ENDPOINT,
        bucket: ENV.DAI_STORE_BUCKET,
        region: "auto",
        accessKeyId: ENV.DAI_STORE_ACCESS_KEY_ID,
        secretAccessKey: ENV.DAI_STORE_SECRET_ACCESS_KEY,
        publicBase: ENV.DAI_STORE_PUBLIC_BASE,
        pathStyle: true,
      },
      HASH,
      "application/octet-stream",
      { size: 124, sha256: HASH },
      300,
      new Date("2026-09-06T00:00:00Z"),
    );
    expect(new URL(larger.url).searchParams.get("X-Amz-Signature")).not.toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
  });
});
