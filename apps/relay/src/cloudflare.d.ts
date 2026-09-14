/**
 * The slice of the Workers runtime types this relay touches.
 *
 * Wrangler bundles the relay without typechecking it, and the repo does not
 * carry `@cloudflare/workers-types` for four names. These are declared here so
 * the relay's tests — which run the Durable Object in Node against an in-memory
 * state — typecheck the same code that deploys. Only what is used is declared.
 */
interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface R2Bucket {
  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
