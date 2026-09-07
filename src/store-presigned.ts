/**
 * A store for somewhere that cannot hold a key: a browser, or a desktop app.
 *
 * Both of these run on somebody else's device. A bucket credential in either
 * would be a credential belonging to whoever holds the device, so neither gets
 * one. Instead they ask an endpoint for permission to write one object — a URL
 * signed for one key, one content type, and a few minutes — and PUT to it.
 *
 * The bytes never pass through that endpoint. It answers a question about
 * whether this upload may happen; the upload itself goes device to bucket.
 *
 * Reads need none of this. A blob is fetched from a public URL with no
 * credential in the request, which is why the opener can be a static page that
 * anybody mirrors.
 */
import { sha256Hex } from "./core.js";
import { admit, type PreviewIcon, type Sidecar, type Store } from "./store.js";

export interface PresignedStoreOptions {
  /**
   * The endpoint that mints URLs. Usually `/api/presign` on the opener's own
   * origin.
   */
  presignUrl: string;
  /** Where the public reads the bucket, for the href a link points at. */
  publicBase: string;
  /** For a caller with its own fetch — a desktop app, or a test. */
  fetchImpl?: typeof fetch;
}

interface Minted {
  url: string;
  method: string;
  headers: Record<string, string>;
  href: string;
  /** For the document itself: what the sidecar and the icon must present to be written beside it. */
  token?: string;
}

export function presignedStore(options: PresignedStoreOptions): Store {
  const doFetch = options.fetchImpl ?? fetch;
  const publicBase = options.publicBase.endsWith("/") ? options.publicBase : options.publicBase + "/";

  /*
   * Asks for a URL bound to exactly these bytes.
   *
   * The size and the digest travel with the request and come back inside the
   * signature, so what is uploaded is what was declared or the bucket refuses
   * it. Computed here from the bytes themselves rather than taken from the
   * caller: a store that trusted a client's word about its own upload would
   * be a file host with extra steps, which is what the endpoint used to be.
   */
  const mint = async (hash: string, bytes: Uint8Array, kind: "blob" | "sidecar" | "icon", token?: string): Promise<Minted> => {
    const response = await doFetch(options.presignUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash, size: bytes.length, kind, sha256: await sha256Hex(bytes), ...(token ? { token } : {}) }),
    });

    if (!response.ok) {
      // The endpoint's own sentence, because it knows why — too large, too
      // many, nothing configured — and inventing a second one here would
      // produce two explanations for one refusal.
      const said = await response
        .json()
        .then((body) => (body as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(said ?? `The store refused this upload (HTTP ${response.status}).`);
    }

    return (await response.json()) as Minted;
  };

  const put = async (bytes: Uint8Array, minted: Minted): Promise<void> => {
    // Every signed header except content-length, which a browser refuses to
    // let a page set and computes from the body itself. The body is the bytes
    // the size was declared from, so the two agree.
    const { "content-length": _length, ...headers } = minted.headers;
    const response = await doFetch(minted.url, {
      method: minted.method,
      headers,
      body: bytes as never,
    });
    if (!response.ok) {
      throw new Error(
        `The upload was signed but the store would not take it (HTTP ${response.status}). ` +
          `A signed URL is good for a few minutes; try again.`,
      );
    }
  };

  /*
   * Standing to describe a document that is not being stored: a card for a
   * document inside its link. The endpoint hands back a token for an id
   * nothing is stored under yet, and the sidecar and icon go beside nothing.
   */
  const mintPreview = async (id: string): Promise<string> => {
    const response = await doFetch(options.presignUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash: id, kind: "preview" }),
    });
    if (!response.ok) {
      const said = await response
        .json()
        .then((body) => (body as { error?: string }).error)
        .catch(() => undefined);
      throw new Error(said ?? `The store refused this card (HTTP ${response.status}).`);
    }
    const { token } = (await response.json()) as { token?: string };
    if (typeof token !== "string") throw new Error("The store gave no standing to describe this document.");
    return token;
  };

  return {
    async put(hash, ciphertext, sidecar: Sidecar, icon?: PreviewIcon) {
      // The same admission the server-side stores run. Checked here too, before
      // a URL is even asked for: a document that a store would refuse should
      // not consume an upload slot to find that out.
      await admit(hash, ciphertext, sidecar, icon);

      let token: string | undefined;
      let href: string;
      if (ciphertext) {
        const blob = await mint(hash, ciphertext, "blob");
        await put(ciphertext, blob);
        token = blob.token;
        href = blob.href;
      } else {
        // A card beside no document: see storePreview.
        token = await mintPreview(hash);
        href = publicHrefFor(publicBase, `${hash}.json`);
      }

      // Beside the document, with the token that came back with it: only
      // whoever stored the document may describe it.
      const sidecarBytes = new TextEncoder().encode(JSON.stringify(sidecar));
      await put(sidecarBytes, await mint(hash, sidecarBytes, "sidecar", token));

      if (icon) await put(icon.png, await mint(hash, icon.png, "icon", token));

      return href;
    },

    async get(href) {
      // Public, and deliberately not through the endpoint: a read that needed
      // permission would be a store this project could be asked to censor.
      const response = await doFetch(href, { mode: "cors", credentials: "omit" });
      if (!response.ok) throw new Error(`The store returned HTTP ${response.status}.`);
      return new Uint8Array(await response.arrayBuffer());
    },

    async head(href) {
      const response = await doFetch(href, { method: "HEAD", mode: "cors", credentials: "omit" });
      if (!response.ok) return { exists: false, size: 0 };
      return { exists: true, size: Number(response.headers.get("content-length") ?? 0) };
    },
  };
}

/** Where a document written through `presignedStore` will be readable. */
export function publicHrefFor(publicBase: string, hash: string): string {
  return new URL(hash, publicBase.endsWith("/") ? publicBase : publicBase + "/").href;
}
