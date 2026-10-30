/**
 * The host's side of docs/store.md's seven operations, over HTTP.
 *
 * One function per operation, each answering what the store answered or
 * "unavailable" when no answer came: a timeout, a network failure, or a
 * store that said it could not serve. Nothing here decides what a person is
 * told; the caller does, from these answers alone.
 */
import { b64u, signRequest, utf8, type Author } from "./envelope.js";

export type Unavailable = { unavailable: string };
export type Refused = { refused: string; heads?: string[] };

export interface Enrollment {
  owner: string;
  credential: { id: string; publicKey: string; algorithm: number };
  registration: { clientDataJSON: string };
  verifier: string;
  wraps: { prf: string; keychain: string };
}

export type Proof =
  | { kind: "passkey"; credential: string; clientDataJSON: string; authenticatorData: string; signature: string }
  | { kind: "keychain"; challenge: string; signature: string };

export interface Ack {
  result: "head" | "branch";
  digest: string;
  at: string;
  owner: string;
  document: string;
}

export interface Heads {
  key: string | null;
  heads: { digest: string; at: string }[];
}

/** One envelope of a chain, as the store's log holds it: no bytes. */
export interface Link {
  digest: string;
  parents: string[];
  author: string;
  at: string;
}

export interface Library {
  documents: string[];
  authors: Record<string, string>;
}

const TIMEOUT_MS = 15_000;

async function call(
  base: string,
  author: Author,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(),
  query = "",
): Promise<Response | Unavailable> {
  try {
    const headers = await signRequest(author, method, path, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const answer = await fetch(`${base.replace(/\/$/, "")}${path}${query}`, {
        method,
        headers: { ...headers, ...(body.byteLength ? { "content-type": "application/octet-stream" } : {}) },
        ...(method === "GET" ? {} : { body: body as BodyInit }),
        signal: controller.signal,
        cache: "no-store",
      });
      if (answer.status >= 500) return { unavailable: `HTTP ${answer.status}` };
      return answer;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { unavailable: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

async function answered<T>(response: Response | Unavailable): Promise<T | Refused | Unavailable> {
  if ("unavailable" in response) return response;
  try {
    const value = (await response.json()) as T | Refused;
    if (!response.ok && !(value && typeof value === "object" && "refused" in value)) return { refused: `HTTP ${response.status}` };
    return value;
  } catch {
    return { unavailable: `an answer that is not JSON (HTTP ${response.status})` };
  }
}

export const enrollOwner = async (base: string, author: Author, enrollment: Enrollment): Promise<{ owner: string } | Refused | Unavailable> =>
  answered(
    await call(
      base,
      author,
      "POST",
      `/o/${enrollment.owner}/enroll`,
      utf8(JSON.stringify({ ...enrollment, author: { id: author.id, pub: b64u(author.pub) } })),
    ),
  );

export const admitAuthor = async (
  base: string,
  author: Author,
  owner: string,
  proof: Proof,
): Promise<{ author: string; wraps: { prf: string; keychain: string }; credential: string } | Refused | Unavailable> =>
  answered(await call(base, author, "POST", `/o/${owner}/admit`, utf8(JSON.stringify({ author: { id: author.id, pub: b64u(author.pub) }, proof }))));

export const putKey = async (base: string, author: Author, owner: string, document: string, wrapped: Uint8Array): Promise<{ accepted: true } | Refused | Unavailable> =>
  answered(await call(base, author, "PUT", `/d/${owner}/${document}/key`, utf8(b64u(wrapped))));

export const appendEnvelope = async (
  base: string,
  author: Author,
  owner: string,
  document: string,
  bytes: Uint8Array,
  as: "head" | "branch",
): Promise<Ack | Refused | Unavailable> => answered(await call(base, author, "POST", `/d/${owner}/${document}/append`, bytes, `?as=${as}`));

export const headsOf = async (base: string, author: Author, owner: string, document: string): Promise<Heads | Refused | Unavailable> =>
  answered(await call(base, author, "GET", `/d/${owner}/${document}/heads`));

export const chainOf = async (base: string, author: Author, owner: string, document: string, from: string): Promise<{ chain: Link[] } | Refused | Unavailable> =>
  answered(await call(base, author, "GET", `/d/${owner}/${document}/c/${from}`));

export const libraryOf = async (base: string, author: Author, owner: string): Promise<Library | Refused | Unavailable> =>
  answered(await call(base, author, "GET", `/o/${owner}/library`));

/** Get: an envelope's bytes and the store's acknowledgment time for it. */
export async function getEnvelope(
  base: string,
  author: Author,
  owner: string,
  document: string,
  digest: string,
): Promise<{ bytes: Uint8Array; at: string } | Refused | Unavailable> {
  const response = await call(base, author, "GET", `/d/${owner}/${document}/e/${digest}`);
  if ("unavailable" in response) return response;
  if (!response.ok) return { refused: `HTTP ${response.status}` };
  return { bytes: new Uint8Array(await response.arrayBuffer()), at: response.headers.get("x-dai-at") ?? "" };
}

export const isUnavailable = (value: unknown): value is Unavailable => !!value && typeof value === "object" && "unavailable" in value;
export const isRefused = (value: unknown): value is Refused => !!value && typeof value === "object" && "refused" in value;
