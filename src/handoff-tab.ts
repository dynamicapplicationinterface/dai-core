/**
 * Handing a freshly built document straight to the opener, without a download.
 *
 * ## The problem this exists for
 *
 * A phone cannot run a document out of its Files app. So the honest instruction
 * used to be: save it, leave the browser, find it in Files, open the opener,
 * pick it from a file picker. Five steps, each one a place somebody stops. A
 * tester's summary of it was that the flow does not flow, and they were right —
 * nobody does that twice, and most people do not do it once.
 *
 * The bytes already exist in the page that built them. The only reason they
 * were taking a trip through the filesystem is that the builder and the opener
 * are different origins, and an origin cannot hand another origin a file.
 *
 * It can hand it a message. `postMessage` carries a `Uint8Array` by structured
 * clone, so the document goes directly from the tab that built it to the tab
 * that runs it: no download, no file picker, no upload, no server, nothing on
 * the network at all. One tap and somebody is in their app.
 *
 * ## Why this is one file
 *
 * A handshake is a thing two programs have to agree about. Written twice — once
 * in the page that sends and once in the page that receives — the two copies
 * drift, and the failure is silent: a tab opens, waits, and shows a chooser,
 * with nothing anywhere saying why. So both halves are here, and the message
 * names are constants rather than strings anybody types.
 *
 * ## What is deliberately not trusted
 *
 * The receiver takes documents only from origins it is willing to. Not because
 * a handed-over document is dangerous — every document is verified and
 * sandboxed on the way in regardless of how it arrived, exactly as a chosen
 * file is — but because without a check, any page on the web could open the
 * opener and put a document in front of somebody who believes they arrived
 * there themselves.
 *
 * Which origins those are is the host's business rather than the protocol's, so
 * this takes a predicate and not a list.
 *
 * The receiver also never trusts the sender about *what the document is*. The
 * name is a label; the bytes are checked.
 */

/** The receiver announcing it is listening. Carries nothing. */
export const OPENER_READY = "dai:opener-ready";

/** The document itself, sent once, in reply to a ready. */
export const HANDOFF = "dai:handoff";

/** What the receiver hands on to whatever actually opens documents. */
export interface HandedOver {
  name: string;
  bytes: Uint8Array;
}

/**
 * Minimal windows, so this can be driven by a test without a real browser.
 *
 * Typed structurally rather than as `Window` because the two sides only ever
 * use four members between them, and a test that had to fake a whole `Window`
 * would be faking the thing under test.
 */
export interface Poster {
  postMessage(data: unknown, targetOrigin: string): void;
  closed?: boolean;
}

interface Listener {
  addEventListener(type: "message", handler: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", handler: (event: MessageEvent) => void): void;
}

/**
 * Opens the opener in a new tab and gives it the document.
 *
 * `open` must have been called already, synchronously inside the click that
 * asked for this — a popup opened later is blocked, and the failure looks like
 * the button doing nothing.
 *
 * Resolves when the document has been handed over, rejects if the opener never
 * answers. A caller that gets a rejection should show the download: the point
 * of the format is a file somebody can keep, and this is a shortcut past
 * needing one, not a replacement for having one.
 */
export async function handOffToOpener(
  tab: Poster,
  document_: HandedOver,
  options: { origin: string; window: Listener; timeoutMs?: number },
): Promise<void> {
  const { origin, window: listener, timeoutMs = 15_000 } = options;

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listener.removeEventListener("message", onMessage);
      if (error) reject(error);
      else resolve();
    };

    const onMessage = (event: MessageEvent) => {
      // The origin check is the whole security of this direction: any page can
      // post to us, and a ready from anywhere else would make us send somebody
      // else's tab a document.
      if (event.origin !== origin) return;
      if ((event.data as { type?: string } | null)?.type !== OPENER_READY) return;

      // Not transferred. The buffer stays usable here, because the page still
      // has a download button pointing at these same bytes and detaching them
      // would break it — a saving of one copy against a button that silently
      // produces an empty file.
      tab.postMessage({ type: HANDOFF, name: document_.name, bytes: document_.bytes }, origin);
      finish();
    };

    listener.addEventListener("message", onMessage);

    const timer = setTimeout(() => {
      finish(
        new Error(
          `The opener did not respond. It may have been blocked from opening, ` +
            `or closed before it finished loading.`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * The receiving half: says it is ready, then accepts one document.
 *
 * Returns a function that stops listening, for a page that gives up waiting.
 *
 * The ready goes to `*` deliberately. It carries no information — it is the
 * word "ready" — and the alternative is knowing the sender's origin before the
 * sender has said anything, which is a bootstrapping problem with no answer
 * that is not just a worse version of this.
 */
export function receiveHandoff(
  opener: Poster,
  onDocument: (document_: HandedOver) => void,
  options: { allows: (origin: string) => boolean; window: Listener },
): () => void {
  const { allows, window: listener } = options;

  const onMessage = (event: MessageEvent) => {
    if (!allows(event.origin)) return;

    const data = event.data as { type?: string; name?: unknown; bytes?: unknown } | null;
    if (data?.type !== HANDOFF) return;
    if (!(data.bytes instanceof Uint8Array) || data.bytes.length === 0) return;

    stop();
    onDocument({
      // The sender's name is a label on a tab, never a path. A name it chose
      // freely must not be able to say anything about where bytes go.
      name: typeof data.name === "string" ? data.name.replace(/[/\\]/g, "_") : "document.dai.html",
      bytes: data.bytes,
    });
  };

  const stop = () => listener.removeEventListener("message", onMessage);

  listener.addEventListener("message", onMessage);
  opener.postMessage({ type: OPENER_READY }, "*");

  return stop;
}
