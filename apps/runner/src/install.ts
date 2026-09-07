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
import { platform, standalone } from "./platform.js";
import { closeSheet as slideClose, openSheet as slideOpen } from "./sheet.js";

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
  /** The address it came by, or one this opener made for it, when it fits one. */
  link?: string;
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

/**
 * The colour under the status bar, remembered per document and per scheme.
 *
 * A home-screen app's status bar takes the colour of the page as it first
 * appears, and the application's own colour is not known until it has drawn,
 * which is later than that. So once it is known it is kept here, and the
 * head script in index.html paints it before the first frame of the next
 * launch. That script spells this key out by hand; keep the two in step.
 */
function groundKey(uuid: string): string {
  let scheme = "light";
  try {
    if (matchMedia("(prefers-color-scheme: dark)").matches) scheme = "dark";
  } catch {
    /* No matchMedia: light, which is what the head script assumes too. */
  }
  return `dai:ground:${uuid}:${scheme}`;
}
export function knownGround(uuid: string): string | undefined {
  try {
    return localStorage.getItem(groundKey(uuid)) ?? undefined;
  } catch {
    return undefined;
  }
}
export function keepGround(uuid: string, colour: string): void {
  try {
    localStorage.setItem(groundKey(uuid), colour);
  } catch {
    /* Nothing to do: the strip is the chooser's colour until the app has drawn. */
  }
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

  const open = /<svg\b[^>]*>/i.exec(markup);
  if (!open) return undefined;

  // Already sized: leave it exactly as the author wrote it.
  if (/\swidth\s*=/i.test(open[0]) && /\sheight\s*=/i.test(open[0])) return markup;

  const sized = open[0].replace(/<svg\b/i, `<svg width="${size}" height="${size}"`);
  return markup.replace(open[0], sized);
}

/**
 * The document's icon as a PNG, because a home screen will not take an SVG.
 * Null when the image will not load; the caller then keeps this app's own
 * icon rather than showing a broken one.
 */
export async function iconPng(favicon: string | undefined, size: number): Promise<Blob | null> {
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
  let inline: string | null = null;
  const png = await iconPng(identity.favicon, 512);
  if (png) {
    // The bytes themselves, for the manifest. A phone test showed iOS reads
    // the manifest through the service worker but fetches the *icons* it
    // names outside it, so an icon at a worker-served address came back 404
    // and the home screen showed a letter. A data: URL needs no fetch.
    inline = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(png);
    });
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
    // The app's own colour when it has been seen, for the splash and the
    // first frame; the opener's dark ground for a document not yet drawn.
    background_color: knownGround(identity.uuid) ?? "#111827",
    theme_color: knownGround(identity.uuid) ?? "#111827",
    icons: icon
      ? [
          ...(inline ? [{ src: inline, sizes: "512x512", type: "image/png" }] : []),
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
  document.title = "DAI";
  headTag("meta", 'name="apple-mobile-web-app-title"').setAttribute("content", "DAI");
  headTag("link", 'rel="apple-touch-icon"').setAttribute("href", "./icons/apple-touch-icon.png");
  headTag("link", 'rel="icon"').setAttribute("href", "./favicon.svg");
  headTag("link", 'rel="manifest"').setAttribute("href", "./manifest.webmanifest");
}

/** A step on the sheet: a glyph a person will recognise from their own device, and one line. */
export interface KeepStep {
  glyph: "share" | "add" | "menu" | "install" | "file";
  text: string;
}

/**
 * What the sheet says on this device.
 *
 * The device's own words and the device's own glyphs, in the order the fingers
 * go. A third step exists only for a document that arrived as a file and is
 * too large to travel in its own address: an iOS home-screen app starts with
 * empty storage, and that one has to be handed the file once.
 */
export function howToKeep(identity: Identity, prompt: boolean): { title: string; sub: string; steps: KeepStep[] } {
  const name = identity.name;
  const sub = "It opens like an app, works without a connection, and stays on this device.";
  switch (platform()) {
    case "ios":
      return {
        title: `Add ${name} to your Home Screen`,
        sub,
        steps: [
          { glyph: "share", text: "Tap the Share button" },
          { glyph: "add", text: "Tap Add to Home Screen" },
          ...(identity.link ? [] : [{ glyph: "file" as const, text: `Open the new icon once and choose ${name} from Files` }]),
        ],
      };
    case "android":
      return {
        title: `Add ${name} to your home screen`,
        sub,
        steps: prompt
          ? []
          : [
              { glyph: "menu", text: "Tap ⋮ in your browser" },
              { glyph: "add", text: "Tap Add to Home screen" },
            ],
      };
    default:
      return {
        title: `Keep ${name} on this computer`,
        sub,
        steps: prompt
          ? []
          : [
              { glyph: "menu", text: "Open your browser's menu" },
              { glyph: "install", text: "Choose Install, Add to Dock, or Create shortcut" },
            ],
      };
  }
}

/** The one word on the button, in the vocabulary of the device it is on. */
function ctaLabel(prompt: boolean): string {
  if (prompt) return "Install";
  return platform() === "ios" || platform() === "android" ? "Add to Home Screen" : "Keep";
}

const GLYPHS: Record<KeepStep["glyph"], string> = {
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  add: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 9v6M9 12h6"/>',
  menu: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  install: '<path d="M12 4v10M8 10l4 4 4-4M5 19h14"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
};

function glyph(kind: KeepStep["glyph"]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = GLYPHS[kind];
  return svg;
}

export interface Keeper {
  /**
   * A document is on screen. The page takes its name, icon and manifest, the
   * header shows the document and the one action that keeps it — but nothing
   * is asked.
   */
  describe(identity: Identity): void;
  /** Somebody used it. The action draws the eye, once. */
  offer(): void;
  /** Somebody tapped the action: do it, or show how. */
  keep(): void;
  /** No document on screen: the header is the opener's again. */
  clear(): void;
  /** Whether a one-tap install exists on this device right now. */
  readonly canPrompt: boolean;
}

/**
 * Wires the header action and the sheet. Call once at start-up.
 *
 * One control, in the header, for as long as a document is open — the way an
 * app puts its one important action where the thumb already is — and a sheet
 * that shows the gesture in the device's own glyphs when the browser has no
 * prompt of its own. No banner, nothing to dismiss: a control is not a
 * question. The only moment it raises its voice is after the first use, when
 * it pulses once.
 */
export function watchForInstall(): Keeper | null {
  const cta = document.getElementById("keep-cta") as HTMLButtonElement | null;
  const label = document.getElementById("keep-cta-label");
  const titleIcon = document.getElementById("title-icon") as HTMLImageElement | null;
  const sheet = document.getElementById("keep-sheet");
  const sheetIcon = document.getElementById("keep-icon") as HTMLImageElement | null;
  const sheetTitle = document.getElementById("keep-title");
  const sheetSub = document.getElementById("keep-sub");
  const sheetSteps = document.getElementById("keep-steps");
  const done = document.getElementById("keep-done");
  if (!cta || !label || !titleIcon || !sheet || !sheetIcon || !sheetTitle || !sheetSub || !sheetSteps || !done) return null;

  let saved: InstallEvent | null = null;
  let current: (Identity & { link?: string }) | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept rather than allowed to fire on its own, so it arrives from the
    // button rather than on top of the document loading.
    event.preventDefault();
    saved = event as InstallEvent;
    label.textContent = ctaLabel(true);
  });

  const closeSheet = () => {
    slideClose(sheet);
  };
  done.addEventListener("click", closeSheet);
  sheet.addEventListener("click", (event) => {
    if (event.target === sheet) closeSheet();
  });

  const install = () => {
    const prompt = saved;
    if (!prompt) return false;
    saved = null;
    void prompt.prompt();
    return true;
  };

  const showSheet = (identity: Identity & { link?: string }) => {
    const guide = howToKeep(identity, Boolean(saved));
    sheetIcon.src = faviconUrl(identity.favicon) ?? new URL("/icons/icon-192.png", location.origin).href;
    sheetTitle.textContent = guide.title;
    sheetSub.textContent = guide.sub;
    sheetSteps.replaceChildren(
      ...guide.steps.map((step) => {
        const item = document.createElement("li");
        item.appendChild(glyph(step.glyph));
        const text = document.createElement("span");
        text.textContent = step.text;
        item.appendChild(text);
        return item;
      }),
    );
    slideOpen(sheet);
  };

  const keep = () => {
    if (!current) return;
    if (install()) return;
    if (platform() === "ios" && keepHere(current)) return;
    showSheet(current);
  };
  cta.addEventListener("click", keep);
  cta.addEventListener("animationend", () => cta.classList.remove("nudge"));

  return {
    get canPrompt() {
      return Boolean(saved);
    },

    describe(identity) {
      current = identity;
      closeSheet();
      label.textContent = ctaLabel(Boolean(saved));
      // Already an app on this device: nothing to add.
      cta.hidden = standalone();
      const icon = faviconUrl(identity.favicon);
      titleIcon.hidden = !icon;
      if (icon) titleIcon.src = icon;
      // The page describes the document whether or not the sheet is ever
      // shown: an install from the browser's own menu, later, should still
      // get the right name and icon.
      void describeDocument(identity);

      // Back from the reload `keepHere` asked for: the page was loaded with
      // this document's manifest, and the gesture is worth showing now.
      let pending: string | null = null;
      try {
        pending = sessionStorage.getItem(KEEP_AFTER_RELOAD);
        if (pending) sessionStorage.removeItem(KEEP_AFTER_RELOAD);
      } catch {
        /* Nothing pending. */
      }
      if (pending === identity.uuid && !standalone()) showSheet(identity);
    },

    offer() {
      const identity = current;
      if (!identity || standalone() || dismissed(identity.uuid)) return;
      // Once per document, after the first use: the first moment somebody
      // has any reason to want it back.
      remember(identity.uuid);
      cta.classList.add("nudge");
    },

    keep,

    clear() {
      current = null;
      cta.hidden = true;
      cta.classList.remove("nudge");
      titleIcon.hidden = true;
      closeSheet();
    },
  };
}
