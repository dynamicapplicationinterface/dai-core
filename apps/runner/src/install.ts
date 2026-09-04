/**
 * Telling somebody, once, that the thing they are looking at is keepable —
 * and making what they keep be *their document*, not this opener.
 *
 * Somebody who has just watched their document run is in a browser tab. They
 * have no idea it can be anything else, and no browser will tell them. On a
 * phone the gesture that keeps it — Share, then Add to Home Screen — is buried
 * two menus deep and completely unguessable; the difference between a thing
 * somebody tried once and a thing somebody has is whether anyone said that
 * sentence to them at the right moment.
 *
 * The right moment is after a document is open and running. Before that there
 * is nothing to keep, and an install prompt on an empty chooser is asking
 * somebody to bookmark a file picker.
 *
 * ## Whose name goes on the icon
 *
 * The first version installed as "DAI Opener" with this app's own icon, and
 * somebody who had just made a packing list found "DAI Opener" on their
 * desktop and, fairly, did not think they had got a packing list. So while a
 * document is open this page describes *itself* as that document: its title,
 * the name and icon a home screen will use, and the manifest an installer
 * reads. The document's own icon is the one its file carries; every file has
 * one, because the compiler puts one in.
 *
 * ## Why this is honest
 *
 * A home screen icon launches this app cold, with no file attached. It is only
 * worth suggesting because the opener reopens whatever was last open and
 * re-verifies it on the way in — so the icon lands somebody back in their
 * document, with their data, exactly where they left it. If that ever stops
 * being true this prompt has to go with it, or it becomes an invitation to a
 * blank screen.
 *
 * ## The two platforms
 *
 * Android and desktop Chrome fire `beforeinstallprompt`, which can be saved and
 * replayed from a button: one tap, done. Chrome reads the name and icon from
 * the manifest link at the time of the install, so that link is pointed at a
 * manifest written here for the document. iOS has no such event and never
 * will, so all that is left is describing the gesture — which is why the text
 * names Share and Add to Home Screen literally rather than saying "install" —
 * and iOS takes the name and icon from two tags in the head, which are set
 * the same way.
 */

/** What Chrome hands over, and which is not in the DOM typings. */
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

/** What a document says about itself, for the icon that will stand for it. */
export interface Identity {
  name: string;
  /** A data URL or inline SVG, as the container manifest carries it. */
  favicon?: string;
}

const ASKED_KEY = "dai:install-asked";

/** Already an app, by either platform's way of saying so. */
function alreadyInstalled(): boolean {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  // iPadOS reports itself as a Mac, and the touch points are what give it away.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const ipad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return ios || ipad;
}

function asked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "yes";
  } catch {
    // Storage refused. Better to say it again than to lose the only chance
    // somebody has of learning this exists.
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(ASKED_KEY, "yes");
  } catch {
    /* Nothing to do; the prompt is not important enough to fail over. */
  }
}

/** The manifest's favicon as something an <img> can load. */
function faviconUrl(favicon: string | undefined): string | null {
  if (!favicon) return null;
  if (favicon.startsWith("data:")) return favicon;
  if (favicon.trim().startsWith("<svg")) {
    return "data:image/svg+xml," + encodeURIComponent(favicon);
  }
  return null;
}

/**
 * The document's icon as a PNG, because a home screen will not take an SVG.
 *
 * Drawn onto a canvas at the size a home screen wants. Resolves to null when
 * the image will not load, in which case the caller keeps this app's own
 * icon rather than showing a broken one.
 */
async function iconPng(favicon: string | undefined, size: number): Promise<string | null> {
  const url = faviconUrl(favicon);
  if (!url) return null;

  const image = new Image();
  const loaded = new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
  });
  image.src = url;
  if (!(await loaded)) return null;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0, size, size);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** One element in the head, created if it is not there. */
function headTag<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  match: string,
): HTMLElementTagNameMap[K] {
  let element = document.head.querySelector<HTMLElementTagNameMap[K]>(`${tag}[${match}]`);
  if (!element) {
    element = document.createElement(tag);
    const [name, value] = match.split("=");
    element.setAttribute(name!, value!.replace(/"/g, ""));
    document.head.appendChild(element);
  }
  return element;
}

/**
 * Makes this page describe the open document rather than the opener.
 *
 * The manifest link is swapped for one written here; Chrome reads it fresh at
 * install time. The two iOS tags are set directly. The tab's title follows.
 * Everything is put back by `describeSelf` when the document is closed.
 */
export async function describeDocument(identity: Identity): Promise<void> {
  document.title = identity.name;
  headTag("meta", 'name="apple-mobile-web-app-title"').setAttribute("content", identity.name);

  const png = await iconPng(identity.favicon, 512);
  if (png) {
    headTag("link", 'rel="apple-touch-icon"').setAttribute("href", png);
    headTag("link", 'rel="icon"').setAttribute("href", png);
  }

  const manifest = {
    name: identity.name,
    short_name: identity.name.length > 12 ? identity.name.slice(0, 12) : identity.name,
    // Absolute, because a manifest that is not fetched from a URL has no base
    // to resolve against. Landing at the root reopens the last document.
    start_url: new URL("./", location.href).href,
    scope: new URL("./", location.href).href,
    display: "standalone",
    background_color: "#111827",
    theme_color: "#111827",
    icons: png
      ? [
          { src: png, sizes: "512x512", type: "image/png" },
          { src: png, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ]
      : [
          { src: new URL("./icons/icon-192.png", location.href).href, sizes: "192x192", type: "image/png" },
          { src: new URL("./icons/icon-512.png", location.href).href, sizes: "512x512", type: "image/png" },
        ],
  };
  headTag("link", 'rel="manifest"').setAttribute(
    "href",
    "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifest)),
  );
}

/** The opener as itself again, once nothing is open. */
export function describeSelf(): void {
  document.title = "DAI Opener";
  headTag("meta", 'name="apple-mobile-web-app-title"').setAttribute("content", "DAI");
  headTag("link", 'rel="apple-touch-icon"').setAttribute("href", "./icons/apple-touch-icon.png");
  headTag("link", 'rel="icon"').setAttribute("href", "./favicon.svg");
  headTag("link", 'rel="manifest"').setAttribute("href", "./manifest.webmanifest");
}

/**
 * Wires the prompt up. Call once at start-up; it shows nothing until a document
 * is open and the returned function is called with what to call it.
 */
export function watchForInstall(): ((identity: Identity) => void) | null {
  const bar = document.getElementById("install");
  const text = document.getElementById("install-text");
  const go = document.getElementById("install-go") as HTMLButtonElement | null;
  const dismiss = document.getElementById("install-dismiss");
  if (!bar || !text || !go || !dismiss) return null;

  let saved: InstallEvent | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept rather than allowed to fire on its own, so it arrives after somebody
    // has seen their document work rather than on top of it loading.
    event.preventDefault();
    saved = event as InstallEvent;
  });

  const hide = () => {
    bar.hidden = true;
    remember();
  };

  dismiss.addEventListener("click", hide);

  go.addEventListener("click", () => {
    const prompt = saved;
    hide();
    if (!prompt) return;
    void prompt.prompt();
  });

  return (identity) => {
    // The page describes the document whether or not the bar is shown: an
    // install from the browser's own menu, later, should still get the right
    // name and icon.
    void describeDocument(identity);

    if (alreadyInstalled() || asked()) return;

    if (saved) {
      text.textContent = `Keep ${identity.name} on your home screen and open it like an app.`;
      go.hidden = false;
    } else if (isIos()) {
      // No event exists on this platform, so the gesture has to be spelled out.
      text.textContent = `To keep ${identity.name}: tap Share, then Add to Home Screen.`;
      go.hidden = true;
    } else {
      // A desktop browser with no install support has nothing useful to offer.
      return;
    }

    bar.hidden = false;
  };
}
