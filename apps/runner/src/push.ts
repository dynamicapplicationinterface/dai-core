/**
 * Push, as the opener asks for it (Track 5, slice two).
 *
 * The mailbox carries a move; push is what makes it arrive while the app is
 * closed. The relay wakes a subscription with an empty push (see
 * `apps/relay/src/push.ts`), and the service worker it wakes asks the relay's
 * `head` whether that mailbox moved past what this device holds. Nothing about
 * the move travels in the push.
 *
 * **One subscription per mailbox, not per device.** A browser gives one push
 * subscription per service-worker registration, and one endpoint subscribed
 * to every game's mailbox would hand the relay a durable identifier tying
 * those mailboxes together — the linkage one mailbox per session (T1-D30)
 * exists to deny it. So each mailbox gets its own registration, at a scope
 * named by its address (`/push/<address>/`), and so its own endpoint. The same
 * worker script runs there with `?push=1`, which makes it do push and nothing
 * else: no cache, no fetch handling. The scope also tells the woken worker
 * which mailbox the push was for.
 *
 * **Permission is asked on a gesture, once.** Inviting someone and opening an
 * invite are the two moments a person has just chosen to play with somebody;
 * both call `askForPush` from inside the click. Nothing is asked for on load.
 *
 * **The mailbox was the consent.** A notification opens the document, and
 * what arrived merges the way any relayed row does — silently, under the
 * standing consent the shared mailbox already is. Push adds a wake, not a
 * decision.
 *
 * Everything here is best-effort over polling: a browser without push, a
 * refused permission, or a relay without keys leaves the poll and the
 * foreground pull carrying every move exactly as before.
 */

let publicKey: string | undefined =
  document.querySelector('meta[name="dai-push-key"]')?.getAttribute("content")?.trim() || undefined;

/** Mailboxes this page would like woken for: address → relay base. */
const wanted = new Map<string, string>();
/** Mailboxes subscribed from this page: address → the SHA-256 of that mailbox's endpoint. */
const subscribed = new Map<string, string>();
const inFlight = new Set<string>();

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const sha256Hex = async (text: string): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

function available(): boolean {
  return Boolean(publicKey) && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The public VAPID key the relay signs with. Stamped at build; a test sets its own. */
export function setPushKey(key: string | undefined): void {
  publicKey = key || undefined;
  subscribed.clear();
  for (const [address, relay] of wanted) void subscribe(address, relay);
}

/**
 * Ask whether this device may be told when the other player moves. Call it
 * synchronously from a click handler: a browser only shows the question from
 * inside a gesture. Asks at most once — a person who answered is not asked again.
 */
export function askForPush(): void {
  if (!available() || Notification.permission !== "default") return;
  void Notification.requestPermission()
    .then((answer) => {
      if (answer === "granted") for (const [address, relay] of wanted) void subscribe(address, relay);
    })
    .catch(() => undefined);
}

/** A mailbox the open document reads: have it wake this device, if this device allows. */
export function wantPush(address: string, relay: string): void {
  wanted.set(address, relay);
  void subscribe(address, relay);
}

/** The appender's own subscription for a mailbox, so the relay does not wake the device that moved. */
export function pushSender(address: string): string | undefined {
  return subscribed.get(address);
}

async function activated(registration: ServiceWorkerRegistration): Promise<void> {
  const worker = registration.installing ?? registration.waiting ?? registration.active;
  if (!worker || worker.state === "activated") return;
  await new Promise<void>((resolve) => {
    const check = () => {
      if (worker.state === "activated" || worker.state === "redundant") resolve();
    };
    worker.addEventListener("statechange", check);
    check();
  });
}

async function subscribe(address: string, relay: string): Promise<void> {
  if (!available() || Notification.permission !== "granted") return;
  if (subscribed.has(address) || inFlight.has(address)) return;
  if (!/^[0-9a-zA-Z._-]{1,128}$/.test(address)) return;
  inFlight.add(address);
  try {
    const scope = new URL(`/push/${address}/`, location.origin).href;
    const registration = await navigator.serviceWorker.register("/sw.js?push=1", { scope });
    await activated(registration);
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(publicKey!) as unknown as ArrayBuffer,
      }));
    const response = await fetch(`${relay.replace(/\/$/, "")}/${address}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    if (response.ok) subscribed.set(address, await sha256Hex(subscription.endpoint));
  } catch {
    // No push here — refused, unsupported, or the relay unreachable. The poll
    // still carries every move; the next open tries again.
  } finally {
    inFlight.delete(address);
  }
}
