/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { ContainerError, readCartridge, resealCartridge, type Cartridge } from "./cartridge.js";
import { refatten } from "../../../src/container.js";
import { decodeInline, hasLegacyHint, hintedUuid, inlineFrom, inlineLink, LAUNCH_CAP } from "../../../src/link.js";
import type { PastHost } from "../../../src/inline.js";
import { linkFor } from "../../../src/sender.js";
import { heldEngine } from "./engine.js";
import { ICON_CAP, openFromStore, publish, referenceFrom, strippedReference } from "../../../src/store.js";
import { presignedStore } from "../../../src/store-presigned.js";
import { labelPublisher, publisherState, recordPublisher } from "../../../src/publisher.js";
import { confusables } from "./confusables.js";
import { verifyIdentity } from "../../../src/identity.js";

/**
 * The one sentence, in the one place it is written.
 *
 * It appears on the card, in the message a shared document travels in, and on
 * the page somebody lands on when they have a file their computer does not
 * recognise. Three copies of a sentence drift; this is the sentence.
 */
const STANDING_LINE = "Send an app like you send a document.";
import { applicationFiles, authoredFiles, hostShell } from "../../../src/container.js";
import { writeBundle } from "../../../src/bundle.js";
import { SCHEMA_ENTRY } from "../../../src/core.js";
// The shell this host runs, shipped with this host: never the container's own.
import HOST_TEMPLATE from "../../../dist/template.html?raw";
import HOST_RUNTIME from "../../../dist/dai-runtime.js?raw";
import { handOff } from "../../../src/handoff.js";
import { receiveHandoff } from "../../../src/handoff-tab.js";
import { ISOLATION_CLAUSES } from "../../../src/host-profile.js";
import {
  describeDocument,
  describeSelf,
  faviconUrl,
  iconPng,
  keepGround,
  knownGround,
  launchAddress,
  sameLaunch,
  watchForInstall,
  type Identity,
} from "./install.js";
import { describeApp, hideCard, showCard, type CardInput } from "./card.js";
import { platform } from "./platform.js";
import { closeSheet as slideClose, openSheet as slideOpen } from "./sheet.js";
import { checkTrust, forgetTrust, pinTrust, trustVerdict } from "../../../src/trust.js";
import {
  deleteCartridgeFromLibrary,
  deleteDatabaseFromOpfs,
  getCartridgeFromLibrary,
  listCartridgesFromLibrary,
  loadDatabaseFromOpfs,
  saveCartridgeToLibrary,
  trustStore,
  publisherStore,
  sigstoreRoots,
  saveDatabaseToOpfs,
  type LibraryItem,
} from "./opfs.js";
import type { Share } from "./opfs.js";

const openButton = document.getElementById("open") as HTMLButtonElement;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const cartridgeFrame = document.getElementById("cartridge") as HTMLIFrameElement;
const report = document.getElementById("report") as HTMLElement;
const slot = document.getElementById("slot") as HTMLElement;
const title = document.getElementById("title") as HTMLElement;
const sheet = document.getElementById("sheet") as HTMLElement;
const sheetNote = document.getElementById("sheet-note") as HTMLElement;
const moreButton = document.getElementById("more") as HTMLButtonElement;
const libraryEl = document.getElementById("library") as HTMLElement;

let mountedUrl: string | undefined;
let loaded: Cartridge | undefined;
let handshakeEstablished = false;

// Storage Eviction Defense: call navigator.storage.persist() on boot
if ("storage" in navigator && typeof navigator.storage?.persist === "function") {
  void navigator.storage.persist().catch(() => {
    // Permission denied or non-fatal failure
  });
}

function say(message: string, isError = false): void {
  report.textContent = message;
  report.classList.toggle("error", isError);
  // Something went wrong on the way in: the chooser is the way out.
  if (isError) arrived(false);
}

/**
 * Whether the page is still on its way to a document the address names.
 *
 * The head script hides the chooser before the first paint when the address
 * carries something to open (see index.html). Taken off here when there is
 * nothing to open after all, so the chooser is back for the person to use.
 */
/**
 * The colour of the strip above the application.
 *
 * On a phone an installed app sits under a status bar that the system paints
 * itself, from this page's `theme-color`; Safari tints its toolbar from the
 * same tag. This page's own two tags, one per colour scheme, are the
 * chooser's. While a document is open the strip is the application's colour,
 * so an app that reaches the top of its screen looks as though it reaches the
 * top of the phone - the one part of the screen it cannot paint for itself.
 *
 * One tag with no media condition while a document is open, rather than a
 * rewrite of both: a browser takes the first tag whose condition holds, and
 * an app's colour holds in either scheme.
 */
const schemeTags = Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]'));
// The head script may have put one there already, from what it remembered.
let appTag = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])') ?? undefined;
/** The colour the open application declared for that strip, if it declared one. */
let declaredGround: string | undefined;
/** The open document, for remembering its colour; and its identity, when iOS has one to describe. */
let mountedUuid: string | undefined;
let describedIdentity: Identity | undefined;
/** A colour and nothing else: it goes into a style property and a meta tag on this page. */
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|[a-z]{3,20})$/i;
function paintAbove(theme?: string): void {
  if (theme) {
    for (const tag of schemeTags) tag.remove();
    if (!appTag) {
      appTag = document.createElement("meta");
      appTag.name = "theme-color";
    }
    appTag.content = theme;
    if (!appTag.isConnected) document.head.appendChild(appTag);
    return;
  }
  appTag?.remove();
  for (const tag of schemeTags) if (!tag.isConnected) document.head.appendChild(tag);
}

/**
 * The colour is settled: on the page, and remembered for the next launch.
 *
 * Painted on the root, which is what a phone's status bar takes its colour
 * from, and as the theme-color; kept under the document's id so the head
 * script can paint it before the first frame next time, which is when the
 * status bar is actually read. On iOS the manifest carries it too, so it is
 * described again when the colour is news.
 */
function settleGround(colour: string): void {
  document.documentElement.style.setProperty("--app-ground", colour);
  paintAbove(colour);
  tellCanvas();
  if (!mountedUuid) return;
  const news = knownGround(mountedUuid) !== colour;
  keepGround(mountedUuid, colour);
  if (news && describedIdentity) void describeDocument(describedIdentity).catch(() => undefined);
  for (const wake of groundWaiters.splice(0)) wake();
}

/** Whoever is waiting for the open document's colour to be settled. */
let groundWaiters: Array<() => void> = [];

/** Resolves once the document's colour is known, or after `within` ms without it. */
function groundSettled(uuid: string, within: number): Promise<void> {
  if (knownGround(uuid)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      groundWaiters = groundWaiters.filter((waiter) => waiter !== done);
      resolve();
    };
    const timer = window.setTimeout(done, within);
    groundWaiters.push(done);
  });
}

/**
 * A rehearsal: a first open on iOS mounts the document once to learn its
 * colour and then loads the page again at the document's address. Nothing
 * in between counts — the frame stays behind the launch screen, the open is
 * not counted, and the application's first use is not this one — because
 * the page a person can actually touch is the next one.
 */
let rehearsing = false;

/** The colour the address carried, when a link brought the page here. */
function carriedGround(): string | undefined {
  const colour = new URLSearchParams(location.search).get("ground")?.trim();
  return colour && COLOUR.test(colour) ? colour : undefined;
}

/**
 * The colour under the clock, on a link that is about to be sent.
 *
 * The person at the other end opens it for the first time, with nothing
 * remembered on their device. The head script paints from the address before
 * the first frame, so the first thing they see is right; and an icon they
 * make from it carries the colour on.
 */
function withGround(link: string): string {
  const colour = mountedUuid ? knownGround(mountedUuid) : undefined;
  if (!colour) return link;
  try {
    const url = new URL(link);
    url.searchParams.set("ground", colour);
    return url.href;
  } catch {
    return link;
  }
}

/**
 * The screen's edges, measured, for the document that is drawing to them.
 *
 * This page is the only one of the three that can see
 * `env(safe-area-inset-*)` — the value is zero in an iframe, and the
 * application is two frames down. It used to not matter, because this app
 * reserved a strip at the top and padded the bottom, and the application was
 * handed a rectangle that was already clear of both. It has the whole screen
 * now, so it is the thing drawing under the status bar, and these are the
 * numbers it needs to keep its own header out from under one.
 *
 * Read from a probe rather than a stylesheet, because `env()` resolves only
 * where it is used. Sent on mount and again whenever the screen changes
 * shape, which is what a rotation is.
 */
function screenInsets(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
    "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const read = (value: string): number => {
    const found = Number.parseFloat(value);
    return Number.isFinite(found) && found >= 0 ? found : 0;
  };
  const insets = {
    top: read(style.paddingTop),
    right: read(style.paddingRight),
    bottom: read(style.paddingBottom),
    left: read(style.paddingLeft),
  };
  probe.remove();
  return insets;
}

/**
 * The colour behind the application, told to the shell around it.
 *
 * Pulling a page down past its top on a phone shows what is behind it, and
 * behind the application were two white grounds of the shell's — its body
 * and the frame the app sits in — over an opener that is by now the app's
 * colour. So the shell paints both in that colour while an app is mounted,
 * and the pull shows the same colour, the way a phone's own apps do.
 */
function tellCanvas(): void {
  const target = cartridgeFrame.contentWindow;
  const colour = document.documentElement.style.getPropertyValue("--app-ground").trim();
  if (!target || !mountedNonce || !colour) return;
  target.postMessage({ type: "DAI_HOST_CANVAS", colour }, "*");
}

function tellInsets(): void {
  const target = cartridgeFrame.contentWindow;
  if (!target || !mountedNonce) return;
  target.postMessage({ type: "DAI_HOST_INSETS", ...screenInsets() }, "*");
}

window.addEventListener("resize", () => tellInsets());
window.addEventListener("orientationchange", () => tellInsets());

/** Hides "Saved" again a few seconds after it appears. See DAI_HOST_SAVE_STATE. */
let savedFor: number | undefined;

/**
 * The hosts this opener has been, for a link made against one of them.
 *
 * Kept at /hosts/<id>/ by the build (scripts/retain-host.mjs), newest first
 * in the index. Fetched only when this host's own rebuild does not match a
 * link's digest, which is what a link from before a deploy looks like; and
 * every rebuilt entry is still proven by digest before it is used.
 */
async function pastHosts(): Promise<PastHost[]> {
  const ids = (await (await fetch("/hosts/index.json", { cache: "no-cache" })).json()) as string[];
  const hosts: PastHost[] = [];
  for (const id of ids.slice(0, 12)) {
    if (!/^[0-9a-f]{16}$/.test(id)) continue;
    const [template, runtime, kit] = await Promise.all(
      ["template.html", "runtime.js", "kit.js"].map(async (name) => (await fetch(`/hosts/${id}/${name}`)).text()),
    );
    hosts.push({ template: template!, runtime: runtime!, kit: kit! });
  }
  return hosts;
}

/**
 * The save revision this tab is working from, per document.
 *
 * Read when a document opens and moved on by each save this tab commits. A
 * save finding the library at some other revision is a tab that has fallen
 * behind another, and is refused rather than written over it.
 */
const knownRevision = new Map<string, number>();

async function learnRevision(documentUuid: string): Promise<number> {
  const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  const revision = held?.revision ?? 0;
  knownRevision.set(documentUuid, revision);
  return revision;
}

function arrived(still: boolean): void {
  document.documentElement.classList.toggle("arriving", still);
}

/**
 * The document to reopen when the app is next launched.
 *
 * An installed app that opens on an empty console has not remembered anything,
 * whatever it has stored: somebody who added tasks yesterday expects to see
 * them, not a file picker. This is the smallest thing that has to be
 * remembered — which document was open — and the library already holds the
 * rest.
 *
 * Cleared by ejecting, because ejecting is how somebody says they are done
 * with it.
 */
const keeper = watchForInstall();
/** Set for one open when the card called the publisher a conflict (4.3). */
let installSuppressed = false;

const RESUME_KEY = "dai:resume";

/**
 * How many times this device has opened a document, counted here rather than
 * in the library because it is about what to say to a person, not about the
 * document. Kept beside the record of a dismissed offer, for the same reason.
 */
/** How many times this document has been opened here, without counting this one. */
function seenOpens(uuid: string): number {
  try {
    return Number(localStorage.getItem(`dai:opens:${uuid}`) ?? "0");
  } catch {
    return 0;
  }
}

function countOpen(uuid: string): number {
  try {
    const next = Number(localStorage.getItem(`dai:opens:${uuid}`) ?? "0") + 1;
    localStorage.setItem(`dai:opens:${uuid}`, String(next));
    return next;
  } catch {
    // Storage refused. One open is the honest answer when nothing is remembered.
    return 1;
  }
}

/** The isolation probe's last report, with what this host claimed. For CI. */
let lastIsolationReport: unknown = null;

/*
 * Who may hand this app a document directly.
 *
 * Not a safety property of the document — everything is verified and sandboxed
 * however it arrives. It is about consent: without a list, any page on the web
 * could open this one and put something in front of somebody who believes they
 * opened it themselves.
 */
/*
 * Who may hand this app a document directly.
 *
 * Not a safety property of the document — everything is verified and sandboxed
 * however it arrives. It is about consent: without a list, any page on the web
 * could open this one and put something in front of somebody who believes they
 * opened it themselves.
 *
 * Localhost is allowed so the flow can be developed and tested at all. A page
 * on somebody's own machine handing them a document is not a thing this can
 * protect them from, and pretending otherwise would only mean the handoff is
 * exercised for the first time in production.
 */
function mayHandOver(origin: string): boolean {
  if (origin === "https://www.dynamicapplicationinterface.io") return true;
  if (origin === "https://dynamicapplicationinterface.io") return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function rememberOpen(documentUuid: string): void {
  try {
    localStorage.setItem(RESUME_KEY, documentUuid);
  } catch {
    // A browser refusing storage costs the resume, not the session.
  }
}

function forgetOpen(): void {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    /* As above. */
  }
}

/** Whether this device holds the open document. Null until a store has answered. */
let keptOnDevice: boolean | null = null;

/** How many saves the running document has asked this host for. Read by tests. */
let hostSaves = 0;

/** The application's own index.html, as text, when the archive carries one. */
function indexHtmlOf(cartridge: Cartridge): string | undefined {
  const bytes = cartridge.archive["app/index.html"];
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/** The launch screen's icon and name, for the moment between the tap and the app. */
function showLaunch(name: string, favicon: string | undefined): void {
  const icon = document.getElementById("launch-icon") as HTMLImageElement | null;
  const label = document.getElementById("launch-name");
  const url = faviconUrl(favicon);
  if (icon) {
    icon.hidden = !url;
    if (url) icon.src = url;
  }
  if (label) label.textContent = name;
}

let bootingGuard: number | undefined;

function eject(): void {
  forgetOpen();
  arrived(false);
  if (mountedUrl) {
    URL.revokeObjectURL(mountedUrl);
    mountedUrl = undefined;
  }
  // about:blank rather than removing the frame: the element keeps its sandbox
  // attributes, so the next cartridge cannot inherit a laxer configuration.
  cartridgeFrame.src = "about:blank";
  loaded = undefined;
  handshakeEstablished = false;
  document.body.classList.remove("loaded", "launching", "booting");
  document.documentElement.style.removeProperty("--app-ground");
  declaredGround = undefined;
  mountedUuid = undefined;
  describedIdentity = undefined;
  paintAbove();
  const saveState = document.getElementById("save-state");
  if (saveState) saveState.hidden = true;
  hostSaves = 0;
  window.clearTimeout(bootingGuard);
  keeper?.clear();
  hideCard();
  describeSelf();
  sheet.hidden = true;
  title.textContent = "";
  say("");
  fileInput.value = "";
  void refreshLibrary();
}

/**
 * The library is plumbing, not a screen.
 *
 * It holds what this device has opened so an icon can launch it and a link
 * can open offline; nothing lists it. A person has apps, each its own icon,
 * and a document arrives from a message or a file — not from a list inside
 * another document. What used to render here is gone; the storage stays.
 */
async function refreshLibrary(): Promise<void> {
  /* Nothing to draw. */
}

async function launchFromLibrary(item: LibraryItem): Promise<void> {
  slot.classList.add("busy");
  say(`Loading ${item.appName}…`);

  try {
    const file = new File([item.html], `${item.appName}.dai.html`, { type: "text/html" });
    const cartridge = await readCartridge(file);

    // Checked on the way back in as well. A document reopened from the library
    // has been sitting in storage this app does not exclusively control, and a
    // gate that only applied the first time would apply to the way people open
    // a container once and not to the way they open it every day.
    const verdict = await checkTrust(trustStore(), cartridge);
    if (verdict.status === "mismatch") {
      say(verdict.message, true);
      slot.classList.remove("busy");
      return;
    }

    await recordPublisher(publisherStore(), cartridge, await confusables());

    const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    if (opfsDb && opfsDb.byteLength > 0) {
      loaded = await resealCartridge(cartridge, opfsDb);
    } else {
      loaded = cartridge;
    }

    /*
     * Update last opened time in library.
     *
     * A library write replaces the whole record, so everything not named here
     * is dropped — which is how opening a document from the library erased
     * its own account of when its data was last written, and left an arriving
     * copy with nothing to be newer than. Opening is not saving: `savedAt` is
     * carried across untouched.
     */
    await saveCartridgeToLibrary({
      ...(item.savedAt !== undefined ? { savedAt: item.savedAt } : {}),
      documentUuid: loaded.manifest.documentUuid,
      appName: loaded.manifest.appName ?? "container",
      lastOpened: new Date().toISOString(),
      html: loaded.html,
      publicKeyFingerprint: loaded.publicKeyFingerprint,
      revision: await learnRevision(loaded.manifest.documentUuid),
    });

    rememberOpen(loaded.manifest.documentUuid);
    await mount(loaded);
  } catch (error) {
    say(`Failed to load ${item.appName} (${(error as Error).message})`, true);
  } finally {
    slot.classList.remove("busy");
  }
}

async function deleteApp(documentUuid: string): Promise<void> {
  await deleteCartridgeFromLibrary(documentUuid);
  await deleteDatabaseFromOpfs(documentUuid);
  // And the pin: somebody who removes a document and is later handed a new one
  // under a new key has made a decision, and a pin that outlived the document
  // would refuse it for ever with no way to say otherwise.
  await forgetTrust(trustStore(), documentUuid);
  if (loaded?.manifest.documentUuid === documentUuid) {
    eject();
  } else {
    await refreshLibrary();
  }
}

/**
 * Mounts a verified container.
 */
async function mount(cartridge: Cartridge): Promise<void> {
  /*
   * The host's own shell around the verified archive — never the container's
   * document. The container's bootloader is the publisher's code, and it
   * would run here with this origin, this library and these pinned keys in
   * reach. See hostShell.
   */
  const shell = await hostShell(cartridge, { template: HOST_TEMPLATE, runtime: HOST_RUNTIME });
  const blob = new Blob([shell], { type: "text/html" });
  mountedUrl = URL.createObjectURL(blob);
  cartridgeFrame.src = mountedUrl;

  // The launch screen holds — the document's icon and name on a still
  // ground — until the runtime reports the app interactive (DAI_HOST_TIMING
  // below), and the frame fades in over it. See #launch in index.html.
  showLaunch(cartridge.manifest.appName ?? "container", cartridge.manifest.favicon);
  // The edges the app cannot paint - the ground behind its frame, and the
  // status bar above it, which the system paints in this page's theme-color -
  // in the app's own colour.
  const { theme } = describeApp(indexHtmlOf(cartridge));
  declaredGround = theme;
  mountedUuid = cartridge.manifest.documentUuid;
  if (theme) settleGround(theme);
  else {
    // Not declared: what this device remembers, or what the link it came by
    // carried - the sender's device knew - stands until the application has
    // drawn and said what it is. A link names no document until now, so the
    // head script could paint from it but not remember it; this is where.
    const remembered = knownGround(mountedUuid) ?? carriedGround();
    if (remembered) {
      paintAbove(remembered);
      keepGround(mountedUuid, remembered);
    }
  }
  document.body.classList.remove("launching");
  /*
   * Its work is done.
   *
   * The head script hides the chooser when the address names a document, and
   * nothing took the class off again once one had opened. Removing a document
   * from a home-screen app then left the chooser on screen with its text and
   * its button both hidden — an empty page, black in dark mode, with nothing
   * on it to press. Cleared here and on eject, so the chooser is a chooser
   * again the moment there is no document.
   */
  arrived(false);
  document.body.classList.add("loaded", "booting");
  window.clearTimeout(bootingGuard);
  // A runtime that never reports is still an app somebody wants to see.
  bootingGuard = window.setTimeout(() => {
    if (!rehearsing) document.body.classList.remove("booting");
  }, 8000);

  /*
   * Named and iconed now; offered later.
   *
   * The page describes the document as soon as it is on screen, so a tab, a
   * home screen and the browser's own install menu all get the right name and
   * icon. The offer waits for the person to use it — see DAI_HOST_USED below.
   */
  const name = cartridge.manifest.appName ?? "container";
  /*
   * The address an icon launches into: the link it came by, or — for a
   * document that came as a file or by handoff — the inline link this
   * opener can make, when the document fits one. An iOS home-screen app
   * starts with storage of its own and nothing in it; a phone test showed
   * an icon for a handed-off document opening on the empty chooser. A link
   * that carries the document carries it there too.
   */
  const link = arrivedByLink ?? (await launchLinkForDocument(cartridge.html));
  keeper?.describe({
    uuid: cartridge.manifest.documentUuid,
    name,
    favicon: cartridge.manifest.favicon,
    savedAsFile: arrivedAsFile,
    link,
    // A rehearsal is not an open: the page a person can touch counts it.
    opens: rehearsing ? seenOpens(cartridge.manifest.documentUuid) : countOpen(cartridge.manifest.documentUuid),
  });
  title.textContent = name;

  /*
   * Who signed it, in the sheet rather than the bar.
   *
   * "signed a3cab3dd" is a sentence for somebody who already knows what a key
   * fingerprint is. It is worth being able to find, and it is not worth a fifth
   * of a phone screen in front of somebody opening their first document.
   */
  const sheetName = document.getElementById("sheet-name");
  const sheetIcon = document.getElementById("sheet-icon") as HTMLImageElement | null;
  if (sheetName) sheetName.textContent = name;
  if (sheetIcon) {
    const url = faviconUrl(cartridge.manifest.favicon);
    sheetIcon.hidden = !url;
    if (url) sheetIcon.src = url;
  }
  sheetNote.textContent = cartridge.publicKeyFingerprint
    ? `Signed by ${cartridge.publicKeyFingerprint.slice(0, 8)}`
    : "Not signed";
  sheetNote.dataset.state = cartridge.publicKeyFingerprint ? "signed" : "unsigned";
  /*
   * As an app, or inside a browser.
   *
   * An icon added to a home screen is one of two things and looks like one:
   * a web app, which gets the whole screen, or a bookmark, which opens the
   * browser with its bars around the page. iOS makes a bookmark whenever it
   * decides a page is not app-capable, says nothing about having done so, and
   * there is no way to tell them apart from the icon. So the app says which
   * one it is running as, and what the other one would take.
   */
  const mode = document.getElementById("sheet-mode");
  if (mode) {
    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      window.matchMedia?.("(display-mode: fullscreen)").matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    mode.hidden = false;
    mode.dataset.state = standalone ? "app" : "browser";
    mode.textContent = standalone
      ? "Running as an app · the whole screen"
      : "Running in a browser · its bars are the browser's. Add it to your Home Screen for the whole screen.";
  }

  const kept = document.getElementById("sheet-kept");
  if (kept) {
    kept.hidden = keptOnDevice === null;
    kept.dataset.state = keptOnDevice ? "kept" : "refused";
    kept.textContent = keptOnDevice
      ? "Kept on this device · works offline"
      : "Not kept — this device refused storage";
  }
  exportButton.textContent = "Save a copy…";
}

/**
 * Opens a container named by the address that opened this page.
 *
 * `?open=<url>` is what makes a container shareable: a link, not an attachment.
 * Any address this page is allowed to read works — a file on Dropbox, in an S3
 * bucket, on a GitHub raw URL, on a company file share — so sharing a container
 * needs no infrastructure belonging to this project. A relay would be a
 * convenience for people with nowhere to put a file, not the mechanism, and the
 * difference is what keeps "the file needs no server" true.
 *
 * Nothing about verification changes. The bytes are checked exactly as a chosen
 * file is, before anything runs, because where they came from says nothing
 * about what they are.
 */
async function openFromUrl(address: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(address, location.href);
  } catch {
    say(`"${address}" is not an address this can open.`, true);
    return;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    say(`This can only open http and https addresses, and that one is ${url.protocol}`, true);
    return;
  }

  /*
   * The fetch runs; the card is the click.
   *
   * A link used to fetch and mount with no step in between, so any page could
   * put a full-screen application — one asking for a password, say — in front
   * of somebody who had merely followed a link. That is still refused: nothing
   * mounts until the card below is asked. What changed is which click it is.
   * A button naming a hostname was the most that could be said before the
   * bytes arrived; the card is shown after they have been read and verified,
   * and says what the thing is called, who signed it and what it will not be
   * able to do. Reading a URL with no credentials, which is what any page can
   * already cause, buys a screen that is worth looking at.
   */
  slot.classList.add("busy");
  say(`Fetching ${url.hostname}…`);

  let response: Response;
  try {
    response = await fetch(url.href, { mode: "cors", credentials: "omit" });
  } catch {
    /*
     * Almost always CORS, and worth saying so.
     *
     * A cross-origin fetch that the other server does not allow fails
     * identically to one that could not connect at all — the browser reports
     * neither — and somebody whose link does not work will otherwise conclude
     * that this is broken rather than that their file host does not permit it.
     */
    slot.classList.remove("busy");
    say(
      `Could not read ${url.hostname}. Either it is unreachable, or it does not allow ` +
        `other sites to read its files. A link from Dropbox, S3, or a GitHub raw URL will work; ` +
        `many web servers will not without being configured to.`,
      true,
    );
    return;
  }

  if (!response.ok) {
    slot.classList.remove("busy");
    say(`${url.hostname} answered ${response.status} for that file.`, true);
    return;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = url.pathname.split("/").pop() || "container.dai";
  slot.classList.remove("busy");
  await ingest(new File([bytes], name, { type: "text/html" }), {
        from: `From ${url.hostname}. Nothing is uploaded — it runs on this device.`,
  });
}

/**
 * Takes a shared container out of the worker's hands.
 *
 * Removed as it is read: a file left here would be opened again by the next
 * launch, which is somebody's document reappearing without being asked for.
 */
async function collectSharedContainer(): Promise<{ file: File; from: string } | null> {
  try {
    const cache = await caches.open("dai-shared-v1");
    const response = await cache.match("./shared-container");
    if (!response) return null;

    const name = decodeURIComponent(response.headers.get("x-dai-name") ?? "shared.dai");
    const bytes = await response.arrayBuffer();
    await cache.delete("./shared-container");

    /*
     * Who posted it, as far as the worker could tell.
     *
     * A share from the device arrives with no referrer; a form on another
     * website arrives with that site's origin. The card says which, because
     * "shared to this app" describes something the person did, and a web page
     * posting a file into this app is not that. A page can withhold its
     * referrer, so this is a label rather than a gate — the gate is the card,
     * and the key is not recorded until the person presses Open.
     */
    const referrer = response.headers.get("x-dai-referrer") ?? "";
    const from =
      referrer && referrer !== location.origin
        ? `Posted into this app by ${referrer}. Nothing is uploaded — it runs on this device.`
        : "Shared to this app. Nothing is uploaded — it runs on this device.";

    return {
      file: new File([bytes], name, {
        type: response.headers.get("content-type") ?? "application/octet-stream",
      }),
      from,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the open document exists as a file somewhere the person can find.
 *
 * Chosen from a picker or shared in: yes. Handed straight over from the page
 * that built it: no — and on iOS that is the difference between "add to Home
 * Screen" working and the new icon having nothing to open.
 */
let arrivedAsFile = true;

/**
 * The link this document arrived by, when it arrived by one (backlog 3.5).
 *
 * Kept so a home-screen icon can launch into it. An icon built from
 * `?doc=<uuid>` finds a document this device already keeps and finds nothing
 * on a device that has been reset or had its storage evicted — which is the
 * icon that opens on an empty chooser a week after somebody added it. A link
 * names where the bytes are and carries the key in its fragment, so an icon
 * built from one can fetch the document again and then run offline.
 */
let arrivedByLink: string | undefined;

/**
 * Whether the document was held unencrypted by the store it came from.
 *
 * A property of how it travelled, not of what it is, and the card says so —
 * the person opening it did not make that choice and has no other way to
 * learn it was made.
 */
let arrivedInClear = false;

/**
 * Where a document came from, which decides whether it is shown a card first.
 *
 * A file somebody picked out of their own storage, or one they have just built
 * and handed over from a page they were already on, is not a document arriving
 * from a stranger. A link and a share are. Item 1.2 is where every carrier
 * lands on the same screen; this is the half that exists to be landed on.
 */
type Carrier = {
  from?: string;
  /**
   * The document this person already agreed to, by its id: an icon they made
   * for it launches with the id beside the link, and a fresh storage — an
   * iOS home-screen app starts with one — should open it, not ask again.
   * Honoured only when the link turns out to carry that document.
   */
  consentedFor?: string;
  /**
   * What the address said this document was, when it said anything.
   *
   * The same value as `consentedFor` and kept apart from it because they are
   * asked different questions: one is "may this open without asking", the
   * other is "did the address describe what it carried". A link whose hint
   * names one document and whose payload is another is the signature of a
   * hand-edited link, and the card says so rather than presenting a stranger
   * as though the address had introduced it.
   */
  hinted?: string;
};

async function ingest(file: File, carrier: Carrier = {}): Promise<void> {
  slot.classList.add("busy");
  say(`Reading ${file.name}…`);

  startHostTiming();

  try {
    const cartridge = await readCartridge(file);
    hostMark("verified");

    /*
     * Whose document is this?
     *
     * Verification proves nothing has changed since this container was signed.
     * It cannot prove who signed it, because somebody who alters a container
     * can replace the key and re-sign — every check passes, against their key.
     *
     * This device remembers which key each document was first opened with, so a
     * later copy signed by somebody else is visible. It matters more now than
     * when the desktop got it: this app takes containers from a link, and an
     * address that serves an update is an address that can serve an
     * impersonation.
     */
    /*
     * Looked at, not yet recorded.
     *
     * The pin is made after the person presses Open — the same rule the
     * publisher record already follows, and for the same reason. Made here,
     * on arrival, it was a pin nobody agreed to: a link loaded and closed
     * without a tap left the document's identity bound to whatever key that
     * link carried, and the genuine document then read as an impersonation,
     * with nothing in the library to delete and so no way to undo it.
     */
    const verdict = await trustVerdict(trustStore(), cartridge);
    if (verdict.status === "mismatch") {
      say(verdict.message, true);
      slot.classList.remove("busy");
      return;
    }

    /*
     * The card, for a document this device has not met before.
     *
     * Keyed on familiarity, not on carrier. It used to be shown for a link and
     * a share and not for a file the person picked, on the theory that picking
     * is an explicit act — but the question the card answers is "what is this
     * thing", and that question is the same whether it came by mail or by a
     * file chooser. So: a document not yet in this device's library, or one
     * whose key was not seen before, gets the card however it arrived. A
     * document already kept here under the same key opens directly, which is
     * what the third open behaving like an app means.
     *
     * Shown after verification, so every word on it — the name, the icon, the
     * publisher — is a checked fact rather than a claim the file made about
     * itself. Nothing mounts until it is asked for.
     */
    /*
     * And whose it is, as far as this device has seen (4.3). Decided before
     * the card, shown on it, and recorded only after the person proceeds — so
     * a conflict that was refused never becomes a pin.
     */
    const who = await publisherState(publisherStore(), cartridge, await confusables());
    installSuppressed = who.state === "conflict";

    /*
     * Identity (spec §9.5): a name somebody else vouched for, checked against
     * roots this opener holds. A public opener holds none, and then this is
     * simply absent — never a refusal, never the word verified.
     */
    const identity =
      cartridge.manifest.identity && cartridge.publicKey && cartridge.manifest.signature
        ? await verifyIdentity(
            cartridge.manifest.identity,
            cartridge.publicKey,
            cartridge.manifest.signature,
            await sigstoreRoots(),
          )
        : undefined;

    /*
     * Succession (4.1): the next version of something this device has.
     *
     * Decided here so the card can say what will happen, and applied after
     * the person opens it. Adopting is a copy of the previous document's
     * data into this one's; the previous document and its data stay exactly
     * as they were. Honoured only under the key this device pinned for the
     * document being replaced — otherwise anybody could claim to be the next
     * version of anything and walk off with what is in it.
     */
    const library = await listCartridgesFromLibrary();
    const succession = await planSuccession(cartridge, library);

    const familiar =
      verdict.status === "trusted" &&
      who.state !== "conflict" &&
      library.some((item) => item.documentUuid === cartridge.manifest.documentUuid);
    const consented =
      carrier.consentedFor !== undefined &&
      carrier.consentedFor === cartridge.manifest.documentUuid &&
      who.state !== "conflict";
    /*
     * The address named a different document than it carried.
     *
     * Not damage and not necessarily an attack — but it is what a hand-edited
     * link looks like, and the person is about to be shown a document they did
     * not expect. Saying it is cheap; leaving it unsaid means the only signal
     * is that the app on the card is not the one they thought they tapped.
     */
    const misdescribed =
      carrier.hinted !== undefined && carrier.hinted !== cartridge.manifest.documentUuid;
    if (!familiar && !consented) {
      slot.classList.remove("busy");
      say("");
      await showCard({
        name: cartridge.manifest.appName ?? "container",
        favicon: cartridge.manifest.favicon,
        ...describeApp(indexHtmlOf(cartridge)),
        size: file.size,
        dataBytes: cartridge.archive["document.sqlite"]?.length ?? 0,
        createdAt: cartridge.manifest.createdAt,
        fingerprint: cartridge.publicKeyFingerprint,
        publisher: who,
        identity: identity?.status === "shown" ? identity : undefined,
        from: misdescribed
          ? "The link carried a different document than its address named. " +
            "Nothing is uploaded — it runs on this device."
          : (carrier.from ?? "From a file on this device. Nothing is uploaded — it runs here."),
        succession: succession?.card,
        applied: ISOLATION_CLAUSES,
        clear: arrivedInClear,
        // A key worth naming: one this device may see again. Never for an
        // unsigned document, a test key, or a name in dispute.
        onNamePublisher:
          cartridge.publicKey && (who.state === "known" || who.state === "new" || who.state === "anonymous")
            ? () => void namePublisher(cartridge.publicKey!)
            : undefined,
      });
      slot.classList.add("busy");
    }
    // Agreed to, whether by pressing Open or by having kept it before. Only
    // now is a first sighting worth remembering.
    if (verdict.status === "unknown") {
      const pinned = await pinTrust(trustStore(), cartridge);
      // Another open of this document got its pin in first, with a different
      // key. What is remembered is what counts; this copy is the stranger.
      if (pinned.status === "mismatch") {
        say(pinned.message, true);
        slot.classList.remove("busy");
        return;
      }
    }
    await recordPublisher(publisherStore(), cartridge, await confusables());

    if (succession?.inherit) {
      // Copied, never moved: the previous document's own store is untouched.
      // Saved under this document's identity before it mounts, so a reload in
      // the middle of migrating finds the data where this document looks.
      await saveDatabaseToOpfs(cartridge.manifest.documentUuid, succession.inherit);
    }

    /*
     * Which copy of the data is the later one.
     *
     * Nearly always the one on this device: reopening a file mounts what has
     * been done since, not the state the file was built with. But a document
     * can come back. Two people playing a game by link send the same document
     * to and fro, and what arrives is the same application carrying data this
     * device has never seen — so mounting the stored copy over it dropped the
     * other person's move without a word.
     *
     * `savedAt` is written into the manifest by every reseal, outside the
     * signed set, and travels with the document. Later wins. Equal or older
     * loses, which is what makes an old link scrolled back to in a message
     * thread harmless: it cannot roll a game backwards.
     *
     * Wall clocks on two devices are not perfectly ordered. This decides
     * between two copies a person is holding, not between two writers racing,
     * and a skew large enough to matter is a skew a person would already have
     * noticed elsewhere.
     */
    const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    const arriving = savedAtOf(cartridge);
    const heldItem = library.find(
      (item) => item.documentUuid === cartridge.manifest.documentUuid,
    );
    const brought =
      Boolean(opfsDb && opfsDb.byteLength > 0) &&
      arriving !== undefined &&
      heldItem?.savedAt !== undefined &&
      arriving > heldItem.savedAt;

    if (opfsDb && opfsDb.byteLength > 0 && !brought) {
      loaded = await resealCartridge(cartridge, opfsDb);
      if (arriving !== undefined && heldItem?.savedAt !== undefined && arriving < heldItem.savedAt) {
        // Said rather than done silently: somebody who opened an older link
        // and saw their own game is owed the reason it did not change.
        say(
          `This link is an older copy of ${loaded.manifest.appName ?? "this document"} than the one on this device. ` +
            `Nothing was changed.`,
        );
      }
    } else {
      // What arrived is the later copy, so it is the one that mounts — and it
      // is written to this device's storage before the application starts, so
      // a reload finds the data the person just watched arrive.
      loaded = cartridge;
      const incoming = cartridge.archive["document.sqlite"];
      if (brought && incoming && incoming.byteLength > 0) {
        await saveDatabaseToOpfs(cartridge.manifest.documentUuid, incoming);
      }
    }

    // Kept on this device — and said only once it is. Storage can refuse
    // (a private window, a full quota); the document still opens, and the
    // menu says it was not kept rather than promising it was.
    try {
      await saveCartridgeToLibrary({
        documentUuid: loaded.manifest.documentUuid,
        appName: loaded.manifest.appName ?? "container",
        lastOpened: new Date().toISOString(),
        /*
         * When the data was last written, not when it was last mounted.
         *
         * Opening reseals the container around the stored database, and a
         * reseal stamps `savedAt` with the time it ran — so reading it off
         * `loaded` here would move this copy's clock forward every time the
         * document was opened, with nothing changed. A copy opened after the
         * other person moved would then look newer than their move and refuse
         * it, which is the bug this whole change exists to fix, reintroduced
         * one line further on.
         *
         * So: the arriving copy's own stamp when it won, and otherwise the
         * one already recorded here, untouched.
         */
        savedAt: brought ? savedAtOf(cartridge) : (heldItem?.savedAt ?? savedAtOf(cartridge)),
        html: loaded.html,
        publicKeyFingerprint: loaded.publicKeyFingerprint,
        revision: await learnRevision(loaded.manifest.documentUuid),
      });
      keptOnDevice = true;
    } catch {
      keptOnDevice = false;
    }

    rememberOpen(loaded.manifest.documentUuid);

    /*
     * On iOS, Open loads the page at the document's own address.
     *
     * The person decided when they pressed Open; asking again with "Keep
     * it" was a second question about the same decision. iOS reads a
     * home-screen icon's name and address from the manifest the page linked
     * when it loaded, so the page is loaded there now — described by the
     * worker, opened from the copy just kept — and Add to Home Screen is
     * one gesture away from this moment on. One extra load, behind the
     * launch screen; other platforms read the manifest live and need none.
     */
    if (platform() === "ios" && keptOnDevice) {
      const identity = {
        uuid: loaded.manifest.documentUuid,
        name: loaded.manifest.appName ?? "container",
        favicon: loaded.manifest.favicon,
        opens: 0,
        link: arrivedByLink ?? (await launchLinkForDocument(loaded.html)),
      };
      // Kept, so the manifest can be described again once the app's colour
      // is known, which is after it has drawn.
      describedIdentity = identity;
      if (!sameLaunch(location.href, launchAddress(identity))) {
        /*
         * The colour under the clock, learned before the load that counts.
         *
         * iOS reads the status bar's colour as a page first appears and not
         * again, and a document opened for the first time on a device has
         * nothing remembered and nothing in its address. So the document is
         * mounted here first, behind the launch screen, until it has said
         * what colour it is — at once when it declares one, a moment after
         * it has drawn otherwise — and the address it is then loaded at
         * carries the colour. One boot more on a first open, and the first
         * frame anybody sees is the right one.
         */
        hostMark("prepared");
        rehearsing = true;
        await mount(loaded);
        await groundSettled(loaded.manifest.documentUuid, 2500);
        await describeDocument(identity);
        /*
         * A real load, even when only the fragment moved.
         *
         * The point of this navigation is the load: iOS reads the status bar
         * colour and the manifest as a page first appears, and not again. The
         * hint moved from `?doc=` into the fragment (`#u=`), and a navigation
         * that changes nothing but the fragment is a same-document navigation
         * — the address changes, no load happens, and neither the colour nor
         * the manifest is re-read. So when that is the only difference, the
         * address is set and the reload asked for explicitly.
         */
        const target = launchAddress(identity);
        if (target.split("#")[0] === location.href.split("#")[0]) {
          location.hash = new URL(target).hash;
          location.reload();
        } else {
          location.replace(target);
        }
        return;
      }
    }

    hostMark("prepared");
    await mount(loaded);
    hostMark("mounted");
  } catch (error) {
    const message =
      error instanceof ContainerError
        ? error.message
        : `This file could not be opened (${(error as Error).message}).`;
    say(message, true);
  } finally {
    slot.classList.remove("busy");
    void refreshLibrary();
  }
}

async function exportContainer(): Promise<void> {
  if (!loaded) return;

  const opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
  const activeCartridge = opfsDb ? await resealCartridge(loaded, opfsDb) : loaded;
  loaded = activeCartridge;

  const name = activeCartridge.manifest.appName ?? "container";
  const fileName = `${name}.dai.html`;

  /*
   * A copy leaves here complete, whatever arrived.
   *
   * A document published without its engine (§6.2) runs here because this app
   * holds that engine. The copy somebody saves has to stand on its own: they
   * are going to mail it, or open it on a machine that has never seen this
   * site, and a copy that only works where it was made is not a copy of the
   * document. So the bytes go back in, and the result is the file the complete
   * build produced — byte for byte, which is the claim that makes the two
   * forms one document.
   *
   * A resealed container is already complete: resealing packs the archive this
   * app verified, engine included, so `supplied` is empty by then and this
   * does nothing.
   */
  const html =
    activeCartridge.supplied.length > 0 ? refatten(activeCartridge) : activeCartridge.html;
  const file = new File([html], fileName, { type: "text/html" });

  // Once a copy exists as a file, the iOS home-screen steps get shorter.
  arrivedAsFile = true;

  /*
   * A phone shares; a computer saves.
   *
   * Windows Edge answers yes to "can you share a file", and the answer put a
   * Windows share sheet — Teams, Outlook, Nearby Sharing — in front of
   * somebody who had pressed Save a copy. On a computer a copy is a file on
   * the disk: the save dialog where the browser has one, a download where it
   * does not.
   */
  if (platform() === "desktop") {
    const picker = (window as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> })
      .showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [{ description: "DAI document", accept: { "text/html": [".html"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(html);
        await writable.close();
        return;
      } catch (error) {
        // Cancelled is a choice; anything else falls through to a download.
        if ((error as { name?: string }).name === "AbortError") return;
      }
    }
  } else {
    // The same decision the website makes, from the same place. A device that
    // will not take a file directly is why the download below exists, and two
    // implementations of "can this device take a file" would eventually
    // disagree about the device somebody is holding.
    /*
     * The message carries a link to *this* document (backlog 2.6).
     *
     * It used to name the opener's address, which told a recipient where to go
     * and nothing about what they had: they still had to find the attachment
     * and hand it over themselves. A link to the document is the whole thing —
     * tap it and it opens — and the file travels beside it for the person who
     * would rather keep one. Above the cap there is no link, and the sentence
     * falls back to the address, which is what it always was.
     */
    const shareLink = await linkForDocument(html);
    const handed = await handOff(
      navigator,
      file,
      name,
      // What a recipient with nothing installed needs, in the only place it
      // can reach them: the message the file arrives in.
      shareLink
        ? `${name} — ${STANDING_LINE} Tap to open it:\n${shareLink}`
        : `${name} — ${STANDING_LINE} This one holds its app and its data in one ` +
            `file. Open it at ${OPENER}`,
    );
    // Dismissed rather than failed: offering a download after somebody
    // declined to save would be the app arguing with them.
    if (handed.shared || !handed.error) return;
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/**
 * The value the mounted container invented, echoed back on the acknowledgement
 * and required on everything after it.
 *
 * Without it this window acts on any message of the right shape from any
 * window that has a reference to it — including a save, which writes to storage
 * under a document's own identity. The nonce does not say the container is
 * trustworthy; it says the message came from the one this runner mounted.
 */
let mountedNonce: string | null = null;

/**
 * Where somebody holding one of these can find out what to do with it.
 *
 * "Open" rather than "run", in both the verb and the address: a person opens a
 * document, and a message telling a stranger to *run* a file they were sent is
 * the sentence everybody has been trained to delete.
 */
const OPENER = "opendai.app";


/** Milliseconds from the container starting to the application being usable. */
let lastOpenMs: number | null = null;

/**
 * What this app spends before the container starts.
 *
 * The container measures its own boot and can see nothing before it, so a chain
 * that stopped at its first mark would be optimising the visible half. Reading
 * the file, verifying every digest and assembling the document to mount all
 * happen here — and for the sectioned form the last of those is not free, since
 * the manifest and the payload have to be put back together before a shell can
 * carry them.
 */
let lastHostPhases: { phase: string; at: number }[] = [];
let hostStarted = 0;

function startHostTiming(): void {
  hostStarted = performance.now();
  lastHostPhases = [];
}

function hostMark(phase: string): void {
  lastHostPhases.push({
    phase,
    at: Math.round((performance.now() - hostStarted) * 10) / 10,
  });
}

function recordTimings(timings?: { phase: string; at: number }[]): void {
  if (!timings?.length) return;

  (window as unknown as { __daiTimings?: unknown }).__daiTimings = timings;

  const interactive = timings.find((entry) => entry.phase === "interactive");
  if (!interactive) return;

  lastOpenMs = interactive.at;

  // The whole chain, in the order a person experiences it: what this app did
  // with the file, then what the container did with itself.
  const host = lastHostPhases.length ? lastHostPhases[lastHostPhases.length - 1]!.at : 0;
  (window as unknown as { __daiHostTimings?: unknown }).__daiHostTimings = lastHostPhases;

  if (new URLSearchParams(location.search).has("timing")) {
    say(
      `Usable in ${Math.round(host + lastOpenMs)} ms — ` +
        `host ${Math.round(host)} ms (` +
        lastHostPhases.map((entry) => `${entry.phase} ${Math.round(entry.at)}`).join(", ") +
        `), container ${Math.round(lastOpenMs)} ms (` +
        timings.map((entry) => `${entry.phase} ${Math.round(entry.at)}`).join(", ") +
        ")",
    );
  }
}

/**
 * When a container was last saved, from the manifest sealed around its data.
 *
 * Written by every reseal and carried by every carrier, so it is the one
 * number that can order two copies of the same document that have been apart.
 * Absent on a document nobody has saved yet, which orders nothing and is why
 * every comparison here requires both sides to have one.
 */
function savedAtOf(container: { manifest: Record<string, unknown> }): string | undefined {
  const at = container.manifest["savedAt"];
  return typeof at === "string" && at ? at : undefined;
}

/** Whether a message came from the container this runner is showing. */
function fromMountedContainer(event: MessageEvent, data: { sessionNonce?: string }): boolean {
  if (event.source !== cartridgeFrame.contentWindow) return false;
  return Boolean(mountedNonce) && data.sessionNonce === mountedNonce;
}

// Host-Runner Bridge Protocol: handle DAI_HOST_HANDSHAKE and DAI_HOST_SAVE
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "dai:isolation-report") {
    // Kept for the harness that holds this host's claim against the probe.
    if (event.source === cartridgeFrame.contentWindow) lastIsolationReport = data;
    return;
  }

  if (data.type === "DAI_HOST_HANDSHAKE") {
    // The frame this runner mounted, and no other window.
    if (event.source !== cartridgeFrame.contentWindow) return;
    handshakeEstablished = true;
    mountedNonce = (data.payload?.sessionNonce as string) ?? null;

    // Where the edges of the screen are. The application draws to them now,
    // and is the one document that cannot measure them. See tellInsets.
    tellInsets();
    tellCanvas();

    /*
     * How long the container took to become usable, on this device.
     *
     * The number that decides whether this is a product on a phone is seconds
     * from tap to interactive, and it cannot be measured anywhere else: a
     * desktop is not a mid-range Android over cellular. The container reports
     * where it spent its time; this is the only place that can say how long
     * that took on the hardware somebody is actually holding.
     *
     * Kept on the window rather than shown, until there is a reason to show it.
     */
    recordTimings(data.payload?.timings as { phase: string; at: number }[] | undefined);

    (event.source as Window | null)?.postMessage(
      {
        type: "DAI_HOST_HANDSHAKE_ACK",
        // A viewer: this host keeps a copy on the device and can export. It
        // cannot write the file it was given in place, and it says so.
        // What this host applies, by the probe's own ids. A claim, checked in
        // CI by mounting the probe here; see src/host-profile.ts.
        payload: { sessionNonce: mountedNonce, hostClass: "viewer", applied: ISOLATION_CLAUSES },
      },
      "*",
    );
  } else if (data.type === "DAI_HOST_REFUSED") {
    /*
     * The shell refused to run what it was handed — most often the schema
     * gate: data written by one version of an application that this version
     * has no migration for. Until now that stayed inside the frame, where the
     * application had already failed to draw anything. The person saw a blank
     * pane. It is a refusal, so it is said here, loudly, in the words the
     * shell chose, and the frame comes down.
     */
    /*
     * The refusal carries its nonce inside the payload, unlike the other
     * bridge messages, because it can be sent before the handshake settles —
     * and most are: the shell refuses on the payload, the manifest, a digest,
     * a signature or a missing index.html *before* it handshakes, so at that
     * moment this host has no nonce to compare. A review found the check
     * below demanding one anyway, which dropped every early refusal on the
     * floor and left the person looking at a blank frame. What identifies an
     * early refusal is the window it came from; once a handshake has given
     * this host a nonce, a refusal must carry it.
     */
    const refusal = (data.payload ?? {}) as {
      sessionNonce?: string;
      reason?: string;
      message?: string;
      detail?: string;
    };
    if (event.source !== cartridgeFrame.contentWindow) return;
    if (mountedNonce && refusal.sessionNonce !== mountedNonce) return;
    if (refusal.reason === "MOUNT_TIMEOUT") {
      /*
       * Not a verdict on the document. The shell waited as long as it was
       * prepared to and the application had not reported in; on a slow phone
       * the boot may still be running and may yet finish. Said, so the person
       * is not left guessing — but the frame stays up, because pulling it
       * down under an application that then finishes mounting is the one
       * outcome worse than waiting.
       */
      say(`${refusal.message ?? "The application is taking a long time to start."} It may still finish.`);
      return;
    }
    say(
      `${refusal.message ?? "This document could not be opened."}${refusal.detail ? ` ${refusal.detail}` : ""} ` +
        `Nothing has been changed or lost.`,
      true,
    );
    window.clearTimeout(bootingGuard);
    document.body.classList.remove("loaded", "booting");
  } else if (data.type === "DAI_HOST_GROUND") {
    // The colour at the top edge of the application, measured by it once it
    // had painted, for the strip above it that only this page can colour.
    // An application that declared a theme-color said what that strip should
    // be, and what it said stands.
    if (!fromMountedContainer(event, data)) return;
    if (declaredGround) return;
    const colour = typeof data.colour === "string" ? data.colour.trim() : "";
    if (!COLOUR.test(colour)) return;
    settleGround(colour);
  } else if (data.type === "DAI_HOST_REQUEST_SHARE") {
    /*
     * The application asked for its host's own share sheet.
     *
     * Identical to a tap on the menu's "Share app": the same sheet, the same
     * name and icon read from the same manifest, the same choice of whether
     * to include data, the same press of Send before anything is built. The
     * application chose the moment; the person still chooses what happens.
     */
    if (!fromMountedContainer(event, data)) return;
    void sendDocument();
  } else if (data.type === "DAI_HOST_SAVE_STATE") {
    // The runtime's own account of where the data stands. Shown, never
    // inferred: a green word here means the host acknowledged a write.
    if (!fromMountedContainer(event, data)) return;
    const state = String(data.state ?? "");
    const el = document.getElementById("save-state");
    if (!el) return;
    el.dataset.state = state;
    el.hidden = state === "idle";
    el.textContent = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : state === "failed" ? "Not saved" : "";
    el.title = state === "failed" && typeof data.error === "string" ? data.error : "";
    /*
     * "Saved" says its piece and goes.
     *
     * A word that stays is a word somebody reads once and then looks past,
     * and it was the only text left in a bar that is otherwise an icon and a
     * menu. Saving and Not saved stay up, because one is still happening and
     * the other is still true. The text is left on the element when it goes,
     * so what it last said can still be read from the page.
     */
    window.clearTimeout(savedFor);
    if (state === "saved") savedFor = window.setTimeout(() => { el.hidden = true; }, 3000);
    if (state === "failed") {
      say(
        `This document could not be saved on this device${typeof data.error === "string" ? ` (${data.error})` : ""}. ` +
          `Your changes are still here; save a copy from the menu to keep them.`,
        true,
      );
    }
  } else if (data.type === "DAI_HOST_TIMING") {
    // The boot finished. The handshake went out before the application had
    // painted, so this is the message carrying the number that matters.
    if (fromMountedContainer(event, data)) {
      recordTimings(data.payload?.timings as { phase: string; at: number }[] | undefined);
      // The app has drawn: the launch screen has done its job — unless a
      // first open on iOS is about to load the page again (see rehearsing).
      window.clearTimeout(bootingGuard);
      if (!rehearsing) document.body.classList.remove("booting");
    }
  } else if (data.type === "DAI_HOST_USED") {
    /*
     * Somebody used the document: they ticked something, added something, or
     * saved. Only now is "keep this on your device" an offer rather than an
     * interruption in front of a person who has not yet seen it work.
     */
    // Not offered on an open the card called a conflict: a stranger wearing a
    // known name does not get an icon on the home screen out of it.
    // Not during a rehearsal: that use is the kit's own, on a page nobody
    // has touched, and the offer is once per document.
    if (fromMountedContainer(event, data) && !installSuppressed && !rehearsing) keeper?.offer();
  } else if (data.type === "DAI_HOST_SAVE") {
    // A save writes to this device's storage under a document's identity, so it
    // is answered only for the container that handshook.
    if (!fromMountedContainer(event, data)) return;
    hostSaves += 1;
    // Echoed on the reply so the container can tell this answer from any
    // other message that happens to be shaped like one.
    const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    const { databaseBytes, documentUuid } = data.payload || {};
    if (databaseBytes && documentUuid) {
      const bytes = new Uint8Array(databaseBytes);
      /*
       * One save at a time per document, across every tab of this origin.
       * Two tabs on one document each write the whole database; without the
       * lock the second write can land under the first's reseal and the
       * library keeps a copy that matches neither.
       */
      const key = `dai:${documentUuid}`;
      const locked = <T,>(work: () => Promise<T>): Promise<T> =>
        navigator.locks?.request
          ? navigator.locks.request(key, { mode: "exclusive" }, work)
          : work();
      /*
       * Held through the whole of it — the revision check, the database, the
       * reseal, the library — so no tab sees the database at one revision
       * and the library at another. And the revision: the library record
       * counts the saves committed for this document, and a tab that did
       * not see the latest one is behind another tab. Its save is refused
       * rather than written, because its whole database would put the
       * other tab's work back; the runtime keeps the changes pending and
       * says so in the header, and Save a copy is in the menu.
       */
      locked(async () => {
        const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
        const current = held?.revision ?? 0;
        if (knownRevision.has(documentUuid) && knownRevision.get(documentUuid) !== current) {
          throw new Error(
            "This document was saved from another tab since it was opened here. " +
              "To keep these changes, use Save a copy; to see the other tab's, reopen it.",
          );
        }
        await saveDatabaseToOpfs(documentUuid, bytes);
        const next = current + 1;
        if (loaded && loaded.manifest.documentUuid === documentUuid) {
          loaded = await resealCartridge(loaded, bytes);
          await saveCartridgeToLibrary({
            documentUuid: loaded.manifest.documentUuid,
            appName: loaded.manifest.appName ?? "container",
            lastOpened: new Date().toISOString(),
            // Stamped by the reseal a line above. Without it here, this
            // device has no record of when its own copy was last written,
            // and an arriving copy cannot be told newer or older than it.
            savedAt: savedAtOf(loaded),
            html: loaded.html,
            publicKeyFingerprint: loaded.publicKeyFingerprint,
            revision: next,
          });
        } else if (held) {
          await saveCartridgeToLibrary({ ...held, revision: next });
        }
        knownRevision.set(documentUuid, next);
      })
        .then(async () => {
          (event.source as Window | null)?.postMessage(
            { type: "DAI_HOST_SAVE_ACK", status: "ok", requestId },
            "*",
          );
        })
        .catch((error: unknown) => {
          (event.source as Window | null)?.postMessage(
            { type: "DAI_HOST_SAVE_ACK", status: "error", error: String(error), requestId },
            "*",
          );
        });
    }
  }
});

const closeSheet = (): void => {
  slideClose(sheet);
};

openButton.addEventListener("click", () => fileInput.click());
moreButton.addEventListener("click", () => {
  slideOpen(sheet);
});
document.getElementById("save-state")?.addEventListener("click", (event) => {
  if ((event.currentTarget as HTMLElement).dataset.state === "failed") slideOpen(sheet);
});
// Anywhere off the panel dismisses it, which is what a sheet does everywhere
// else on a phone.
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSheet();
});

/**
 * Remove from this device: the one destructive act, and the honest
 * replacement for a library's delete. This device forgets the document, its
 * data and its trust pin. A copy saved or sent is untouched, and the
 * question says so.
 */
// Keeping it is a menu item now, and what it opens is a sheet of its own:
// the menu closes rather than stacking one sheet on another.
document.getElementById("keep-cta")?.addEventListener("click", () => closeSheet());

document.getElementById("remove")?.addEventListener("click", () => {
  closeSheet();
  if (!loaded) return;
  const name = loaded.manifest.appName ?? "this document";
  /*
   * What it does, and the part somebody found out afterwards.
   *
   * This deletes what is stored here. It cannot delete a home-screen icon —
   * no page can — and an icon carries the application inside its own address,
   * so tapping it afterwards opens the app again with nothing in it. Somebody
   * who read "Remove from this device" and then found the icon still working
   * had no way to tell whether the removal had done anything at all.
   */
  const sure = window.confirm(
    `Remove ${name} from this device?\n\n` +
      `Everything you have entered here is deleted. A copy you saved or sent is not affected.\n\n` +
      `An icon you added to your home screen stays there, and still opens the app — empty.`,
  );
  if (!sure) return;
  void deleteApp(loaded.manifest.documentUuid).then(() => {
    say(`${name} was removed. What you had entered here is gone.`);
  });
});

/**
 * The document as a link, on the clipboard.
 *
 * The compact carrier sends the application and rebuilds the runtime on the
 * other side, so a small app is a few kilobytes of address. Above the cap the
 * sender is told rather than handed a link that a chat client will cut; what
 * to do instead is the reference link, item 2.3.
 */
/**
 * The link for a document, as this opener can make one.
 *
 * Inline only: an opener holds no credentials for a store, so a document too
 * large for a fragment has no link from here and the person is told to send
 * the file. The decision itself is `linkFor` in the core, so this host, the
 * command line and the MCP server all answer the same way.
 */
async function linkForDocument(html: string): Promise<string | undefined> {
  const handoff = await linkFor(html, {
    // The opener's root, whatever path this page is at: a link made from
    // /d/<id> is still a link to the opener, not to that document's address.
    opener: location.origin + "/",
    host: { template: HOST_TEMPLATE, runtime: HOST_RUNTIME },
  });
  return handoff.kind === "inline" ? handoff.link : undefined;
}

/**
 * The address an icon launches with, for a document that came as a file.
 *
 * Not the chat link: that one is capped where linkifiers cut, and a custom
 * app a person had made — the first thing anybody keeps — is bigger than a
 * chat allows and was landing its icon on "open the file once". An icon's
 * address is read by the operating system, so it carries the whole document
 * up to a cap the browser sets, not a chat.
 */
async function launchLinkForDocument(html: string): Promise<string | undefined> {
  return inlineLink(html, location.origin + "/", { template: HOST_TEMPLATE, runtime: HOST_RUNTIME }, LAUNCH_CAP);
}

/**
 * Send: a link the other person taps and is in the app.
 *
 * A phone test settled what "send a copy" must not be. The file went over
 * iMessage as an attachment, the recipient tapped it, and Quick Look — which
 * shows HTML and never runs it — put our fallback line in front of them. A
 * document is sent as a link. When it fits an address it travels inside the
 * link and nothing is uploaded; when it does not, it is sealed with a fresh
 * key and put in the store, and only the link holds the key. The store
 * cannot read what it holds; the message preview shows the name and icon,
 * the way a phone shows them for any app it shares.
 *
 * On a phone the link goes to the share sheet, so iMessage shows the card.
 * On a computer it goes to the clipboard. If the store cannot be reached the
 * file is offered instead, and the person is told why.
 */
/**
 * Asks the running application to write anything pending, and waits.
 *
 * Autosave lands shortly after the last edit; a share packaged inside that
 * window would send the state before the edit. The request goes host →
 * shell → frame and the answer comes back the same way, after the save has
 * been acknowledged. A shell that does not answer — an older one — is given
 * a moment and then not waited for.
 */
function flushDocument(): Promise<void> {
  const target = cartridgeFrame.contentWindow;
  if (!target || !mountedNonce) return Promise.resolve();
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onFlushed);
      resolve();
    }, 2500);
    const onFlushed = (event: MessageEvent): void => {
      const data = event.data as { type?: string; id?: string; sessionNonce?: string } | null;
      if (!data || data.type !== "DAI_HOST_FLUSHED" || data.id !== id) return;
      if (!fromMountedContainer(event, data)) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onFlushed);
      resolve();
    };
    window.addEventListener("message", onFlushed);
    target.postMessage({ type: "DAI_HOST_FLUSH", id }, "*");
  });
}

/**
 * What a merge did, as the frame reports it (T1-D20).
 */
export interface MergeReport {
  applied: number;
  duplicate: number;
  rejected: string[];
  newReplicas: number;
  conflicts: number;
  refused?: string;
}

/**
 * The merge module this host holds, fetched once.
 *
 * Held by the host and never by a document: the rules about what merges and
 * what is refused are this side's, and a document shipping its own copy could
 * accept rows this one would refuse. Fetched rather than bundled because a
 * document that never merges should not carry it — it is ten per cent of a
 * minimal container, paid by every document including the ones that can never
 * use it.
 *
 * The frame checks it against a digest compiled into its own runtime before
 * importing it, so nothing here has to be trusted about what it hands over.
 */
let mergeSource: string | null = null;

async function loadMergeModule(): Promise<string> {
  if (mergeSource !== null) return mergeSource;
  const response = await fetch(new URL("runtime/dai-merge.js", location.href), { cache: "force-cache" });
  if (!response.ok) throw new Error("MERGE_UNAVAILABLE");
  mergeSource = await response.text();
  return mergeSource;
}

/**
 * Hands a sibling's data section to the frame and waits for the counts.
 *
 * The sibling has already been verified as a container by the time this runs —
 * same document, same publisher, compatible schema. The frame merges rows and
 * does not re-decide any of that; it opens the bytes inside the sandbox
 * because they are somebody else's SQLite file, which is the one thing on this
 * path that has to be treated as hostile.
 */
async function mergeSiblingInto(databaseBytes: Uint8Array, level = 1): Promise<MergeReport> {
  const target = cartridgeFrame.contentWindow;
  const refused = (why: string): MergeReport => ({
    applied: 0,
    duplicate: 0,
    rejected: [],
    newReplicas: 0,
    conflicts: 0,
    refused: why,
  });
  if (!target || !mountedNonce) return refused("NO_DOCUMENT_OPEN");

  let source: string;
  try {
    source = await loadMergeModule();
  } catch {
    return refused("MERGE_UNAVAILABLE");
  }

  const id = Math.random().toString(36).slice(2);
  return new Promise<MergeReport>((resolve) => {
    // A merge that never answers must not leave the person waiting on a
    // spinner with no account of why. Long enough for a large document to be
    // read and written; short enough to be a failure rather than a hang.
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onResult);
      resolve(refused("MERGE_TIMED_OUT"));
    }, 30_000);
    const onResult = (event: MessageEvent): void => {
      const data = event.data as ({ type?: string; sessionNonce?: string } & MergeReport) | null;
      if (!data || data.type !== "DAI_HOST_MERGE_RESULT") return;
      if (!fromMountedContainer(event, data)) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onResult);
      const { applied, duplicate, rejected, newReplicas, conflicts, refused: why } = data;
      resolve({ applied, duplicate, rejected, newReplicas, conflicts, ...(why ? { refused: why } : {}) });
    };
    window.addEventListener("message", onResult);
    target.postMessage(
      { type: "DAI_HOST_MERGE", id, payload: { databaseBytes, mergeSource: source, level } },
      "*",
    );
  });
}

/**
 * The document as it stands, or as it arrived: with the person's data, or as
 * a blank copy — the same app with an empty database, which the schema and
 * seed rows fill on first open. Flushed first, so a share is the state the
 * sender sees.
 */
async function currentHtml(withData = true): Promise<string> {
  if (!loaded) throw new Error("nothing open");
  if (!withData) {
    const blank = await resealCartridge(loaded, new Uint8Array(0));
    return blank.supplied.length > 0 ? refatten(blank) : blank.html;
  }
  await flushDocument();
  const opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
  const current = opfsDb ? await resealCartridge(loaded, opfsDb) : loaded;
  return current.supplied.length > 0 ? refatten(current) : current.html;
}

/** The preview icon, as a PNG under the store's cap, or none. */
async function previewIcon(favicon: string | undefined): Promise<{ png: Uint8Array } | undefined> {
  for (const size of [512, 256, 128]) {
    const blob = await iconPng(favicon, size);
    if (!blob) return undefined;
    if (blob.size <= ICON_CAP) return { png: new Uint8Array(await blob.arrayBuffer()) };
  }
  return undefined;
}

/**
 * The link for this document, made the way it has to be made: inline when it
 * fits, otherwise through the store. Returns where it came from too, so the
 * sheet can say whether anything left the device.
 */
async function linkToSend(html: string, preview: boolean): Promise<{ link: string; uploaded: boolean }> {
  const store = STORE_BASE
    ? presignedStore({ presignUrl: new URL("/api/presign", location.origin).href, publicBase: STORE_BASE })
    : undefined;
  const icon = preview && loaded ? await previewIcon(loaded.manifest.favicon) : undefined;
  /*
   * Through the store, whatever the size.
   *
   * A small document used to travel inside its link and nothing left the
   * device. Then a card was stored for it, so a chat could show one - and
   * the sender's phone did show one, and sent the other person the bare
   * address. A rich link travels only for a short address; a document
   * inside its address is tens of kilobytes, and what arrives is text that
   * a chat may not even keep whole. So every document sent from here goes
   * the way the large ones always did: sealed, with the key in the fragment
   * and an address a few hundred characters long, and the card beside it.
   * The store cannot read what it holds, and a share can be taken back.
   *
   * Inside the link is still what a document does when there is no store
   * to reach: the link goes without a card rather than not at all.
   */
  if (store) {
    try {
      const { links, sealed } = await publish(html, store, location.origin + "/", { preview, icon });
      // Remembered, so the person who shared it can take it back (see retireShares).
      if (loaded) await rememberShare(loaded.manifest.documentUuid, { hash: sealed.hash, retire: sealed.retire, at: new Date().toISOString() });
      return { link: withGround(links.known), uploaded: true };
    } catch (error) {
      const inline = await linkForDocument(html);
      if (!inline) throw error;
      return { link: withGround(inline), uploaded: false };
    }
  }
  const inline = await linkForDocument(html);
  if (inline) return { link: withGround(inline), uploaded: false };
  throw new Error("This opener has no store, so a document this large can only be sent as a file.");
}

async function rememberShare(documentUuid: string, share: Share): Promise<void> {
  try {
    const held = await getCartridgeFromLibrary(documentUuid);
    if (!held) return;
    const shares = [...(held.shares ?? []).filter((s) => s.hash !== share.hash), share].slice(-20);
    await saveCartridgeToLibrary({ ...held, shares });
  } catch {
    /* Not kept on this device; there is nowhere to remember it. */
  }
}

/**
 * Retires every link this device made through the store for the document.
 *
 * The store removes the blob, its record and its icon; the links stop
 * opening. What people already opened is on their devices and stays theirs —
 * said, so nobody takes this for a recall.
 */
async function retireShares(documentUuid: string): Promise<{ retired: number; failed: number; cards: number }> {
  const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  const shares = held?.shares ?? [];
  let retired = 0;
  let failed = 0;
  // How many of those retired were cards only: the link still opens.
  let cards = 0;
  const remaining: Share[] = [];
  for (const share of shares) {
    try {
      const response = await fetch(new URL("/api/forget", location.origin).href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hash: share.hash, token: share.retire }),
      });
      if (response.ok) {
        retired += 1;
        if (share.card) cards += 1;
      } else {
        failed += 1;
        remaining.push(share);
      }
    } catch {
      failed += 1;
      remaining.push(share);
    }
  }
  if (held) await saveCartridgeToLibrary({ ...held, shares: remaining }).catch(() => undefined);
  return { retired, failed, cards };
}

/**
 * What the control offers to take back. A link made through the store stops
 * opening; a link that carried the app inside it only loses its card, and
 * the control says which, so nobody presses it expecting the other.
 */
function retireLabel(shares: Share[]): string {
  const n = shares.length;
  if (n > 0 && shares.every((share) => share.card)) {
    return n === 1 ? "Take down the card from the link I shared" : `Take down the cards from the ${n} links I shared`;
  }
  return n === 1 ? "Stop the link I shared before" : `Stop the ${n} links I shared before`;
}

async function sendDocument(): Promise<void> {
  if (!loaded) return;
  const name = loaded.manifest.appName ?? "this document";
  const sheetEl = document.getElementById("send-sheet");
  const icon = document.getElementById("send-icon") as HTMLImageElement | null;
  const titleEl = document.getElementById("send-title");
  const sub = document.getElementById("send-sub");
  const withData = document.getElementById("send-with-data") as HTMLInputElement | null;
  const note = document.getElementById("send-note");
  const go = document.getElementById("send-go") as HTMLButtonElement | null;
  const cancel = document.getElementById("send-cancel");
  const retire = document.getElementById("send-retire") as HTMLButtonElement | null;
  if (!sheetEl || !icon || !titleEl || !sub || !withData || !note || !go || !cancel || !retire) return;

  // Links made before, through the store, and the way to take them back.
  const uuid = loaded.manifest.documentUuid;
  const earlier = (await getCartridgeFromLibrary(uuid).catch(() => null))?.shares ?? [];
  retire.hidden = earlier.length === 0;
  retire.disabled = false;
  retire.textContent = retireLabel(earlier);
  retire.onclick = async () => {
    retire.disabled = true;
    retire.textContent = "Stopping…";
    const { retired, failed, cards } = await retireShares(uuid);
    const left = (await getCartridgeFromLibrary(uuid).catch(() => null))?.shares ?? [];
    retire.hidden = failed === 0;
    retire.disabled = false;
    retire.textContent = retireLabel(left);
    const onlyCards = retired > 0 && cards === retired;
    say(
      retired > 0
        ? (onlyCards
            ? `${retired === 1 ? "The card is gone from that link" : `The cards are gone from those ${retired} links`}. The link still opens: the app is inside it.`
            : `${retired === 1 ? "That link no longer opens" : `${retired} links no longer open`}. Anyone who already opened it keeps their copy.`) +
            (failed > 0 ? ` ${failed} could not be stopped; try again later.` : "")
        : "Those links could not be stopped just now. Try again later.",
      retired === 0,
    );
  };

  // Through the store when there is one, whatever the size (see linkToSend).
  const viaStore = Boolean(STORE_BASE);
  const canShare = typeof navigator.share === "function";
  const url = faviconUrl(loaded.manifest.favicon);
  icon.hidden = !url;
  if (url) icon.src = url;
  titleEl.textContent = `Share ${name}`;
  sub.textContent = viaStore
    ? "Sealed with a key that only the link holds, then put in the store, which cannot read it."
    : "The whole app travels inside the link. Nothing is uploaded.";
  withData.checked = true;
  const describe = (): void => {
    note.textContent = withData.checked
      ? "Anyone with the link can open it, with what is in it now."
      : "Anyone with the link gets the app as it arrived, with none of your entries.";
  };
  describe();
  withData.onchange = describe;
  go.textContent = canShare ? "Share" : "Copy link";
  go.disabled = false;
  slideOpen(sheetEl);

  const close = (): void => {
    slideClose(sheetEl);
    go.onclick = null;
    cancel.removeEventListener("click", close);
  };
  cancel.addEventListener("click", close);
  sheetEl.onclick = (event) => {
    if (event.target === sheetEl) close();
  };

  go.onclick = async () => {
    go.disabled = true;
    go.textContent = viaStore ? "Sealing…" : "Preparing…";
    let made: { link: string; uploaded: boolean };
    try {
      // Packaged now, not when the sheet opened: what goes is what the
      // person sees at the moment they press Share.
      const html = await currentHtml(withData.checked);
      // The name and icon go with it, as they do when a phone shares any
      // app; the person can take the card off in the share sheet itself.
      made = await linkToSend(html, true);
    } catch (error) {
      close();
      say(
        `${error instanceof Error ? error.message : "The store could not be reached."} ` +
          `Sharing the file instead — the other person will need to open it at ${OPENER}.`,
        true,
      );
      await exportContainer();
      return;
    }
    close();
    // The card and nothing beside it. A line of text under the card was
    // this app talking over the app being sent; the card already says the
    // name, shows the icon, and where it opens.
    if (canShare) {
      try {
        await navigator.share({ title: name, url: made.link });
        say(made.uploaded ? "Shared. The store holds a sealed copy only the link can open." : "Shared.");
        return;
      } catch (error) {
        // Dismissed is not failed. Anything else falls through to the clipboard.
        if ((error as Error).name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(made.link);
      say(
        made.uploaded
          ? "Link copied. The store holds a sealed copy only the link can open."
          : `Link copied — ${(made.link.length / 1024).toFixed(1)} KB. Anyone who opens it gets this document.`,
      );
    } catch {
      say(made.link);
    }
  };
}


const modifyButton = document.getElementById("modify") as HTMLButtonElement | null;

/**
 * "Modify this app": the source, on the clipboard, addressed to an assistant.
 *
 * Backlog 4.2. Somebody has a document that works and wants one thing
 * different about it. Without this, the only route is describing the whole
 * application again — and what comes back is a *different* document: new
 * identity, no succession, empty database. It looks right until they open it
 * and last month's entries are gone.
 *
 * So what goes on the clipboard is the source that was sealed into this
 * document, in the bundle form, with `document:` and `schema:` in its header —
 * and a sentence saying what to do with them, because a header nobody is told
 * about is a header nobody uses. The instructions are addressed to the
 * assistant rather than to the person: they are going to paste this whole
 * thing into a conversation, and the first reader is a model.
 *
 * The clipboard rather than a file, because the assistant is in another tab
 * and a paste is the one transport every one of them accepts.
 */
async function copySourceForAssistant(): Promise<void> {
  if (!loaded) return;

  const files: Record<string, string> = {};
  const decoder = new TextDecoder();
  const binary: string[] = [];
  for (const [name, bytes] of Object.entries(authoredFiles(loaded.archive))) {
    const decoded = decoder.decode(bytes);
    // A bundle is text. A font pasted as mojibake is worse than one the
    // assistant is simply told about.
    if (decoded.includes("\u0000")) binary.push(name);
    else files[name] = decoded;
  }

  const schemaEntry = loaded.archive[SCHEMA_ENTRY];
  const schema = schemaEntry
    ? (JSON.parse(decoder.decode(schemaEntry)) as { digest?: string }).digest
    : undefined;

  const uuid = loaded.manifest.documentUuid;
  const bundle = writeBundle(files, {
    name: loaded.manifest.appName,
    documentUuid: uuid,
    schema,
  });

  const message =
    `Here is the source of a DAI app I already use. Please change it as I describe, ` +
    `then rebuild it as a DAI container.

` +
    `Build it as a new version of this same document, not a new app: pass ` +
    `supersedes: "${uuid}" to create_dai_app` +
    (schema
      ? `, and keep the schema digest at ${schema} or include a migration for whatever you move`
      : "") +
    `. That is what lets my existing data come across.
` +
    (binary.length > 0
      ? `
These files are in the app but are not text, so they are not below and will be ` +
        `lost unless you are given the original file: ${binary.join(", ")}.
`
      : "") +
    `
${bundle}`;

  try {
    await navigator.clipboard.writeText(message);
    say(
      `Copied the source of this app, with instructions. Paste it into your assistant and say ` +
        `what you want changed — the new version will replace this one and keep your data.`,
    );
  } catch {
    // No clipboard: the text is the point, so it goes where it can be selected.
    say(message);
  }
}

modifyButton?.addEventListener("click", () => {
  closeSheet();
  void copySourceForAssistant();
});

/**
 * "Name this publisher…": a name the person gives a key, on this device.
 *
 * Local, never exported, shown before anything a document asserts — and from
 * then on a stranger's name is compared against it too (spec §9.6). Offered
 * on the card, where who signed it is in view, rather than in an app's menu
 * where it read as vocabulary from somewhere else. The UI is the host's, and
 * this host's is the smallest that works: a prompt.
 */
async function namePublisher(publicKey: string): Promise<void> {
  const current = await publisherStore().byKey(publicKey);
  const label = window.prompt("What do you call this publisher?", current?.hostLabel ?? current?.name ?? "");
  if (label === null) return;
  await labelPublisher(publisherStore(), publicKey, label, await confusables());
  say(label.trim() ? `This publisher is "${label.trim()}" on this device.` : "Label removed.");
}

document.getElementById("send")?.addEventListener("click", () => {
  closeSheet();
  void sendDocument();
});

exportButton.addEventListener("click", () => {
  closeSheet();
  void exportContainer();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    arrivedAsFile = true;
    // A file arrived by no link. Cleared rather than left, or the next
    // document would be given an icon pointing at the last one.
    arrivedByLink = undefined;
    arrivedInClear = false;
    void ingest(file);
  }
});

/*
 * Files the operating system hands us.
 *
 * The manifest registers this app as a handler for .dai, which is what puts it
 * in the "open with" list and makes a tap on an attachment reach us. Declaring
 * that without consuming the launch is worse than not declaring it: the app
 * opens, shows an empty library, and the person is left thinking the file
 * failed to open.
 */
const launch = (window as unknown as { launchQueue?: { setConsumer(fn: (p: LaunchParams) => void): void } })
  .launchQueue;

interface LaunchParams {
  files?: FileSystemFileHandle[];
}

launch?.setConsumer((params: LaunchParams) => {
  const handle = params.files?.[0];
  if (!handle) return;
  void handle.getFile().then((file) => ingest(file));
});

/**
 * Reopens what was open, or shows the library.
 *
 * The verification is the same one a chosen file gets — `launchFromLibrary`
 * reads and verifies the stored container before mounting it. Resuming must
 * not be a route that skips the gate, or the gate applies to the way people
 * open a container once and not to the way they open it every day after.
 *
 * A container that no longer verifies, or is no longer in the library, leaves
 * the library on screen with the reason, rather than an app that silently
 * stopped being the one they had.
 */
/**
 * What to do about the document this one says it replaces.
 *
 * Returns nothing when the document replaces nothing, and otherwise both what
 * the card should say and, when adoption is allowed, the bytes to start from.
 * Nothing is written here; the caller writes after the person has opened it.
 */
async function planSuccession(
  cartridge: Cartridge,
  library: LibraryItem[],
): Promise<{ card: NonNullable<CardInput["succession"]>; inherit?: Uint8Array } | undefined> {
  const previousUuid = cartridge.manifest.supersedes;
  if (!previousUuid) return undefined;

  // Already started: this document has data of its own, and adoption happens
  // once, on the first open. Otherwise every reopen would overwrite what the
  // person did in the new version with what they had in the old.
  const own = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
  if (own && own.byteLength > 0) return undefined;

  const previous = library.find((item) => item.documentUuid === previousUuid);
  if (!previous) return { card: { state: "nothing-here", previous: previousUuid.slice(0, 8) } };

  const pinned = await trustStore().get(previousUuid);
  if (cartridge.signature !== "valid" || !cartridge.publicKey) {
    return {
      card: { state: "refused", previous: previous.appName, why: "this copy is not signed" },
    };
  }
  if (!pinned?.publicKey || pinned.publicKey !== cartridge.publicKey) {
    return {
      card: {
        state: "refused",
        previous: previous.appName,
        why: `it is signed by a different key from the ${previous.appName} you have`,
      },
    };
  }

  const inherited = await loadDatabaseFromOpfs(previousUuid);
  if (!inherited || inherited.byteLength === 0) {
    // Kept here but never saved to: there is nothing to bring, and saying
    // "your data comes along" over an empty database would be a promise
    // about nothing.
    return { card: { state: "nothing-here", previous: previous.appName } };
  }
  return { card: { state: "adopting", previous: previous.appName }, inherit: inherited };
}

/**
 * Opens the document a link carries.
 *
 * Everything after the `#` stays in the browser: a fragment is never sent to
 * a server, not to this origin and not into any log. So a link built this way
 * carries the whole document and depends on nothing — no store to be down, no
 * address to expire, nothing to fetch. It is also the only carrier that works
 * with the network switched off.
 */
async function openFromLink(carried: string, consentedFor?: string): Promise<void> {
  slot.classList.add("busy");
  say("Unpacking the document from the link…");

  let html: string;
  try {
    /*
     * The link carries the application; this host supplies the rest. The
     * shell is rebuilt from this host's own template and bootloader, the kit
     * from its source, the engine from what it holds — and every one of them is
     * checked against the digest the link named before anything is trusted.
     * What comes out is an ordinary container, verified below like any file.
     */
    html = await decodeInline(
      carried,
      { template: HOST_TEMPLATE, runtime: HOST_RUNTIME },
      await heldEngine(),
      pastHosts,
    );
  } catch (error) {
    slot.classList.remove("busy");
    /*
     * Said in the reader's own words, which name the cause: cut in transit,
     * made by another version, or leaving out something this host's copy of
     * does not match. The reading somebody reaches on their own is that this
     * opener is broken, so the cause is the most useful thing on screen.
     */
    say(
      error instanceof ContainerError
        ? `${error.message} Ask whoever sent it to send the file instead.`
        : "This link is damaged. It was probably shortened or wrapped on the way here. " +
            "Ask whoever sent it to send the file instead.",
      true,
    );
    return;
  }

  slot.classList.remove("busy");
  arrivedAsFile = false;
  // The document is in this address. An icon made from it needs nothing else.
  arrivedByLink = location.href;
  // Nothing held it anywhere, so there is no store that could have read it.
  arrivedInClear = false;
  await ingest(new File([html], "shared.dai.html", { type: "text/html" }), {
    from: "From the link you followed. Nothing is uploaded — it runs on this device.",
    consentedFor,
    hinted: consentedFor,
  });
}

/**
 * Where `/d/<id>` links resolve: this project's store.
 *
 * An R2 bucket behind store.opendai.app, serving ciphertext under content
 * hashes, public for GET with CORS open, checked by scripts/check-store.mjs.
 * The any-host form (`#h=&u=&k=`) never touches it.
 */
const STORE_BASE: string | undefined = "https://store.opendai.app/";

/**
 * Opens a document a reference link names.
 *
 * The store knows nothing and is trusted with nothing. What comes back is
 * hashed against the link before the key is so much as imported, then
 * decrypted, and then it is a container verified exactly as a chosen file is.
 * The fragment — the hash and the key — was never sent to the store or to
 * this origin, which is what makes the store dumb rather than merely
 * well-behaved.
 */
async function openFromReference(reference: { hash: string; key: string; url?: string }): Promise<void> {
  const href = reference.url ?? (STORE_BASE ? `${STORE_BASE}${reference.hash}` : undefined);
  if (!href) {
    say(
      "This link points at a store this app does not have an address for yet. " +
        "Ask whoever sent it for the file, or for a link that says where the document is.",
      true,
    );
    return;
  }

  slot.classList.add("busy");
  const where = new URL(href).hostname;
  say(`Fetching from ${where}…`);

  let blob: Uint8Array;
  try {
    const response = await fetch(href, { mode: "cors", credentials: "omit" });
    if (response.status === 404 || response.status === 410) {
      // The store keeps a shared document for a fixed time and this one's
      // is up. Said as what happened, not as a number: the person holding
      // the link did nothing wrong and the sender has the document still.
      slot.classList.remove("busy");
      say("This link has expired. Ask whoever sent it to share the app again.", true);
      return;
    }
    if (!response.ok) throw new Error(String(response.status));
    blob = new Uint8Array(await response.arrayBuffer());
  } catch {
    slot.classList.remove("busy");
    say(
      `Could not read the document from ${where}. Either it is unreachable, it has been removed, ` +
        `or it does not allow other sites to read its files.`,
      true,
    );
    return;
  }

  let html: string;
  try {
    html = await openFromStore(blob, reference.hash, reference.key);
  } catch (error) {
    slot.classList.remove("busy");
    say(error instanceof ContainerError ? error.message : "This link could not be opened.", true);
    return;
  }

  slot.classList.remove("busy");
  arrivedAsFile = false;
  // The address as it stands, fragment included: that is the document.
  arrivedByLink = location.href;
  // Carried in the clear, if the link said so. Held until the card is built.
  arrivedInClear = reference.clear === true;
  const store = reference.url ? where : "this project's store";
  await ingest(new File([html], "shared.dai.html", { type: "text/html" }), {
    from: `From ${store}, sealed so it could not be read there. Nothing is uploaded — it runs on this device.`,
  });
}

/*
 * A link pasted into a tab this app is already open in.
 *
 * Adding a fragment to the address a page is already on is a same-document
 * navigation: nothing reloads and no script runs again, so without this the
 * paste does nothing at all and the person is looking at an empty chooser
 * with their link in the address bar.
 *
 * Only while nothing is open. A document already running has state somebody
 * made, and replacing it because an address changed would be this app throwing
 * away work nobody asked it to throw away.
 */
window.addEventListener("hashchange", () => {
  if (loaded) return;
  const carried = inlineFrom(location.hash);
  if (carried) void openFromLink(carried);
});

async function start(): Promise<void> {
  await refreshLibrary();

  const parameters = new URLSearchParams(location.search);

  /*
   * A container shared to this app from somewhere else on the device.
   *
   * Android delivers a shared file as a POST to the share target, which cannot
   * navigate the app, so the service worker parks the file and redirects here
   * to collect it. Both of those are explicit instructions and outrank
   * reopening whatever was last used.
   */
  if (parameters.has("shared")) {
    const collected = await collectSharedContainer();
    if (collected) {
      await ingest(collected.file, { from: collected.from });
      return;
    }
    say("Nothing arrived from the share. Try opening the file instead.", true);
    return;
  }

  /*
   * A document handed straight over by the page that built it.
   *
   * The alternative was telling somebody on a phone to save the file, leave
   * the browser, find it in a Files app and pick it out of a chooser — which
   * is the flow a tester gave up on, and fairly. The bytes come across by
   * message instead: no download, no upload, nothing on the network.
   *
   * The document is read and verified here exactly as a chosen file is. Where
   * bytes arrived from says nothing about what they are.
   */

  /*
   * The document is in the link. Read before anything else here, because it is
   * the most explicit instruction an address can carry: somebody followed a
   * link with a document in it. See openFromLink.
   */
  /*
   * An icon for one document, held here: the copy on this device, first.
   *
   * A home-screen icon launches with the document's id in the address and,
   * when the document came by a link, the link beside it. If this opener
   * has the document, that is what opens — offline, without a store — and
   * the link is only for an opener that has never seen it (an iOS
   * home-screen app gets storage of its own, and starts with nothing).
   *
   * Only when the address has nothing to read, though. See `hintOnly` below:
   * an unverified string does not get to decide which bytes are mounted while
   * verified bytes are sitting in the same address.
   */
  const wanted = hintedUuid(location.hash, location.search);
  /*
   * An icon made before the hint moved into the fragment.
   *
   * `?doc=` is still read, because icons carrying it are on people's phones
   * and deleting the reader would strand them on an empty chooser. It gets the
   * hint's rules and nothing more: it selects a library entry to try, and the
   * mounted document's manifest decides what the document actually is.
   *
   * And the address is rewritten here, before anything else happens, so the
   * parameter is gone from the tab, from the history entry, and from any later
   * reload — the icon still carries it, nothing else does. That also makes
   * removing the reader a no-op for anybody who has launched even once.
   */
  if (wanted && hasLegacyHint(location.search)) {
    const corrected = new URL(location.href);
    corrected.searchParams.delete("doc");
    corrected.hash = `#${[
      ...corrected.hash.replace(/^#/, "").split("&").filter((part) => part.length > 0 && !part.startsWith("u=")),
      `u=${wanted}`,
    ].join("&")}`;
    history.replaceState(history.state, "", corrected.href);
  }
  /*
   * The hint decides nothing when there is a document to read (R7).
   *
   * `#u=` rides in a fragment, which anybody can edit, and it is read before
   * anything is decompressed — so it is a guess by construction. Consulted
   * first, it meant a link carrying one document opened a different one: the
   * payload was never examined, the person got their own copy of something
   * else, and nothing on screen said so. A newer copy of a held document,
   * arriving by link, could never win either, because succession is decided
   * inside `ingest` and `ingest` was never reached.
   *
   * So: bytes in the address are read and their manifest is authoritative;
   * the library is consulted by *that* UUID and succession applies as usual.
   * The hint is for addresses with nothing to read — a reference link, or a
   * bare `#u=` icon — which is exactly where skipping a fetch is worth
   * something. An inline icon pays a decompression it did not pay before; the
   * bytes are already local and a link is capped at 32 KB, so the cost is
   * bounded and buys the guarantee.
   */
  const hintOnly = wanted !== undefined && inlineFrom(location.hash) === undefined;
  if (hintOnly) {
    const held = (await listCartridgesFromLibrary()).find(
      (candidate) => candidate.documentUuid === wanted,
    );
    if (held) {
      keptOnDevice = true;
      // The address an icon launched with carries the link the document came
      // by, when it did; keep it, so the manifest written from here carries it
      // on rather than falling back to an address only this device can open.
      if (inlineFrom(location.hash) || referenceFrom(location.pathname, location.search, location.hash)) {
        arrivedByLink = location.href;
      }
      await launchFromLibrary(held);
      return;
    }
    // Painted as launching into it by the worker, and it is not here: the
    // chooser, or a card for what the link carries, is the honest screen.
    document.body.classList.remove("launching");
    if (!referenceFrom(location.pathname, location.search, location.hash)) arrived(false);
  }

  const carried = inlineFrom(location.hash);
  if (carried) {
    await openFromLink(carried, wanted ?? undefined);
    return;
  }

  // A document kept somewhere dumb, named by its hash, with the key in the
  // fragment. See openFromReference.
  const reference = referenceFrom(location.pathname, location.search, location.hash);
  if (reference) {
    await openFromReference(reference);
    return;
  }

  /*
   * A link that names a document and cannot open one (backlog 3.4).
   *
   * The key lives after the `#`, which is exactly the part that does not
   * survive being retyped, screenshotted, wrapped by a link shortener, or
   * pasted out of a tool that strips fragments. What arrives is a URL that
   * looks right and opens nothing.
   *
   * Nothing here can recover it. The key was never sent to a server — that is
   * the whole design — so there is no one to ask but the person who sent it.
   * What this page owes somebody is that sentence, rather than the empty
   * chooser, which reads as a broken app and sends them nowhere.
   */
  const stripped = strippedReference(location.pathname, location.search, location.hash);
  if (stripped) {
    say(
      stripped.missing === "key"
        ? "This link names a document but is missing the part that opens it. The key " +
            "travels after the # and never reaches any server, so it cannot be looked up " +
            "here — ask whoever sent it to send the whole link again, or to send the file."
        : "This link carries a key but does not say which document it opens. Ask whoever " +
            "sent it for the whole link.",
      true,
    );
    return;
  }

  // Nothing above found a document in the address: the chooser is the page.
  arrived(false);

  if (location.hash === "#handoff" && !window.opener) {
    /*
     * Opened for a handoff, and the page that opened us is not reachable.
     * A Cross-Origin-Opener-Policy on either side does this silently, and
     * for a while it did: the symptom was this page's empty chooser, with
     * nothing anywhere saying why.
     */
    say(
      "This page was opened to receive a document, but lost touch with the page " +
        "that opened it. Go back and use Save instead, then open the file here.",
      true,
    );
    return;
  }

  if (location.hash === "#handoff" && window.opener) {
    say("Waiting for the document…");
    receiveHandoff(
      window.opener as Window,
      ({ name, bytes }) => {
        arrivedAsFile = false;
        void ingest(new File([bytes as BlobPart], name, { type: "text/html" }), {
          from: "From the page that just built it. Nothing is uploaded — it runs on this device.",
        });
      },
      { allows: mayHandOver, window },
    );
    return;
  }

  // An address in the link is an explicit instruction too: somebody who
  // followed a link to a container meant that container.
  const asked = parameters.get("open");
  if (asked) {
    await openFromUrl(asked);
    return;
  }

  /*
   * An icon for one document.
   *
   * A document kept as an app launches here with its id in the address. If
   * this opener has it, that is the document to open — not whatever was open
   * last. If it does not, this is an iOS home-screen app, which gets storage
   * of its own and has never seen the file; the address carries the name so
   * this can ask for exactly that file rather than showing an empty chooser.
   */
  if (wanted) {
    // Not held here, and no link to follow (a document that arrived as a
    // file exists nowhere else): the address carries the name so this can
    // ask for exactly that file rather than showing an empty chooser.
    const name = parameters.get("name") ?? "your document";
    say(
      `This icon is for ${name}. Open ${name} from your files once — tap Open a file ` +
        `and choose it — and it will be here every time after that.`,
    );
    return;
  }

  let resume: string | null = null;
  try {
    resume = localStorage.getItem(RESUME_KEY);
  } catch {
    /* Storage refused; the library is already on screen. */
  }
  if (!resume) return;

  const item = (await listCartridgesFromLibrary()).find(
    (candidate) => candidate.documentUuid === resume,
  );
  if (!item) {
    forgetOpen();
    return;
  }

  await launchFromLibrary(item);
}

void start();
// Off the first-paint path, alongside the engine: the table a name is compared
// with is wanted at the first card, not at the first frame.
void confusables();

// Exposed for tests and for the storage layer.
Object.defineProperty(window, "__runner", {
  value: {
    get loaded() {
      return loaded;
    },
    get isolationReport() {
      return lastIsolationReport;
    },
    get handshakeEstablished() {
      return handshakeEstablished;
    },
    get saves() {
      return hostSaves;
    },
    eject,
    exportContainer,
    deleteApp,
    refreshLibrary,
    listLibrary: listCartridgesFromLibrary,
    // The card is a pure renderer over what it is handed. Exposed so a test
    // can draw it with a weaker profile than this host has, which is the only
    // way to check that a sentence disappears when its clause does.
    showCard,
  },
});

/**
 * Registers the service worker that makes the runner itself work offline.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error: unknown) => {
      console.warn("DAI Runner: offline support unavailable.", error);
    });
  });

  /*
   * A new worker taking over mid-page means this page is the build before
   * it. Reloading once picks up the current one — but only while nothing is
   * open, because a reload under somebody's document is worse than a stale
   * shell. A page waiting on a handoff is safe to reload: the sender waits
   * for a ready that the fresh page will send.
   */
  // Only an update, never a first install. On a first visit the new worker
  // claims the page too, and reloading then threw away a document that had
  // just been handed over — the sender had delivered and stopped listening
  // before the reloaded page asked again.
  const updating = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updating || reloaded || document.body.classList.contains("loaded")) return;
    reloaded = true;
    location.reload();
  });
  /*
   * The shell is served from the cache and refreshed behind it, so a page is
   * at most one deploy behind - and the first launch after every deploy was
   * exactly that one, for a person and for a phone test alike. The worker
   * says when its refresh brought a newer shell, and the page reloads while
   * there is still nothing to lose: on the chooser, or on the launch screen
   * before a document has mounted. Under an open document it waits; the
   * next launch is current anyway, because the cache already is.
   */
  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type !== "dai:shell-updated") return;
    if (reloaded || document.body.classList.contains("loaded")) return;
    reloaded = true;
    location.reload();
  });
}

/*
 * Which build this is, on both screens that can show it.
 *
 * "Is the fix live?" is a real question here: production is promoted from main
 * automatically, and a phone gives no way to tell one deploy from the next. An
 * afternoon of testing measured the wrong build three times over, which is
 * what the version stamp was written for; it just had nowhere to be read.
 *
 * Read from a meta tag the build filled in, never fetched. Two reasons, and
 * the second is the load-bearing one: the chooser shows it too, and the person
 * who most needs to say which build they are on is the one whose document will
 * not open — who may well have no network. And a fetch at load broke the test
 * holding the claim that opening a document you already have asks the network
 * for nothing at all.
 *
 * Failure is silence. An unstamped build says nothing rather than apologising
 * in a menu for a diagnostic nobody asked for.
 */
function showVersion(): void {
  const stamp = document
    .querySelector('meta[name="dai-build"]')
    ?.getAttribute("content");
  if (!stamp || stamp === "dev") return;
  for (const id of ["sheet-version", "chooser-version"]) {
    const slot = document.getElementById(id);
    if (slot) slot.textContent = stamp;
  }
}

showVersion();
