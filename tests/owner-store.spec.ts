import { expect, test } from "@playwright/test";
import {
  admitChallenge,
  authorIdOf,
  b64u,
  concat,
  digestOf,
  fromB64u,
  keychainVerifier,
  openEnvelope,
  parseEnvelope,
  plain,
  sealEnvelope,
  sha256,
  utf8,
  type Author,
  type Checkpoint,
  type Clear,
} from "../apps/owner-store/src/envelope.js";
import {
  admitAuthor,
  appendEnvelope,
  enrollOwner,
  getEnvelope,
  headsOf,
  isRefused,
  libraryOf,
  putKey,
  type Ack,
  type Proof,
} from "../apps/owner-store/src/client.js";
import { deployedStore, serveOwnerStore, type ServedStore } from "./owner-store-memory.js";
import { base as twoCopies, item } from "./changesets/scenarios.js";

/**
 * The local test store, against docs/store.md's seven operations (Build 2b-2,
 * item 1; R-B, R-C, R-Z).
 *
 * Append is compare-and-swap on the parent, and branches are first-class: a
 * second append on the same parent is refused as the head, and kept when it is
 * appended as a branch. An append whose signature, author enrollment or parent
 * link fails is refused. The library is by owner. And the store holds nothing
 * it can read: values planted in a record, in deleted history and in a pending
 * alternative, carried through enrollment, saves on two authors and a
 * recovery, appear in nothing it holds and in no request it received.
 *
 * The host's side here is `apps/owner-store/src/client.ts` and `envelope.ts`,
 * the modules the opener seals and sends with; the passkey is a software
 * authenticator, which signs what a real one signs.
 */

const ORIGIN = "http://localhost:5175";

async function newAuthor(): Promise<Author> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  return { privateKey: keys.privateKey, pub, id: await authorIdOf(pub) };
}

const rawToDer = (raw: Uint8Array): Uint8Array => {
  const int = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = bytes.slice(start);
    return concat(new Uint8Array([0x02, body[0]! & 0x80 ? body.length + 1 : body.length]), body[0]! & 0x80 ? new Uint8Array([0]) : new Uint8Array(), body);
  };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, seq.length]), seq);
};

/** A passkey in software: registers and asserts as an authenticator does, ES256, user present and verified. */
async function softwarePasskey() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const spki = b64u(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)));
  return {
    id,
    registration: (origin = ORIGIN) => ({
      credential: { id, publicKey: spki, algorithm: -7 },
      registration: { clientDataJSON: b64u(utf8(JSON.stringify({ type: "webauthn.create", challenge: b64u(utf8("x")), origin }))) },
    }),
    assert: async (challenge: string, origin = ORIGIN): Promise<Proof> => {
      const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: b64u(utf8(challenge)), origin }));
      const authenticatorData = concat(await sha256(utf8("localhost")), new Uint8Array([0x05, 0, 0, 0, 0]));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, concat(authenticatorData, await sha256(clientDataJSON))),
      );
      return { kind: "passkey", credential: id, clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(rawToDer(raw)) };
    },
  };
}

/** An owner as the host makes one (docs/store.md, "Keys"), with every secret kept here so a test can search for it. */
async function newOwner(store: ServedStore) {
  const owner = b64u(crypto.getRandomValues(new Uint8Array(16)));
  const passkey = await softwarePasskey();
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const keychainSecret = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const wrapping = async (secret: Uint8Array, info: string) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: utf8("dai owner key v1"), info: utf8(info) },
      await crypto.subtle.importKey("raw", plain(secret), "HKDF", false, ["deriveKey"]),
      { name: "AES-KW", length: 256 },
      false,
      ["wrapKey", "unwrapKey"],
    );
  const ownerKey = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, true, ["wrapKey", "unwrapKey"]);
  const wraps = {
    prf: b64u(new Uint8Array(await crypto.subtle.wrapKey("raw", ownerKey, await wrapping(prf, "prf"), "AES-KW"))),
    keychain: b64u(new Uint8Array(await crypto.subtle.wrapKey("raw", ownerKey, await wrapping(utf8(keychainSecret), "keychain"), "AES-KW"))),
  };
  const verifier = await keychainVerifier(utf8(keychainSecret));
  const first = await newAuthor();
  const enrolled = await enrollOwner(store.base, first, { owner, ...passkey.registration(), verifier: verifier.pub, wraps });
  expect(enrolled, "the owner enrolls").toEqual({ owner });
  return { owner, passkey, prf, keychainSecret, ownerKey, verifier, first, wraps };
}

async function newDocument(store: ServedStore, o: Awaited<ReturnType<typeof newOwner>>, author: Author) {
  const document = crypto.randomUUID();
  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, o.ownerKey, "AES-KW"));
  expect(await putKey(store.base, author, o.owner, document, wrapped)).toEqual({ accepted: true });
  return { document, dataKey };
}

let revision = 0;
async function envelope(
  o: { owner: string },
  d: { document: string; dataKey: CryptoKey },
  author: Author,
  parents: string[],
  database: Uint8Array = utf8(`database ${revision}`),
  parentCheckpoints: string[] = [],
) {
  revision += 1;
  const clear: Clear = { owner: o.owner, document: d.document, author: author.id, parents };
  const checkpoint: Checkpoint = { release: "r".repeat(43), document: d.document, revision, database: await digestOf(database), parents: parentCheckpoints };
  return sealEnvelope(clear, { checkpoint, title: "Notes", database }, d.dataKey, author);
}

const ack = (answer: unknown): Ack => {
  expect(isRefused(answer), `acknowledged: ${JSON.stringify(answer)}`).toBe(false);
  return answer as Ack;
};

/*
 * The store under test: the local test store, or, with DAI_STORE_DEV set to
 * its address, the deployed dai-store-dev (Build 2b-2b item 7), which CI runs
 * this suite against with test owners made here. Production is never named.
 */
const DEPLOYED = (process.env.DAI_STORE_DEV ?? "").trim();

let store: ServedStore;
test.beforeEach(async () => {
  store = DEPLOYED ? deployedStore(DEPLOYED) : await serveOwnerStore();
});
test.afterEach(async () => {
  await store.close();
});

test("a second append on the same parent is refused as the head, and kept when appended as a branch", async () => {
  const o = await newOwner(store);
  const d = await newDocument(store, o, o.first);
  const root = await envelope(o, d, o.first, []);
  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, root.bytes, "head"))).toMatchObject({ result: "head", digest: root.digest });
  const next = await envelope(o, d, o.first, [root.digest]);
  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, next.bytes, "head"))).toMatchObject({ result: "head", digest: next.digest });

  // Another device, still at the root, appends on it as the head: the swap fails.
  const other = await envelope(o, d, o.first, [root.digest]);
  const refused = await appendEnvelope(store.base, o.first, o.owner, d.document, other.bytes, "head");
  expect(refused, "a second append on the same parent is refused").toEqual({ refused: "stale", heads: [next.digest] });
  expect((await headsOf(store.base, o.first, o.owner, d.document)) as { heads: { digest: string }[] }).toMatchObject({ heads: [{ digest: next.digest }] });

  // Appended as a branch on purpose, it is kept beside the head: nothing accepted is dropped.
  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, other.bytes, "branch"))).toMatchObject({ result: "branch", digest: other.digest });
  const heads = (await headsOf(store.base, o.first, o.owner, d.document)) as { heads: { digest: string }[] };
  expect(heads.heads.map((h) => h.digest).sort()).toEqual([next.digest, other.digest].sort());

  // A merge whose parents are both heads is the head again; the same bytes again are answered as they were.
  const merged = await envelope(o, d, o.first, [next.digest, other.digest]);
  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, merged.bytes, "head"))).toMatchObject({ result: "head" });
  const again = ack(await appendEnvelope(store.base, o.first, o.owner, d.document, merged.bytes, "head"));
  expect(again.digest).toBe(merged.digest);
  expect(((await headsOf(store.base, o.first, o.owner, d.document)) as { heads: { digest: string }[] }).heads.map((h) => h.digest)).toEqual([merged.digest]);

  const got = await getEnvelope(store.base, o.first, o.owner, d.document, root.digest);
  expect(got && "bytes" in got && (await digestOf(got.bytes))).toBe(root.digest);
});

test("an append whose signature, author enrollment or parent link fails is refused", async () => {
  const o = await newOwner(store);
  const d = await newDocument(store, o, o.first);
  const root = await envelope(o, d, o.first, []);
  ack(await appendEnvelope(store.base, o.first, o.owner, d.document, root.bytes, "head"));
  const refusedNow = async (bytes: Uint8Array, by: Author = o.first) => {
    const answer = await appendEnvelope(store.base, by, o.owner, d.document, bytes, "branch");
    return isRefused(answer) ? answer.refused : `accepted: ${JSON.stringify(answer)}`;
  };

  // The envelope's signature: a byte of it changed.
  const good = await envelope(o, d, o.first, [root.digest]);
  const forged = parseEnvelope(good.bytes);
  const sig = fromB64u(forged.signature);
  sig[5] ^= 1;
  expect(await refusedNow(utf8(JSON.stringify({ ...forged, signature: b64u(sig) })))).toBe("the envelope's signature does not hold");
  // The sealed part changed under a signature made for the original.
  const sealed = fromB64u(forged.sealed);
  sealed[20] ^= 1;
  expect(await refusedNow(utf8(JSON.stringify({ ...forged, sealed: b64u(sealed) })))).toBe("the envelope's signature does not hold");
  // The clear part's parents changed: the signature covers them.
  expect(await refusedNow(utf8(JSON.stringify({ ...forged, parents: [] })))).toBe("the envelope's signature does not hold");

  // An author never enrolled under this owner, signing both the envelope and the request.
  const stranger = await newAuthor();
  expect(await refusedNow((await envelope(o, d, stranger, [root.digest])).bytes, stranger)).toBe("author not enrolled");
  // An author enrolled under another owner is not enrolled under this one.
  const elsewhere = await newOwner(store);
  expect(await refusedNow((await envelope(o, d, elsewhere.first, [root.digest])).bytes, elsewhere.first)).toBe("author not enrolled");
  // An enrolled author sending an envelope signed by one who is not.
  expect(await refusedNow((await envelope(o, d, stranger, [root.digest])).bytes, o.first)).toBe("the envelope names another author");

  // The parent link: a parent the store does not hold.
  const orphan = await envelope(o, d, o.first, [b64u(await sha256(utf8("never appended")))]);
  expect(await refusedNow(orphan.bytes)).toBe("a parent the store does not hold");

  // And the good envelope, unchanged, is accepted: each refusal was for its fault alone.
  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, good.bytes, "head")).result).toBe("head");
});

test("the library is by owner, and only an enrolled author reads it", async () => {
  const a = await newOwner(store);
  const b = await newOwner(store);
  const d1 = await newDocument(store, a, a.first);
  const d2 = await newDocument(store, a, a.first);
  const d3 = await newDocument(store, b, b.first);
  const listed = (await libraryOf(store.base, a.first, a.owner)) as { documents: string[]; authors: Record<string, string> };
  expect(listed.documents).toEqual([d1.document, d2.document].sort());
  expect(listed.authors).toEqual({ [a.first.id]: b64u(a.first.pub) });
  expect(((await libraryOf(store.base, b.first, b.owner)) as { documents: string[] }).documents).toEqual([d3.document]);
  // B's author reads nothing of A's.
  expect(await libraryOf(store.base, b.first, a.owner)).toEqual({ refused: "author not enrolled" });
  expect(await headsOf(store.base, b.first, a.owner, d1.document)).toEqual({ refused: "author not enrolled" });
  // A document's key is the first one put.
  expect(await putKey(store.base, a.first, a.owner, d1.document, crypto.getRandomValues(new Uint8Array(40)))).toEqual({
    refused: "the document has another key",
  });
});

test("a new author is admitted by the owner's passkey or the keychain proof, and by nothing else", async () => {
  const o = await newOwner(store);
  const recovering = await newAuthor();
  // The passkey: an assertion over a fresh challenge, from the origin it was registered on.
  const challenge = admitChallenge();
  const admitted = await admitAuthor(store.base, recovering, o.owner, await o.passkey.assert(challenge));
  expect(admitted).toEqual({ author: recovering.id, wraps: o.wraps, credential: o.passkey.id });
  // The same assertion again: a replay.
  expect(await admitAuthor(store.base, await newAuthor(), o.owner, await o.passkey.assert(challenge))).toEqual({ refused: "a challenge already used" });
  // Another origin; another passkey; a stale challenge.
  expect(await admitAuthor(store.base, await newAuthor(), o.owner, await o.passkey.assert(admitChallenge(), "https://elsewhere.test"))).toEqual({
    refused: "not an assertion from the owner's origin",
  });
  expect(await admitAuthor(store.base, await newAuthor(), o.owner, await (await softwarePasskey()).assert(admitChallenge()))).toEqual({
    refused: "another passkey",
  });
  expect(await admitAuthor(store.base, await newAuthor(), o.owner, await o.passkey.assert(`dai admit v1:${Date.now() - 3_600_000}:${b64u(new Uint8Array(16))}`))).toEqual({
    refused: "a stale challenge",
  });

  // The keychain: an Ed25519 signature, by the key the keychain secret derives, over a challenge naming the author.
  const byKeychain = await newAuthor();
  const named = `${admitChallenge()}:${byKeychain.id}`;
  const signature = b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, o.verifier.privateKey, utf8(named))));
  expect(await admitAuthor(store.base, byKeychain, o.owner, { kind: "keychain", challenge: named, signature })).toMatchObject({ author: byKeychain.id });
  // The same proof for another author: refused, whoever signs the request.
  expect(await admitAuthor(store.base, await newAuthor(), o.owner, { kind: "keychain", challenge: named, signature })).toEqual({
    refused: "the proof names another author",
  });
  // A keychain secret that is not the owner's.
  const wrong = await keychainVerifier(utf8("not the secret"));
  const other = await newAuthor();
  const claim = `${admitChallenge()}:${other.id}`;
  expect(
    await admitAuthor(store.base, other, o.owner, {
      kind: "keychain",
      challenge: claim,
      signature: b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, wrong.privateKey, utf8(claim)))),
    }),
  ).toEqual({ refused: "the keychain proof does not verify" });

  const listed = (await libraryOf(store.base, recovering, o.owner)) as { authors: Record<string, string> };
  expect(Object.keys(listed.authors).sort()).toEqual([o.first.id, recovering.id, byKeychain.id].sort());
});

/** Every way the host writes bytes into a request or a value: raw, base64, base64url, hex, at each alignment. */
function encodingsOf(plant: string): string[] {
  const bytes = Buffer.from(plant, "utf8");
  const out = new Set<string>([plant, bytes.toString("hex"), bytes.toString("hex").toUpperCase()]);
  for (let pad = 0; pad < 3; pad += 1) {
    const b64 = Buffer.concat([Buffer.alloc(pad, 0x20), bytes]).toString("base64");
    // The characters that depend on the plant alone, whatever came before it.
    const core = b64.slice(Math.ceil((pad * 4) / 3) + 1, -4);
    out.add(core);
    out.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...out];
}

function found(haystacks: Buffer[], plants: string[]): string[] {
  const text = haystacks.map((h) => h.toString("latin1"));
  const utf = haystacks.map((h) => h.toString("utf8"));
  return plants.filter((plant) => encodingsOf(plant).some((needle) => text.some((t) => t.includes(needle)) || utf.some((t) => t.includes(needle))));
}

/*
 * A release's container is about 1 MB, and the envelope carries it with a
 * database, base64url inside JSON: an envelope near 1.4 MB. Over the wire a
 * store keeping it as one object value answers the same (on 28 October the
 * deployed object held a 4.2 MB value and served it), so where the bytes are
 * is read from the local test store, which runs the same object code.
 */
test("a 1 MB container round-trips: its envelope's bytes kept apart, and the objects hold only the chain", async () => {
  const o = await newOwner(store);
  const d = await newDocument(store, o, o.first);
  const container = `<!doctype html>${b64u(new Uint8Array(Array.from({ length: 12 }, () => [...crypto.getRandomValues(new Uint8Array(65_536))]).flat()))}`;
  const database = crypto.getRandomValues(new Uint8Array(65_536));
  revision += 1;
  const checkpoint: Checkpoint = { release: "r".repeat(43), document: d.document, revision, database: await digestOf(database), parents: [] };
  const sealed = await sealEnvelope({ owner: o.owner, document: d.document, author: o.first.id, parents: [] }, { checkpoint, title: "Notes", database, container }, d.dataKey, o.first);
  expect(sealed.bytes.byteLength, "an envelope past 128 KiB, a key-value object's value limit").toBeGreaterThan(1_000_000);

  expect(ack(await appendEnvelope(store.base, o.first, o.owner, d.document, sealed.bytes, "head"))).toMatchObject({ result: "head", digest: sealed.digest });
  const heads = (await headsOf(store.base, o.first, o.owner, d.document)) as { heads: { digest: string }[] };
  expect(heads.heads.map((h) => h.digest)).toEqual([sealed.digest]);
  const got = await getEnvelope(store.base, o.first, o.owner, d.document, sealed.digest);
  expect(isRefused(got), JSON.stringify(got).slice(0, 200)).toBe(false);
  const bytes = (got as { bytes: Uint8Array }).bytes;
  expect(await digestOf(bytes), "the same bytes back").toBe(sealed.digest);
  const opened = await openEnvelope(bytes, d.dataKey);
  expect(opened.inside.container).toBe(container);
  expect(Buffer.from(opened.database).equals(Buffer.from(database))).toBe(true);

  if (DEPLOYED) return;
  // The bytes are in the bucket, once, and no object value holds them, or anything near an envelope's size.
  expect(store.bucket().filter((held) => held.bytes.equals(Buffer.from(sealed.bytes))), "the envelope in the bucket").toHaveLength(1);
  const largest = store.values().reduce((top, held) => (held.bytes.byteLength > top.bytes.byteLength ? held : top));
  expect(largest.bytes.byteLength, `the largest object value, ${largest.object} ${largest.key}`).toBeLessThan(16 * 1024);
});

test("the store holds nothing it can read: planted values appear nowhere it holds or was sent", async () => {
  test.skip(DEPLOYED !== "", "what a deployed store holds and was sent is not readable from here; the local test store answers it");
  const PLANTS = {
    record: "PLANTED-RECORD-q7Zx",
    history: "PLANTED-DELETED-k3Wv",
    alternativeA: "PLANTED-ALT-A-m9Ty",
    alternativeB: "PLANTED-ALT-B-p4Rs",
    title: "PLANTED-TITLE-h2Nc",
  };
  // A real document on the runtime's own engine: a record, a value overwritten
  // so it lives only in the change log's history, and a disagreement left pending.
  const { a, b } = await twoCopies();
  a.db.exec(`UPDATE items SET title = '${PLANTS.record}' WHERE id = ${item(a, "Map")}`);
  a.db.exec(`UPDATE items SET title = '${PLANTS.history}' WHERE id = ${item(a, "Rope")}`);
  a.save();
  a.db.exec(`UPDATE items SET title = 'plain' WHERE title = '${PLANTS.history}'`);
  const stove = item(a, "Stove");
  a.db.exec(`UPDATE items SET title = '${PLANTS.alternativeA}' WHERE id = ${stove}`);
  b.db.exec(`UPDATE items SET title = '${PLANTS.alternativeB}' WHERE id = ${stove}`);
  a.save();
  b.save();
  await a.mergeFrom(await b.bytes());
  const database = await a.bytes();
  expect(a.db.selectValue("SELECT count(*) FROM items WHERE title = ?", [PLANTS.history]), "the overwritten value is no record's").toBe(0);
  expect(a.flags().filter((f) => f.kind === "pending").length, "the disagreement is pending").toBeGreaterThan(0);
  // The search finds every plant where it is: in the database, in the clear.
  expect(found([Buffer.from(database)], Object.values(PLANTS).filter((p) => p !== PLANTS.title))).toEqual(
    Object.values(PLANTS).filter((p) => p !== PLANTS.title),
  );
  a.close();
  b.close();

  // Enrollment, saves on two authors, and a recovery.
  const o = await newOwner(store);
  const d = await newDocument(store, o, o.first);
  const seal = async (by: Author, parents: string[]) => {
    revision += 1;
    const checkpoint = { release: "r".repeat(43), document: d.document, revision, database: await digestOf(database), parents: [] };
    return sealEnvelope({ owner: o.owner, document: d.document, author: by.id, parents }, { checkpoint, title: PLANTS.title, database }, d.dataKey, by);
  };
  const first = await seal(o.first, []);
  ack(await appendEnvelope(store.base, o.first, o.owner, d.document, first.bytes, "head"));
  const second = await newAuthor();
  ack(await admitAuthor(store.base, second, o.owner, await o.passkey.assert(admitChallenge())));
  const next = await seal(second, [first.digest]);
  ack(await appendEnvelope(store.base, second, o.owner, d.document, next.bytes, "head"));
  // A recovery: a new author by the keychain, then the library, the heads and the envelope.
  const recovering = await newAuthor();
  const named = `${admitChallenge()}:${recovering.id}`;
  ack(
    await admitAuthor(store.base, recovering, o.owner, {
      kind: "keychain",
      challenge: named,
      signature: b64u(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, o.verifier.privateKey, utf8(named)))),
    }),
  );
  expect(((await libraryOf(store.base, recovering, o.owner)) as { documents: string[] }).documents).toEqual([d.document]);
  const heads = (await headsOf(store.base, recovering, o.owner, d.document)) as { heads: { digest: string }[] };
  expect(heads.heads.map((h) => h.digest)).toEqual([next.digest]);
  expect(await getEnvelope(store.base, recovering, o.owner, d.document, next.digest)).toHaveProperty("bytes");

  const everything = [...store.held(), ...store.received().flatMap((r) => [Buffer.from(r.url), Buffer.from(JSON.stringify(r.headers)), r.body])];
  expect(everything.length).toBeGreaterThan(20);
  expect(found(everything, Object.values(PLANTS)), "no planted value in anything the store holds or received").toEqual([]);

  // Nor anything that opens what it holds: the secrets, the owner key, the data key.
  const raw = async (key: CryptoKey) => Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", key))).toString("latin1");
  const secrets = [Buffer.from(o.prf).toString("latin1"), o.keychainSecret, await raw(o.ownerKey), await raw(d.dataKey)];
  const haystack = everything.map((h) => h.toString("latin1"));
  for (const secret of secrets) {
    const forms = [secret, Buffer.from(secret, "latin1").toString("base64").slice(0, 40), b64u(new Uint8Array(Buffer.from(secret, "latin1"))).slice(0, 40)];
    expect(forms.some((f) => haystack.some((h) => h.includes(f))), "no secret that opens a wrap").toBe(false);
  }
});
