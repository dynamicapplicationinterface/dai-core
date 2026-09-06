/**
 * Keeping a document as an app on this device — and being honest, per
 * platform, about what that takes.
 *
 * Somebody who has just watched their document run is in a browser tab. They
 * have no idea it can be anything else, and no browser will tell them. The
 * gesture that keeps it is buried and unguessable on every platform, and
 * different on each; the difference between a thing somebody tried once and a
 * thing somebody has is whether anyone said the right sentence to them at
 * the right moment. So this says it once, unprompted, after a document is
 * running — and keeps it one tap away in the menu after that.
 *
 * ## What "keep" installs
 *
 * The document, not this opener. While a document is open the page describes
 * itself as that document: the tab title, the name and icon a home screen
 * uses, and the manifest an installer reads. Each document is its own app,
 * with its own id and a launch address that opens that document — so three
 * documents kept are three icons, each landing in the right one, rather than
 * one icon called whatever was open last.
 *
 * ## What each platform actually does
 *
 * Android and desktop Chrome fire `beforeinstallprompt`; it is saved and
 * replayed from a button, and the installed app shares this origin's
 * storage, so the document is simply there.
 *
 * iOS has no prompt, and — the part that was got wrong once — a home-screen
 * app on iOS gets its own storage, separate from Safari. The new icon
 * launches an opener that has never seen the document. So on iOS the honest
 * instruction is three steps: save a copy to Files, add to Home Screen, and
 * open the file once from the new icon. After that it stays. The launch
 * address carries the document's name so the new icon can ask for exactly
 * that file instead of showing an empty chooser.
 *
 * iOS also ignores a data: URL as a home-screen icon, so the document's icon
 * is put where the service worker can serve it from a real address.
 *
 * Other desktop browsers have no install of their own; their menu does, and
 * the text says where.
 */
import { installShareStorage, platform, standalone } from "./platform.js";

/** What Chrome hands over, and which is not in the DOM typings. */
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

/** What a document says about itself, for the icon that will stand for it. */
export interface Identity {
  uuid: string;
  name: string;
  /** How many times this device has opened this document, including now. */
  opens: number;
  /** A data URL or inline SVG, as the container manifest carries it. */
  favicon?: string;
  /** Whether a copy of this document exists as a file somewhere the person can find. */
  savedAsFile?: boolean;
  /**
   * The link this document arrived by, when it arrived by one (backlog 3.5).
   *
   * A home-screen icon has to launch into something. `?doc=<uuid>` finds a
   * document this device already keeps, which is the right answer once it does
   * — and it is nothing at all on a device that has been reset, or where
   * storage was evicted, or where somebody added the icon and opened it for
   * the first time a week later. The link is the document: it names where the
   * bytes are and carries the key in its fragment, so an icon built from one
   * can fetch the document again and then go on working offline.
   *
   * That is what "iOS, solved by the link" means. Not a special case for iOS —
   * the same icon behaves the same everywhere; iOS is only where the failure
   * was loudest, because it is the platform with no other way in.
   */
  link?: string;
}

/**
 * Where the page puts a document's icon and manifest so the worker can serve
 * them by address.
 *
 * Addresses, not data: URLs, and at the origin's root rather than relative to
 * wherever the page happens to be — a page at /d/<id> and a page at / must
 * name the same file, because the worker looks it up for both.
 *
 * A phone test settled what these have to be. iOS reads the *manifest* for a
 * home-screen icon's name, icon and launch address, and it reads the one the
 * page linked when it loaded: a manifest swapped in afterwards, or one at a
 * data: URL, is not consulted. So the manifest is a real file the worker
 * serves, and the worker links it into the page at load (see sw.js) when the
 * address names a document.
 */
const ICON_CACHE = "dai-doc-icons";

function iconAddress(uuid: string): string {
  return new URL(`/doc-icons/${uuid}.png`, location.origin).href;
}

export function manifestAddress(uuid: string): string {
  return new URL(`/doc-manifests/${uuid}.webmanifest`, location.origin).href;
}

/** Set before the page reloads at a document's own address, so the steps are shown after. */
const KEEP_AFTER_RELOAD = "dai:keep-after-reload";

/**
 * The address an icon for this document launches into.
 *
 * The link when there is one, because a link works on a device that has never
 * held this document; `?doc=<uuid>` otherwise, which is the honest answer for
 * a document that arrived as a file and exists nowhere else.
 *
 * The key rides in the fragment, and a fragment in a `start_url` is kept by
 * the browser and never sent to a server — the same property that makes the
 * link private makes it safe to put on a home screen.
 */
export function launchAddress(identity: Pick<Identity, "uuid" | "name"> & { link?: string }): string {
  if (identity.link) {
    // The link, and the document's id beside it: an opener that already holds
    // this document opens its own copy — offline, and without asking the
    // store again — and one that does not follows the link.
    const url = new URL(identity.link);
    url.searchParams.set("doc", identity.uuid);
    return url.href;
  }
  const url = new URL("/", location.origin);
  url.searchParams.set("doc", identity.uuid);
  url.searchParams.set("name", identity.name);
  return url.href;
}

function dismissedKey(uuid: string): string {
  return `dai:install-asked:${uuid}`;
}

function dismissed(uuid: string): boolean {
  try {
    return localStorage.getItem(dismissedKey(uuid)) === "yes";
  } catch {
    return false;
  }
}

function remember(uuid: string): void {
  try {
    localStorage.setItem(dismissedKey(uuid), "yes");
  } catch {
    /* Nothing to do; the prompt is not important enough to fail over. */
  }
}

/** The manifest's favicon as something an <img> can load. */
export function faviconUrl(favicon: string | undefined): string | null {
  if (!favicon) return null;
  if (favicon.startsWith("data:")) return favicon;
  if (favicon.trim().startsWith("<svg")) return "data:image/svg+xml," + encodeURIComponent(favicon);
  return null;
}

/**
 * An SVG with a size, because WebKit will not draw one without.
 *
 * An icon written the way icons are written — `viewBox` and no `width` or
 * `height` — has no intrinsic size. Chromium infers one from the viewBox and
 * draws it; WebKit treats it as zero by zero, and `drawImage` puts nothing on
 * the canvas. There is no error: the image loads, the draw succeeds, the PNG
 * comes out blank or the blob comes back null.
 *
 * The visible consequence was on a phone, and was not obviously about icons at
 * all: a document added to the home screen got the opener's icon instead of its
 * own, because the rasterisation quietly produced nothing to use.
 *
 * So the size is written in before the image is ever loaded. Only for markup
 * this function can see and understand — a `data:` URL that is already a PNG is
 * passed through untouched.
 */
function svgWithSize(favicon: string, size: number): string | undefined {
  const markup = favicon.trim().startsWith("<svg")
    ? favicon
    : favicon.startsWith("data:image/svg+xml,")
      ? decodeURIComponent(favicon.slice("data:image/svg+xml,".length))
      : undefined;
  if (!markup) return undefined;

  const open = /<svg[^>]*>/i.exec(markup);
  if (!open) return undefined;

  // Already sized: leave it exactly as the author wrote it.
  if (/\swidth\s*=/i.test(open[0]) && /\sheight\s*=/i.test(open[0])) return markup;

  const sized = open[0].replace(/<svg/i, `<svg width="${size}" height="${size}"`);
  return markup.replace(open[0], sized);
}

/**
 * The document's icon as a PNG, because a home screen will not take an SVG.
 * Null when the image will not load; the caller then keeps this app's own
 * icon rather than showing a broken one.
 */
async function iconPng(favicon: string | undefined, size: number): Promise<Blob | null> {
  // Sized first, or WebKit draws nothing. See svgWithSize.
  const sized = favicon ? svgWithSize(favicon, size) : undefined;
  const url = faviconUrl(sized ?? favicon);
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

  /*
   * A blank canvas is a failure, not an icon.
   *
   * When the draw puts nothing down — the case above, and anything else that
   * silently produces an empty image — the honest answer is null, so the
   * caller keeps this app's own icon rather than installing an invisible one.
   * Checked by looking, because every API involved reported success.
   */
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let drawn = false;
  for (let at = 3; at < pixels.length; at += 4) {
    if (pixels[at] !== 0) {
      drawn = true;
      break;
    }
  }
  if (!drawn) return null;

  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** One element in the head, created if it is not there. */
function headTag<K extends keyof HTMLElementTagNameMap>(tag: K, match: string): HTMLElementTagNameMap[K] {
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
 * The manifest link is swapped for one written here, which Chrome reads
 * fresh at install time. The two iOS tags are set directly. The icon goes
 * into a cache the service worker serves from a real address, because iOS
 * will not take a data: URL for a home-screen icon.
 */
export async function describeDocument(identity: Identity): Promise<void> {
  document.title = identity.name;
  headTag("meta", 'name="apple-mobile-web-app-title"').setAttribute("content", identity.name);

  let icon: string | null = null;
  const png = await iconPng(identity.favicon, 512);
  if (png) {
    icon = iconAddress(identity.uuid);
    try {
      const cache = await caches.open(ICON_CACHE);
      await cache.put(icon, new Response(png, { headers: { "content-type": "image/png" } }));
    } catch {
      // No Cache API (a private window, say). A data URL still works for
      // Chrome's manifest; iOS will show this app's icon instead.
      icon = URL.createObjectURL(png);
    }
    headTag("link", 'rel="apple-touch-icon"').setAttribute("href", icon);
    headTag("link", 'rel="icon"').setAttribute("href", icon);
  }

  const start = launchAddress(identity);
  const manifest = {
    // Its own app. Same id, same app: a second document with a different id
    // installs beside the first rather than renaming it.
    id: `doc:${identity.uuid}`,
    name: identity.name,
    short_name: identity.name.length > 12 ? identity.name.slice(0, 12) : identity.name,
    start_url: start,
    scope: new URL("/", location.origin).href,
    display: "standalone",
    background_color: "#111827",
    theme_color: "#111827",
    icons: icon
      ? [
          { src: icon, sizes: "512x512", type: "image/png" },
          { src: icon, sizes: "512x512", type: "image/png", purpose: "maskable" },
        ]
      : [
          { src: new URL("./icons/icon-192.png", location.href).href, sizes: "192x192", type: "image/png" },
          { src: new URL("./icons/icon-512.png", location.href).href, sizes: "512x512", type: "image/png" },
        ],
  };
  // A real address, served by the worker from the same cache as the icon.
  // Chrome reads it fresh at install; iOS reads it at the next load of a page
  // that links it, which `keepHere` arranges.
  const address = manifestAddress(identity.uuid);
  try {
    const cache = await caches.open(ICON_CACHE);
    await cache.put(
      address,
      new Response(JSON.stringify(manifest), { headers: { "content-type": "application/manifest+json" } }),
    );
    headTag("link", 'rel="manifest"').setAttribute("href", address);
  } catch {
    headTag("link", 'rel="manifest"').setAttribute(
      "href",
      "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifest)),
    );
  }
}

/**
 * Puts the page at the document's own address before the person is told to
 * tap Share.
 *
 * iOS takes a home-screen icon's name, picture and launch address from the
 * manifest the page linked *when it loaded*. A document that arrived by
 * handoff or from a file was loaded as the opener, so the icon would be the
 * opener's — which is what the first phone test produced. Reloading at
 * `?doc=<uuid>` (with the link beside it, when there is one) has the worker
 * link the document's manifest at load, and the document opens from this
 * device's own copy. Returns true when it navigated; the steps are shown
 * after the reload instead.
 */
function keepHere(identity: Identity & { link?: string }): boolean {
  const target = launchAddress(identity);
  if (location.href === target) return false;
  try {
    sessionStorage.setItem(KEEP_AFTER_RELOAD, identity.uuid);
  } catch {
    /* No session storage: the steps are still in the menu. */
  }
  location.assign(target);
  return true;
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
 * The sentence for this device. Short, and named for the taps a person makes,
 * because "install" describes something that does not happen on most of
 * these platforms.
 */
export function howToKeep(identity: Identity, prompt: boolean): { title: string; steps: string[] } {
  const name = identity.name;
  switch (platform()) {
    case "ios":
      return {
        title: `Keep ${name} on your Home Screen`,
        steps: [
          ...(identity.savedAsFile ? [] : ["Tap ⋯ and Save a copy, then Save to Files."]),
          "Tap Share, then Add to Home Screen.",
          `Open the new icon once and choose ${name} from Files. After that it stays.`,
        ],
      };
    case "android":
      return prompt
        ? { title: `Keep ${name} on your home screen`, steps: [] }
        : { title: `Keep ${name} on your home screen`, steps: ["Tap ⋮ in your browser, then Add to Home screen."] };
    default:
      return prompt
        ? { title: `Keep ${name} on this computer`, steps: [] }
        : {
            title: `Keep ${name} on this computer`,
            steps: ["Use your browser's menu: look for Install, Add to Dock, or Create shortcut."],
          };
  }
}

export interface Keeper {
  /**
   * A document is on screen. The page takes its name, icon and manifest, so
   * an install from the browser's own menu gets the right ones — but nothing
   * is offered yet.
   */
  describe(identity: Identity): void;
  /** Somebody used it. Now an offer is an offer rather than an interruption. */
  offer(): void;
  /** Somebody asked from the menu: do it, or say how. */
  keep(): void;
  /** Whether a one-tap install exists on this device right now. */
  readonly canPrompt: boolean;
}

/**
 * Wires the offer and the menu item up. Call once at start-up.
 */
export function watchForInstall(): Keeper | null {
  const bar = document.getElementById("install");
  const text = document.getElementById("install-text");
  const go = document.getElementById("install-go") as HTMLButtonElement | null;
  const dismiss = document.getElementById("install-dismiss");
  const how = document.getElementById("keep-how");
  if (!bar || !text || !go || !dismiss || !how) return null;

  let saved: InstallEvent | null = null;
  let current: Identity | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept rather than allowed to fire on its own, so it arrives after somebody
    // has seen their document work rather than on top of it loading.
    event.preventDefault();
    saved = event as InstallEvent;
  });

  const hide = () => {
    bar.hidden = true;
    if (current) remember(current.uuid);
  };

  dismiss.addEventListener("click", hide);

  const install = () => {
    const prompt = saved;
    if (!prompt) return false;
    saved = null;
    void prompt.prompt();
    return true;
  };

  go.addEventListener("click", () => {
    hide();
    if (install()) return;
    if (current && platform() === "ios") keepHere(current);
  });

  /** Writes the steps for this device into the menu. */
  const explain = () => {
    how.replaceChildren();
    if (!current) return;
    const guide = howToKeep(current, Boolean(saved));
    const title = document.createElement("p");
    title.className = "keep-title";
    title.textContent = guide.title;
    how.appendChild(title);
    if (guide.steps.length) {
      const list = document.createElement("ol");
      for (const step of guide.steps) {
        const item = document.createElement("li");
        item.textContent = step;
        list.appendChild(item);
      }
      how.appendChild(list);
    }
    how.hidden = false;
  };

  return {
    get canPrompt() {
      return Boolean(saved);
    },

    describe(identity) {
      current = identity;
      how.hidden = true;
      bar.hidden = true;
      // The page describes the document whether or not the bar is ever shown:
      // an install from the browser's own menu, later, should still get the
      // right name and icon.
      void describeDocument(identity);

      // Back from the reload `keepHere` asked for: now the page was loaded
      // with this document's manifest, and the steps are worth showing.
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem(KEEP_AFTER_RELOAD);
        if (pending) sessionStorage.removeItem(KEEP_AFTER_RELOAD);
      } catch {
        /* Nothing pending. */
      }
      if (pending === identity.uuid) {
        explain();
        if (platform() === "ios") {
          text.textContent = `Now tap Share, then Add to Home Screen — ${identity.name} will be the icon.`;
          go.hidden = true;
          bar.hidden = false;
        }
      }
    },

    offer() {
      const identity = current;
      if (!identity) return;
      if (standalone() || dismissed(identity.uuid)) return;

      /*
       * Asked at most twice, and never on the open itself.
       *
       * The first time somebody uses a document is the first moment they have
       * any reason to want it back. A third open with no answer is an answer,
       * and the menu still has it for anybody who changes their mind.
       */
      if (identity.opens > 2) return;
      const again = identity.opens > 1;

      if (saved) {
        text.textContent = again
          ? `Save ${identity.name} to your apps and open it from there.`
          : `Keep ${identity.name} on this device and open it like an app.`;
        go.hidden = false;
      } else if (platform() === "ios") {
        const lead = again ? `Save ${identity.name} to your apps` : `To keep ${identity.name}`;
        if (location.href !== launchAddress(identity)) {
          // Not yet at the document's own address, so Share would install the
          // opener. One tap moves the page there; the next line says Share.
          text.textContent = `${lead} on your Home Screen.`;
          go.textContent = "Keep it";
          go.hidden = false;
        } else {
          text.textContent = installShareStorage()
            ? `${lead}: tap Share, then Add to Home Screen.`
            : `${lead}: tap ⋯ for the steps — Share, Add to Home Screen, then open the file once.`;
          go.hidden = true;
        }
      } else {
        // A desktop browser with no install support has nothing useful to offer
        // unprompted; the menu still says how.
        return;
      }
      bar.hidden = false;
    },

    keep() {
      if (install()) return;
      if (current && platform() === "ios" && keepHere(current)) return;
      explain();
    },
  };
}
