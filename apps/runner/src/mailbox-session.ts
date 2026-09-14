/**
 * The host's mailbox loop for one mounted document (Track 5).
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
 * advancing the watermark only on the ack. Pull reads what is new, opens each
 * batch, and hands the plaintext to the frame to merge the same way a file
 * merges.
 *
 * **One mailbox per session (T1-D30, backlog D8).** A session document's rows
 * travel in one mailbox per session, each addressed and keyed by
 * `deriveSessionMailbox(root, sessionId)`: the key needs the session id, so
 * the document key alone opens nothing, and the address needs the root, so a
 * relay cannot tell that two sessions share a document or a person. Each is a
 * "lane" below, with its own watermark and cursor. A plain replicated document
 * has no sessions and keeps one lane, as slice one did.
 *
 * **Moving a device over, decided rather than discovered.** A device that ran
 * the per-document mailbox kept state for it. For a session document that state
 * is not carried over: each session lane starts at watermark 0, so its whole
 * history is published once to the new address — harmless, because a merge
 * ignores a row it already holds — and a peer on the new opener catches up from
 * it. The old per-document mailbox is still *drained* (read, never written) on
 * a device that kept state for it, so nothing a not-yet-updated peer sent is
 * lost. A peer still on the old opener stops hearing new moves until it
 * reopens, which updates it (the shell is network-first); re-sharing a link is
 * the recovery that does not wait for that.
 *
 * **Older documents keep what they had.** A document runs the runtime it was
 * built with, and a frame older than this does not answer the sessions
 * question — so when no answer comes, the document keeps its single
 * per-document mailbox, and two copies of it still agree with each other.
 */
import { catchUp, publishSealed } from "../../../src/mailbox-sync.js";
import { deriveSessionMailbox, openBatch, sealBatch, type Mailbox } from "../../../src/mailbox.js";
import { loadMailbox, saveMailbox, type MailboxRecord } from "./opfs.js";

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const fromHex = (text: string): Uint8Array => {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * The key the per-document mailbox seals under, derived from the document's
 * root key under a fixed label. Kept for plain replicated documents, for older
 * documents, and to drain what a session document's old mailbox still holds.
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

/** The per-document mailbox's label. Session lanes derive their own (T1-D30). */
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
 * fast tick is almost all wasted requests. Only while the tab is visible;
 * hidden, there is nobody to show a move to, so it waits at the slow rate.
 */
const POLL_FAST_MS = 3_000;
const POLL_MED_MS = 15_000;
const POLL_SLOW_MS = 30_000;
const POLL_FAST_WINDOW_MS = 60_000;
const POLL_MED_WINDOW_MS = 180_000;

type Any = Record<string, unknown>;

/** One mailbox, with its own place in it. */
interface Lane {
  /** Where its state is kept: the document's uuid, or `<uuid>/<session hex>`. */
  name: string;
  /** Its name at the relay. */
  address: string;
  /** The session it carries, as hex, for a session lane. */
  session?: string;
  /** The old per-document mailbox of a session document: drained, never written. */
  inboundOnly: boolean;
  key: () => Promise<Uint8Array>;
  state: MailboxRecord;
  ready: Promise<void>;
  publishing: boolean;
  publishAgain: boolean;
  /** The frame had nothing above the watermark at the last ask, and nothing has been authored since. */
  upToDate: boolean;
  /** Its session closed and it has published and read all it will: no more polling, no push. */
  retired: boolean;
}

export function startMailboxSession(config: {
  documentUuid: string;
  keyBase64Url: string;
  mailbox: Mailbox;
  frame: Window;
  sessionNonce: string;
  /** The document declares a session profile, so its rows travel per session. */
  sessions?: boolean;
  /**
   * The mounted runtime announced (in its handshake) that it scopes a batch to
   * one session. Without it a session document's runtime is older than
   * per-session mailboxes and keeps the one per-document mailbox it has always
   * had. This is the only thing that chooses between the two: no timer does.
   */
  sessionLanes?: boolean;
  /** A lane's session closed and the lane has stopped: release its push. */
  onLaneClosed?: (address: string) => void;
  /**
   * Writes the document to this device's storage and says whether it landed.
   * A pull calls it before its cursor moves: see `pullLane`.
   */
  persist?: () => Promise<boolean>;
  /** The relay's base, written into each lane's record for the service worker's push check. */
  relay?: string;
  /** A lane this session writes to is running: the place to ask for push on its address. */
  onLane?: (address: string) => void;
  onNote?: (message: string) => void;
}): MailboxSession | null {
  let rootKey: Uint8Array;
  try {
    rootKey = fromBase64Url(config.keyBase64Url);
    if (rootKey.byteLength !== 32) return null;
  } catch {
    return null;
  }
  let documentKeyPromise: Promise<Uint8Array> | null = null;
  const documentMailboxKey = (): Promise<Uint8Array> =>
    (documentKeyPromise ??= deriveMailboxKey(rootKey, MAILBOX_LABEL));

  const { documentUuid, mailbox, frame, sessionNonce } = config;
  const lanes = new Map<string, Lane>();
  /**
   * One mailbox per session, or one for the whole document — decided here, once,
   * from what the runtime is. It used to be decided by a three-second wait for
   * the frame's answer, and a late answer on a slow phone sent the whole visit
   * back to the per-document mailbox, publishing every game's rows under the
   * document key: a privacy regression triggered by timing. Now a runtime that
   * can scope batches waits for its answer however long it takes, and syncs
   * nothing until it has one.
   */
  const mode: "sessions" | "document" = config.sessions && config.sessionLanes ? "sessions" : "document";
  if (config.sessions && !config.sessionLanes) {
    // A session document built before per-session mailboxes: its runtime cannot
    // keep one game's rows out of another's mailbox, and nothing here can change
    // that for the file as built. Said, not hidden.
    config.onNote?.(
      "Every game in this copy shares one mailbox, so anyone with a link to it can read them all. " +
        "Games in a copy made with the current version each have their own.",
    );
  }
  /** Sessions the frame says have closed. */
  let closed = new Set<string>();
  let legacyChecked = false;
  let stopped = false;
  let publishTimer: number | undefined;
  let pulling = false;
  let pollTimer: number | undefined;
  let lastActivity = Date.now();
  let requestId = 0;
  const pending = new Map<string, (value: Any) => void>();

  const post = (message: Any): void => {
    frame.postMessage({ ...message, sessionNonce }, "*");
  };

  /** Post a request to the frame and wait for the reply carrying the same id; `{}` if none comes. */
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
      for (const lane of lanes.values()) lane.upToDate = false;
      schedulePublish();
      pollNow(); // a local move; the reply is likely soon, so poll fast again.
      return;
    }
    if (type === "DAI_HOST_AUTHORED_BATCH" || type === "DAI_HOST_APPLIED" || type === "DAI_HOST_SESSIONS_ANSWER") {
      const resolver = pending.get(String(data["id"]) + String(type));
      if (resolver) {
        pending.delete(String(data["id"]) + String(type));
        resolver(data);
      }
    }
  };

  const save = (lane: Lane): void => {
    void saveMailbox(lane.state);
  };

  function makeLane(name: string, address: string, key: () => Promise<Uint8Array>, session: string | undefined, inboundOnly: boolean): Lane {
    const lane: Lane = {
      name,
      address,
      session,
      inboundOnly,
      key,
      state: {
        documentUuid: name,
        key: config.keyBase64Url,
        watermark: { replica: "", seq: 0 },
        cursor: "",
        pending: null,
        address,
        ...(config.relay ? { relay: config.relay } : {}),
      },
      ready: Promise.resolve(),
      publishing: false,
      publishAgain: false,
      upToDate: false,
      retired: false,
    };
    lane.ready = (async () => {
      const saved = await loadMailbox(name);
      if (saved && saved.key === config.keyBase64Url) {
        // Kept state, with where it lives written down for the service worker.
        lane.state = { ...saved, address, ...(config.relay ? { relay: config.relay } : {}) };
        if (saved.address !== address || saved.relay !== config.relay) save(lane);
      } else save(lane); // first time, or a re-keyed document: write the key down.
      if (lane.state.closed) {
        // Stopped on an earlier visit: it stays stopped, and its push stays released.
        lane.retired = true;
        config.onLaneClosed?.(address);
        return;
      }
      if (!lane.inboundOnly) config.onLane?.(address);
      if (lane.inboundOnly) {
        // Drained, never written: an unacked batch for it is dropped, because the
        // rows it held are published again to their session's own mailbox.
        if (lane.state.pending) {
          lane.state = { ...lane.state, pending: null };
          save(lane);
        }
        return;
      }
      if (lane.state.pending) {
        try {
          await publishSealed(mailbox, lane.address, lane.state.pending.sealed);
          lane.state = {
            ...lane.state,
            watermark: { replica: lane.state.pending.replica, seq: lane.state.pending.head },
            pending: null,
          };
          save(lane);
        } catch {
          /* Still unreachable; stays pending. */
        }
      }
    })();
    return lane;
  }

  /** Brings the set of lanes up to date with the sessions the frame holds now. */
  async function refreshLanes(): Promise<void> {
    if (stopped) return;
    if (mode === "document") {
      if (!lanes.has(documentUuid)) lanes.set(documentUuid, makeLane(documentUuid, documentUuid, documentMailboxKey, undefined, false));
      return;
    }
    const answer = await ask({ type: "DAI_HOST_SESSIONS" }, "DAI_HOST_SESSIONS_ANSWER");
    if (stopped) return;
    // No answer yet: keep the lanes already running and ask again next time.
    // Never a reason to fall back to the per-document mailbox.
    if (!Array.isArray(answer["sessions"])) return;
    if (Array.isArray(answer["closed"])) {
      closed = new Set((answer["closed"] as unknown[]).filter((s): s is string => typeof s === "string"));
    }
    if (!legacyChecked) {
      legacyChecked = true;
      const legacy = await loadMailbox(documentUuid);
      if (legacy && legacy.key === config.keyBase64Url) {
        lanes.set(documentUuid, makeLane(documentUuid, documentUuid, documentMailboxKey, undefined, true));
      }
    }
    for (const session of answer["sessions"] as unknown[]) {
      if (typeof session !== "string" || !/^[0-9a-f]{32}$/.test(session)) continue;
      const name = `${documentUuid}/${session}`;
      if (lanes.has(name)) continue;
      const derived = await deriveSessionMailbox(rootKey, fromHex(session));
      lanes.set(name, makeLane(name, derived.id, async () => derived.key, session, false));
    }
  }

  /**
   * A lane whose session has closed stops, once nothing of it is left to send or
   * read: the close row this copy authored has been published (the frame had
   * nothing above the watermark and nothing is pending), and the last pull has
   * run. Its record is kept, marked closed, so it does not start again.
   */
  function retireIfDone(lane: Lane): void {
    if (lane.retired || lane.inboundOnly || !lane.session || !closed.has(lane.session)) return;
    if (!lane.upToDate || lane.publishing || lane.state.pending) return;
    lane.retired = true;
    lane.state = { ...lane.state, closed: true };
    save(lane);
    config.onLaneClosed?.(lane.address);
  }

  async function publishLane(lane: Lane): Promise<void> {
    if (stopped || lane.inboundOnly) return;
    await lane.ready;
    if (lane.retired) return;
    if (lane.publishing) {
      lane.publishAgain = true;
      return;
    }
    lane.publishing = true;
    try {
      // Ask the frame for the rows it authored above the watermark — in this
      // session only, for a session lane. The frame answers with the replica
      // this copy authored under, so the watermark rebinds to it.
      const answer = await ask(
        {
          type: "DAI_HOST_AUTHORED_SINCE",
          seq: lane.state.watermark.seq,
          replica: lane.state.watermark.replica,
          ...(lane.session ? { session: lane.session } : {}),
        },
        "DAI_HOST_AUTHORED_BATCH",
      );
      const batchBytes = answer["batch"];
      const head = Number(answer["head"] ?? lane.state.watermark.seq);
      const replica = String(answer["replica"] ?? lane.state.watermark.replica);
      if (batchBytes instanceof Uint8Array && batchBytes.byteLength > 0) {
        const sealed = await sealBatch(batchBytes, await lane.key());
        // Persisted before the send, so a kill mid-publish resumes it.
        lane.state = { ...lane.state, pending: { sealed, head, replica } };
        save(lane);
        try {
          await publishSealed(mailbox, lane.address, sealed);
          lane.state = { ...lane.state, watermark: { replica, seq: head }, pending: null };
          save(lane);
          lane.upToDate = !lane.publishAgain;
        } catch {
          config.onNote?.("A move could not be sent yet; it will send when the connection returns.");
        }
      } else {
        if (replica !== lane.state.watermark.replica || head > lane.state.watermark.seq) {
          lane.state = { ...lane.state, watermark: { replica, seq: head } };
          save(lane);
        }
        // Answered, and nothing to send.
        if ("head" in answer) lane.upToDate = !lane.publishAgain;
      }
    } finally {
      lane.publishing = false;
      if (lane.publishAgain && !stopped) {
        lane.publishAgain = false;
        void publishLane(lane);
      } else {
        retireIfDone(lane);
      }
    }
  }

  async function runPublish(): Promise<void> {
    await refreshLanes().catch(() => undefined);
    // One at a time: each is a question to the frame and a request to the relay.
    for (const lane of [...lanes.values()]) await publishLane(lane);
  }

  function schedulePublish(): void {
    if (stopped) return;
    window.clearTimeout(publishTimer);
    publishTimer = window.setTimeout(() => void runPublish(), PUBLISH_DEBOUNCE_MS);
  }

  async function pullLane(lane: Lane): Promise<void> {
    await lane.ready;
    if (lane.retired) return;
    const next = await catchUp(
      mailbox,
      lane.address,
      lane.state.cursor,
      async (sealed) => openBatch(sealed, await lane.key()),
      async (plaintext) => {
        await ask({ type: "DAI_HOST_APPLY_BATCH", batch: plaintext }, "DAI_HOST_APPLIED");
      },
    );
    if (next !== lane.state.cursor) {
      /*
       * The cursor moves only once what it moves past is stored.
       *
       * A batch merges into the frame's database in memory, and the frame saves
       * that to this device a moment later on its own timer. The cursor used to
       * be written straight after the merge, so a page killed in between — which
       * is what iOS does to a page in the background — kept a cursor saying the
       * move was read and a stored database without it, and every later pull
       * started after the move: lost on this device for good. So the document is
       * flushed first, and a flush that does not confirm leaves the cursor
       * where it was; the next pull fetches those batches again, and the merge
       * skips the rows it already has.
       */
      if (config.persist && !(await config.persist())) return;
      lane.state = { ...lane.state, cursor: next };
      save(lane);
    }
    retireIfDone(lane);
  }

  /**
   * Every lane, one after another — never two at once, because each batch is a
   * merge transaction in the frame and two cannot be open together.
   */
  async function runPull(onlyIfMoved = false): Promise<boolean> {
    if (stopped || pulling) return false;
    pulling = true;
    let moved = false;
    try {
      await refreshLanes().catch(() => undefined);
      for (const lane of [...lanes.values()]) {
        if (stopped) break;
        try {
          await lane.ready;
          if (lane.retired) continue;
          if (onlyIfMoved) {
            // The cheap check: only `head`, a 304 when unchanged. A closed
            // session that has not stopped yet is read in full, so that it can.
            if (lane.session && closed.has(lane.session)) {
              await pullLane(lane);
              continue;
            }
            const head = Number(await mailbox.head(lane.address)) || 0;
            if (head <= (Number(lane.state.cursor) || 0)) continue;
          }
          await pullLane(lane);
          moved = true;
        } catch {
          // That mailbox was unreachable; its cursor is unmoved and the next tick tries again.
        }
      }
    } finally {
      pulling = false;
    }
    return moved;
  }

  /**
   * Timer ticks that have run to the end, counted so a test can wait for the
   * poll to have actually happened rather than for time to pass and hope it
   * did.
   */
  let polls = 0;

  function schedulePoll(ms: number): void {
    if (stopped) return;
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(() => void runPoll(), ms);
  }

  /** The rate now, from how long since anyone last acted. */
  function pollRate(): number {
    const idle = Date.now() - lastActivity;
    return idle < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : idle < POLL_MED_WINDOW_MS ? POLL_MED_MS : POLL_SLOW_MS;
  }

  /** Mark activity — a local move, a received move, or a foreground — and poll now. */
  function pollNow(): void {
    lastActivity = Date.now();
    schedulePoll(0);
  }

  /**
   * The steady floor between foregrounds and interactions: pull only where a
   * mailbox has moved past what this copy holds. A timer alone is not enough on
   * iOS, which throttles an idle page's timers — hands-off delivery to an idle
   * phone is what push is for.
   */
  async function runPoll(): Promise<void> {
    if (stopped) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      schedulePoll(POLL_SLOW_MS);
      return;
    }
    if (await runPull(true)) lastActivity = Date.now(); // something arrived; a reply may be next.
    polls += 1;
    schedulePoll(pollRate());
  }

  // Find the mailboxes, read anything that arrived while this copy was away,
  // publish anything authored before the session was listening, then look for
  // the other copy's moves on its own.
  void (async () => {
    await runPull();
    schedulePublish();
    schedulePoll(POLL_FAST_MS);
  })();

  window.addEventListener("message", onMessage);

  return {
    get polls() {
      return polls;
    },
    pull: () => {
      // Foreground or interaction: catch up now, and go back to the fast rate.
      lastActivity = Date.now();
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
