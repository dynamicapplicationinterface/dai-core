/**
 * Keeping beyond this browser (R-Z sentences 2 and 4, R-C; docs/store.md).
 *
 * After a save lands here, for a document wrapped under the owner signed in,
 * the revision is sealed into an envelope (its checkpoint signed by this
 * context's author key, sealed under the document's data key, chained to the
 * last checkpoint the store acknowledged) and appended. The store's answer is
 * the receipt, and it is held to what was sent: it must name the digest this
 * host computed for the envelope of that revision, for that owner and
 * document, or it acknowledges nothing. Only a receipt that holds is recorded,
 * and it is the only source of "Kept".
 *
 * One append at a time per document. A save that lands while one is in flight
 * waits, and only the newest waiting revision is sent next, so a store that is
 * slow or away is never sent a backlog: when it answers again, the latest
 * revision is what it is asked to keep. Nothing here holds a save up, and a
 * failure here loses nothing a save wrote.
 *
 * An envelope sent and not answered may be held by the store all the same: its
 * answer can be lost on the way back. So it is kept here until an answer
 * comes, and sent again byte for byte before anything newer is sealed; the
 * store answers an envelope it holds as it did the first time (docs/store.md),
 * and a lost answer never forks a document against itself.
 */
import { KEYS, dataKeyKey, keptKey, ownerRecordKey, sendingKey } from "../../../src/keys.js";
import { checkpointDigest, digestOf, sealEnvelope, utf8, type Author, type Checkpoint } from "../../owner-store/src/envelope.js";
import { appendEnvelope, enrollOwner, isRefused, isUnavailable, putKey, type Ack } from "../../owner-store/src/client.js";
import { dropFromKeyStore, keepInKeyStore, keptInKeyStore } from "./opfs.js";
import { person } from "./person.js";
import type { DataKeyRecord, OwnerRecord } from "./owner.js";

/** What the store last acknowledged for a document, from this browser context. */
export interface KeptRecord {
  owner: string;
  revision: number;
  /** The envelope's digest: the parent of the next append. */
  digest: string;
  /** The checkpoint's digest: the parent of the next checkpoint. */
  checkpoint: string;
  /** The release the checkpoint names, so the container travels only when it changes. */
  release: string;
  /** The store's time for it, ISO 8601. */
  at: string;
  /** Appended as the head, or kept as a branch after the head moved elsewhere. */
  as: "head" | "branch";
}

/** An envelope sent and not yet answered: resent as it is, never sealed afresh. */
interface Sending extends Omit<KeptRecord, "at"> {
  bytes: Uint8Array;
}

/** One revision as a save landed it. */
export interface Revision {
  documentUuid: string;
  revision: number;
  database: Uint8Array;
  /** The container as this host keeps it, carried when the release changes. */
  html: string;
  title: string;
  /** What names the release: the container's signature, or none for an unsigned one. */
  build: string | undefined;
}

/*
 * The page's own address for the store, or one a test injects before the page
 * loads through `window.__daiOwnerStore`, the same move as `__daiStore`: an
 * injected address holds across the reloads a test drives, as a deploy's does.
 */
const injectedBase = (window as unknown as { __daiOwnerStore?: unknown }).__daiOwnerStore;
let base: string | undefined =
  (typeof injectedBase === "string" && injectedBase.trim()) ||
  document.querySelector('meta[name="dai-store"]')?.getAttribute("content")?.trim() ||
  undefined;

/** The store's address, or undefined when this opener has none: then nothing is kept beyond this browser, nor offered. */
export const storeBase = (): string | undefined => base;

/** A test points the opener at the store it stands up. */
export function useStore(next: string | undefined): void {
  base = next;
}

/** What happened to each append, for a test that must see a receipt refused. */
export const keepingLog: { sent: number; kept: number; refusedReceipts: number; unavailable: number; refused: number; last: string } = {
  sent: 0,
  kept: 0,
  refusedReceipts: 0,
  unavailable: 0,
  refused: 0,
  last: "",
};

/**
 * Why the store last refused to keep a document, until a revision of it is
 * kept: a refusal retrying cannot correct, which the opener says (docs/store.md,
 * "Failure"). An unavailable store is not a refusal, and says nothing.
 */
const refusals = new Map<string, string>();
export const storeRefused = (documentUuid: string): string | undefined => refusals.get(documentUuid);

const listeners = new Set<(documentUuid: string) => void>();
/** Called when a document's kept record, or whether the store is reached, changes. */
export function onKept(listener: (documentUuid: string) => void): void {
  listeners.add(listener);
}
const tell = (documentUuid: string): void => {
  for (const listener of listeners) listener(documentUuid);
};

export async function keptOf(documentUuid: string): Promise<KeptRecord | null> {
  return (await keptInKeyStore<KeptRecord>(keptKey(documentUuid))) ?? null;
}

/**
 * Whether an answer is the store's acknowledgment of exactly what was sent:
 * an acknowledgment, as the head or a branch, naming the digest computed here
 * for the envelope sent, for this owner and document, at a time that parses.
 * Anything else, a receipt for another revision or for none, is refused.
 */
export function receiptHolds(sent: { digest: string; owner: string; document: string; as: "head" | "branch" }, answer: unknown): answer is Ack {
  if (!answer || typeof answer !== "object") return false;
  const ack = answer as Partial<Ack>;
  return (
    (ack.result === "head" || ack.result === "branch") &&
    ack.result === sent.as &&
    ack.digest === sent.digest &&
    ack.owner === sent.owner &&
    ack.document === sent.document &&
    typeof ack.at === "string" &&
    Number.isFinite(Date.parse(ack.at))
  );
}

const waiting = new Map<string, Revision>();
const running = new Set<string>();

/** Asks for a landed revision to be kept. Returns at once; the append runs behind it. */
export function keepRevision(revision: Revision): void {
  waiting.set(revision.documentUuid, revision);
  if (!running.has(revision.documentUuid)) void pump(revision.documentUuid);
}

/** Tries the newest waiting revision of a document again: after the store comes back, for instance. */
export function keepAgain(documentUuid: string): void {
  if (!running.has(documentUuid) && waiting.has(documentUuid)) void pump(documentUuid);
}

/** Every document with a revision still waiting for the store. */
export const waitingDocuments = (): string[] => [...waiting.keys()];

async function pump(documentUuid: string): Promise<void> {
  running.add(documentUuid);
  try {
    for (;;) {
      const next = waiting.get(documentUuid);
      if (!next) return;
      const outcome = await appendOne(next).catch((error: unknown) => {
        console.warn(`dai: keep of ${documentUuid} r${next.revision} failed: ${String(error)}`);
        return "failed" as const;
      });
      // A revision that is kept, refused for good, or not ours to keep, waits no longer; an unavailable store keeps it waiting.
      if (outcome === "unavailable") return;
      if (waiting.get(documentUuid) === next) waiting.delete(documentUuid);
    }
  } finally {
    running.delete(documentUuid);
  }
}

async function authorHere(): Promise<Author> {
  const me = await person();
  return { privateKey: me.keys.privateKey, pub: me.pub, id: me.author };
}

/** One append, and what came of it. */
async function appendOne(revision: Revision): Promise<"kept" | "not ours" | "unavailable" | "refused"> {
  const at = base;
  if (!at) return "not ours";
  const signedIn = await keptInKeyStore<string>(KEYS.OWNER);
  const owner = signedIn ? await keptInKeyStore<OwnerRecord>(ownerRecordKey(signedIn)) : undefined;
  const dataKey = await keptInKeyStore<DataKeyRecord>(dataKeyKey(revision.documentUuid));
  if (!owner || !dataKey?.wrapped || dataKey.owner !== owner.owner) return "not ours";
  const author = await authorHere();
  const unavailable = (why: string): "unavailable" => {
    keepingLog.unavailable += 1;
    keepingLog.last = `unavailable: ${why}`;
    console.info(`dai: store unavailable for ${revision.documentUuid} r${revision.revision}: ${why}`);
    tell(revision.documentUuid);
    return "unavailable";
  };
  const refused = (why: string): "refused" => {
    keepingLog.refused += 1;
    keepingLog.last = `refused: ${why}`;
    console.info(`dai: store refused ${revision.documentUuid} r${revision.revision}: ${why}`);
    refusals.set(revision.documentUuid, why);
    tell(revision.documentUuid);
    return "refused";
  };

  // The owner, once, before anything of theirs.
  if (!owner.atStore) {
    if (!owner.registration || !owner.verifier) return refused("this owner was enrolled before the store's registration was kept");
    const enrolled = await enrollOwner(at, author, {
      owner: owner.owner,
      credential: { id: owner.credential, publicKey: owner.registration.publicKey, algorithm: owner.registration.algorithm },
      registration: { clientDataJSON: owner.registration.clientDataJSON },
      verifier: owner.verifier,
      wraps: { prf: b64(owner.wraps.prf), keychain: b64(owner.wraps.keychain) },
    });
    if (isUnavailable(enrolled)) return unavailable(enrolled.unavailable);
    if (isRefused(enrolled) && enrolled.refused !== "owner exists") return refused(`enroll: ${enrolled.refused}`);
    await keepInKeyStore(ownerRecordKey(owner.owner), { ...owner, atStore: true } satisfies OwnerRecord);
  }
  // The document's wrapped data key, once.
  if (!dataKey.atStore) {
    const put = await putKey(at, author, owner.owner, revision.documentUuid, dataKey.wrapped);
    if (isUnavailable(put)) return unavailable(put.unavailable);
    if (isRefused(put)) return refused(`key: ${put.refused}`);
    await keepInKeyStore(dataKeyKey(revision.documentUuid), { ...dataKey, atStore: true } satisfies DataKeyRecord);
  }

  /*
   * Sends an envelope and holds the answer to it. Kept here until the store
   * answers: an unavailable store leaves it to be sent again as it is.
   */
  const deliver = async (sending: Sending): Promise<"kept" | "unavailable" | "refused"> => {
    const document = revision.documentUuid;
    keepingLog.sent += 1;
    let answer = await appendEnvelope(at, author, sending.owner, document, sending.bytes, sending.as);
    if (isRefused(answer) && answer.refused === "stale" && sending.as === "head") {
      // The head moved under another context's append: kept as a branch on purpose, nothing dropped (R-B).
      sending = { ...sending, as: "branch" };
      await keepInKeyStore(sendingKey(document), sending);
      answer = await appendEnvelope(at, author, sending.owner, document, sending.bytes, sending.as);
    }
    if (isUnavailable(answer)) return unavailable(answer.unavailable);
    // Answered: whatever it says, these bytes are not sent again.
    await dropFromKeyStore(sendingKey(document));
    if (isRefused(answer)) return refused(answer.refused);
    if (!receiptHolds({ digest: sending.digest, owner: sending.owner, document, as: sending.as }, answer)) {
      keepingLog.refusedReceipts += 1;
      keepingLog.last = `receipt refused: names ${String((answer as Partial<Ack>).digest)}, sent ${sending.digest}`;
      console.warn(`dai: the store's receipt for ${document} r${sending.revision} is not for what was sent; nothing is kept`);
      refusals.set(document, "a receipt for something not sent");
      tell(document);
      return "refused";
    }
    const { bytes: _bytes, ...kept } = sending;
    await keepInKeyStore(keptKey(document), { ...kept, at: answer.at } satisfies KeptRecord);
    keepingLog.kept += 1;
    keepingLog.last = `kept r${sending.revision} ${sending.digest} as ${sending.as}`;
    console.info(`dai: kept ${document} r${sending.revision} (${sending.as}) at ${answer.at}`);
    refusals.delete(document);
    tell(document);
    return "kept";
  };

  // An envelope sent before and never answered goes first, as it was sealed.
  const unanswered = await keptInKeyStore<Sending>(sendingKey(revision.documentUuid));
  if (unanswered && unanswered.owner === owner.owner) {
    console.info(`dai: resending ${revision.documentUuid} r${unanswered.revision}, never answered`);
    const outcome = await deliver(unanswered);
    if (outcome !== "kept") return outcome;
  } else if (unanswered) await dropFromKeyStore(sendingKey(revision.documentUuid));

  const last = await keptOf(revision.documentUuid);
  const parent = last && last.owner === owner.owner ? last : null;
  if (parent && parent.revision >= revision.revision) return "kept";
  const release = await digestOf(utf8(revision.build ?? "unsigned"));
  const checkpoint: Checkpoint = {
    release,
    document: revision.documentUuid,
    revision: revision.revision,
    database: await digestOf(revision.database),
    parents: parent ? [parent.checkpoint] : [],
  };
  const sealed = await sealEnvelope(
    { owner: owner.owner, document: revision.documentUuid, author: author.id, parents: parent ? [parent.digest] : [] },
    {
      checkpoint,
      title: revision.title,
      database: revision.database,
      ...(!parent || parent.release !== release ? { container: revision.html } : {}),
    },
    dataKey.key,
    author,
  );
  // A line already branched stays a branch until the host reconciles it (R-F as R-Z amends it).
  const sending: Sending = {
    owner: owner.owner,
    revision: revision.revision,
    digest: sealed.digest,
    checkpoint: await checkpointDigest(checkpoint),
    release,
    as: parent?.as === "branch" ? "branch" : "head",
    bytes: sealed.bytes,
  };
  // Held before it is sent: an answer lost on the way back finds it here.
  await keepInKeyStore(sendingKey(revision.documentUuid), sending);
  return deliver(sending);
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
