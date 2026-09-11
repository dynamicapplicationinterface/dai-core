/**
 * The host's mailbox loop for one mounted document (Track 5, slice one).
 *
 * The frame authors rows and merges them; this carries them, because the frame
 * cannot reach the network. It is kept out of the mount lifecycle on purpose —
 * that file is where the hard bugs live — so `main.ts` only starts and stops a
 * session and hands it a key, a relay and the frame's window.
 *
 * Publish is host-initiated (the host owns the watermark): a `DAI_HOST_AUTHORED`
 * nudge, debounced, asks the frame for the rows above the watermark, seals
 * them, and re-sends the same bytes until the relay acks — persisting the
 * unacked batch first so an iOS kill resumes rather than loses it, and
 * advancing the watermark only on the ack. Pull, on foreground, reads what is
 * new, opens each batch with the document key, and hands the plaintext to the
 * frame to merge the same way a file merges.
 */
import { catchUp, publishSealed } from "../../../src/mailbox-sync.js";
import { openBatch, sealBatch, type Mailbox } from "../../../src/mailbox.js";
import { loadMailbox, saveMailbox, type MailboxRecord } from "./opfs.js";

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

/**
 * The key the mailbox seals under, derived from the document's root key.
 *
 * The root is never used to seal directly: HKDF derives the mailbox key from it,
 * so a session (Track 3) can key its own mailbox off the same root by deriving
 * under the session id. Slice one has one implicit session, so the info is a
 * fixed label; when sessions land it becomes the session id. Both parties derive
 * the same key from the same root and label, with no round trip.
 */
async function deriveMailboxKey(root: Uint8Array, label: string): Promise<Uint8Array> {
  const hk = await crypto.subtle.importKey("raw", root as unknown as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(label) },
    hk,
    256,
  );
  return new Uint8Array(bits);
}

/** The slice-one mailbox label; becomes the session id when Track 3 lands. */
const MAILBOX_LABEL = "dai:mailbox:v1";

export interface MailboxSession {
  /** Read anything new from the relay and merge it — call on foreground and once on start. */
  pull(): void;
  /** Stop listening and cancel timers; the session holds no more of the page. */
  stop(): void;
}

/**
 * The key a document's mailbox seals under: the one from the link if this open
 * carried it, otherwise the one kept from first arrival.
 *
 * A home-screen launch is `#u=` with no `k`, so most opens rely on the stored
 * key; a link open both uses and (through the session) records it. Returns null
 * for a document that has never arrived by link and so has no mailbox — which
 * is correct, not a failure.
 */
export async function resolveMailboxKey(
  documentUuid: string,
  arrivedKey: string | undefined,
): Promise<string | null> {
  if (arrivedKey) return arrivedKey;
  const saved = await loadMailbox(documentUuid);
  return saved?.key ?? null;
}

const PUBLISH_DEBOUNCE_MS = 500;

/**
 * How often the app looks for the other copy's moves, and how it backs off.
 *
 * Fast in the minute after anyone acts — a reply is usually coming — then it
 * stretches, because a game is two people thinking for minutes and a fixed
 * fast tick is almost all wasted requests. It snaps back to fast on a local
 * write or a pull that found something. The relay is on a request budget; a
 * timer that never backs off is what spends it. Only while the tab is visible;
 * hidden, there is nobody to show a move to, so it waits at the slow rate.
 */
const POLL_FAST_MS = 3_000;
const POLL_MED_MS = 15_000;
const POLL_SLOW_MS = 30_000;

export function startMailboxSession(config: {
  documentUuid: string;
  keyBase64Url: string;
  mailbox: Mailbox;
  frame: Window;
  sessionNonce: string;
  onNote?: (message: string) => void;
}): MailboxSession | null {
  let rootKey: Uint8Array;
  try {
    rootKey = fromBase64Url(config.keyBase64Url);
    if (rootKey.byteLength !== 32) return null;
  } catch {
    return null;
  }
  // Derived once, lazily: the mailbox seals under HKDF(root, label), never the
  // root itself. See deriveMailboxKey.
  let mailboxKeyPromise: Promise<Uint8Array> | null = null;
  const mailboxKey = (): Promise<Uint8Array> =>
    (mailboxKeyPromise ??= deriveMailboxKey(rootKey, MAILBOX_LABEL));

  const { documentUuid, mailbox, frame, sessionNonce } = config;
  let state: MailboxRecord = {
    documentUuid,
    key: config.keyBase64Url,
    watermark: { replica: "", seq: 0 },
    cursor: "",
    pending: null,
  };
  let stopped = false;
  let publishTimer: number | undefined;
  let publishing = false;
  let publishAgain = false;
  let pulling = false;
  let pollTimer: number | undefined;
  let pollMs = POLL_FAST_MS;
  let requestId = 0;
  const pending = new Map<string, (value: Any) => void>();

  type Any = Record<string, unknown>;

  const post = (message: Any): void => {
    frame.postMessage({ ...message, sessionNonce }, "*");
  };

  /** Post a request to the frame and wait for the reply carrying the same id. */
  const ask = (message: Any, replyType: string, timeoutMs = 15_000): Promise<Any> =>
    new Promise((resolve) => {
      const id = `mb${(requestId += 1)}`;
      const timer = window.setTimeout(() => {
        pending.delete(id + replyType);
        resolve({});
      }, timeoutMs);
      pending.set(id + replyType, (data) => {
        window.clearTimeout(timer);
        resolve(data);
      });
      post({ ...message, id });
    });

  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Any;
    if (!data || data["sessionNonce"] !== sessionNonce) return;
    const type = data["type"];
    if (type === "DAI_HOST_AUTHORED") {
      schedulePublish();
      pollNow(); // a local move; the reply is likely soon, so poll fast again.
      return;
    }
    if (type === "DAI_HOST_AUTHORED_BATCH" || type === "DAI_HOST_APPLIED") {
      const resolver = pending.get(String(data["id"]) + String(type));
      if (resolver) {
        pending.delete(String(data["id"]) + String(type));
        resolver(data);
      }
    }
  };

  const save = (): void => {
    void saveMailbox(state);
  };

  async function runPublish(): Promise<void> {
    if (stopped || publishing) {
      publishAgain = true;
      return;
    }
    publishing = true;
    try {
      // Ask the frame for the rows it authored above the watermark. The
      // watermark is a (replica, seq) pair; the frame answers with the replica
      // this copy actually authored under, so the watermark rebinds to it and a
      // seq is never carried across an identity this copy has shed.
      const answer = await ask(
        { type: "DAI_HOST_AUTHORED_SINCE", seq: state.watermark.seq, replica: state.watermark.replica },
        "DAI_HOST_AUTHORED_BATCH",
      );
      const batchBytes = answer["batch"];
      const head = Number(answer["head"] ?? state.watermark.seq);
      const replica = String(answer["replica"] ?? state.watermark.replica);
      if (batchBytes instanceof Uint8Array && batchBytes.byteLength > 0) {
        const sealed = await sealBatch(batchBytes, await mailboxKey());
        // Persisted before the send, so a kill mid-publish resumes it.
        state = { ...state, pending: { sealed, head, replica } };
        save();
        try {
          await publishSealed(mailbox, documentUuid, sealed);
          state = { ...state, watermark: { replica, seq: head }, pending: null };
          save();
        } catch {
          // Left pending; retried on the next nudge, foreground, or start.
          config.onNote?.("A move could not be sent yet; it will send when the connection returns.");
        }
      } else if (replica !== state.watermark.replica || head > state.watermark.seq) {
        // Nothing new to send, but the identity or head moved (a merge caught us
        // up, or this copy took its own id): rebind so the next ask is scoped.
        state = { ...state, watermark: { replica, seq: head } };
        save();
      }
    } finally {
      publishing = false;
      if (publishAgain && !stopped) {
        publishAgain = false;
        void runPublish();
      }
    }
  }

  function schedulePublish(): void {
    if (stopped) return;
    window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => void runPublish(), PUBLISH_DEBOUNCE_MS);
  }

  async function runPull(): Promise<void> {
    if (stopped || pulling) return;
    pulling = true;
    try {
      const next = await catchUp(
        mailbox,
        documentUuid,
        state.cursor,
        async (sealed) => openBatch(sealed, await mailboxKey()),
        async (plaintext) => {
          await ask({ type: "DAI_HOST_APPLY_BATCH", batch: plaintext }, "DAI_HOST_APPLIED");
        },
      );
      if (next !== state.cursor) {
        state = { ...state, cursor: next };
        save();
      }
    } catch {
      // The relay was unreachable; the cursor is unmoved and the next
      // foreground tries again.
    } finally {
      pulling = false;
    }
  }

  function schedulePoll(ms: number): void {
    if (stopped) return;
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void runPoll(), ms);
  }

  /** Reset to the fast rate and poll soon — after a local write, or on foreground. */
  function pollNow(): void {
    pollMs = POLL_FAST_MS;
    schedulePoll(0);
  }

  /**
   * The cheap check: has the mailbox moved past what we hold? Only `head`, which
   * the client turns into a 304 when it is unchanged, so an idle poll costs
   * almost nothing. Pull only when it has actually advanced.
   */
  async function runPoll(): Promise<void> {
    if (stopped) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      schedulePoll(POLL_SLOW_MS);
      return;
    }
    try {
      const head = Number(await mailbox.head(documentUuid)) || 0;
      if (head > (Number(state.cursor) || 0)) {
        await runPull();
        pollMs = POLL_FAST_MS; // something arrived; a reply may be next.
      } else {
        pollMs = pollMs < POLL_MED_MS ? POLL_MED_MS : POLL_SLOW_MS;
      }
    } catch {
      pollMs = POLL_SLOW_MS; // relay unreachable; do not hammer it.
    }
    schedulePoll(pollMs);
  }

  // Resume from what was persisted, re-sending an unacked batch, then read
  // anything that arrived while this copy was away.
  void (async () => {
    const saved = await loadMailbox(documentUuid);
    if (stopped) return;
    if (saved && saved.key === config.keyBase64Url) state = saved;
    else save(); // first time, or a re-keyed document: write the key down.
    if (state.pending) {
      try {
        await publishSealed(mailbox, documentUuid, state.pending.sealed);
        state = {
          ...state,
          watermark: { replica: state.pending.replica, seq: state.pending.head },
          pending: null,
        };
        save();
      } catch {
        /* Still unreachable; stays pending. */
      }
    }
    void runPull();
    // In case rows were authored before the session was listening.
    schedulePublish();
    // And from here it looks for the other copy's moves on its own.
    schedulePoll(pollMs);
  })();

  window.addEventListener("message", onMessage);

  return {
    pull: () => {
      // Foreground: catch up now, and go back to the fast rate.
      pollMs = POLL_FAST_MS;
      void runPull();
      schedulePoll(POLL_FAST_MS);
    },
    stop: () => {
      stopped = true;
      window.clearTimeout(publishTimer);
      window.clearTimeout(pollTimer);
      window.removeEventListener("message", onMessage);
      pending.clear();
    },
  };
}
