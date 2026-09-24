/**
 * The DAI Runner: a hosted, installable player for containers.
 *
 * A `.dai.html` cannot install itself on a phone — `file://` forbids service
 * workers and manifest registration, so there is nothing for the OS to install.
 * The runner inverts that: the *player* is the installable PWA, and containers
 * are opened from the user's own files. The console, not the cartridge.
 */
import { ContainerError, readCartridge, resealCartridge, reverify, type Cartridge } from "./cartridge.js";
import { refatten } from "../../../src/container.js";
import { decodeInline, hasLegacyHint, HINT_KEY, hintedUuid, inlineFrom, inlineLink, LAUNCH_CAP } from "../../../src/link.js";
import type { PastHost } from "../../../src/inline.js";
import { linkFor } from "../../../src/sender.js";
import { heldEngine } from "./engine.js";
import { ICON_CAP, openFromStore, publish, referenceFrom, strippedReference } from "../../../src/store.js";
import { presignedStore } from "../../../src/store-presigned.js";
import { labelPublisher, publisherState, recordPublisher } from "../../../src/publisher.js";
import { declaresReplication, siblingTest, whyNotSibling } from "../../../src/sibling.js";
import { afterSave, BLANK_DIGEST, buildOf, chooseCopy, databaseDigest, remember } from "../../../src/copy-choice.js";
import { confusables } from "./confusables.js";
import { verifyIdentity } from "../../../src/publisher-identity.js";

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
  RELAUNCHED,
  sameLaunch,
  watchForInstall,
  manifestFallback,
  type Identity,
} from "./install.js";
import { describeApp, hideCard, showCard, type CardInput } from "./card.js";
import { installShareStorage, installStorageIsRead, platform, standalone } from "./platform.js";
import { askForSuccessor, checkIsDue, type Successor } from "./version-check.js";
import { closeSheet as slideClose, openSheet as slideOpen } from "./sheet.js";
import { httpMailbox } from "../../../src/mailbox-http.js";
import { startMailboxSession, type MailboxSession } from "./mailbox-session.js";
import { askForPush, clearNotices, pushSender, releasePush, setPushKey, sweepPush, wantPush } from "./push.js";
import { listMailboxes } from "./opfs.js";
import { inviteFor, unsealedOwnRows } from "./invite.js";
import { checkTrust, forgetTrust, pinTrust, trustVerdict } from "../../../src/trust.js";
import {
  deleteCartridgeFromLibrary,
  raiseSeqFloor,
  seqFloorWithin,
  deleteDatabaseFromOpfs,
  getCartridgeFromLibrary,
  listCartridgesFromLibrary,
  loadDatabaseFromOpfs,
  saveCartridgeToLibrary,
  trustStore,
  publisherStore,
  sigstoreRoots,
  saveDatabaseToOpfs,
  askToPersist,
  readPersistence,
  persistenceLine,
  requestLine,
  type LibraryItem,
} from "./opfs.js";
import type { Share } from "./opfs.js";
import { TO_DOCUMENT, TO_HOST } from "../../../src/bridge.js";
import { authorId, person, type Person } from "./person.js";
import { showAuthorId, signBytes } from "../../../src/identity.js";
import { decode as decodeCbor } from "../../../src/cbor.js";
import { BATCH_FORMAT_VERSION } from "../../../src/replicated-batch.js";
import { KEYS, libraryLock, opensKey } from "../../../src/keys.js";
import { WORKER } from "../../../src/worker.js";
import { loadAt, ownWrite } from "./navigate.js";

/**
 * How this page arrived, read before anything here touches the head.
 *
 * iOS names, draws and launches a home-screen icon from the manifest a page
 * was linked with when it loaded. A phone once installed a document and got
 * the opener, and nothing on screen could say which manifest that load had,
 * which worker served it, or whether the iOS reload was taken. So the page
 * says, beside the D49 reading: only what it can read, nothing inferred.
 */
const arrivedManifest = document.querySelector('link[rel="manifest"]')?.getAttribute("href") ?? null;
/** The iOS reload's gate, as decided on this load: set where it is decided. */
let reloadGate = "not reached";
/** The entry point of the load that took the reload, carried across it. */
let reloadedFrom: string | undefined;
/**
 * The document this load was the iOS reload for: the loop guard.
 *
 * Kept apart from `reloadGate`, which is a line for a person to read and is
 * rewritten by the paths that decide it; compared as text, the guard was lost
 * whenever a path wrote the line (review of 454e2db, Q1.3). And held for that
 * one document: another opened on this page — after Remove, or arriving by
 * handoff while this one is open — is a new open, owed a reload of its own,
 * which a guard for the whole page refused it (Q1.2). Read from the address
 * the reload landed on, which names the document in its hint.
 *
 * Beside it, `reloadedThisLoad`: this load was a relaunch, whatever document
 * it names. The hint is how the document is known, and an address that lost
 * its fragment on the way has none — then the document guard cannot match, the
 * page is not where it meant to be, and it relaunched for ever (24 loads in
 * 20 seconds, measured in the cold review of 025166c, Q3). A load that was
 * itself a relaunch never relaunches again. Both are cleared on eject, where
 * the next open is a new one.
 */
let reloadedFor: string | undefined;
let reloadedThisLoad = new URLSearchParams(location.search).has(RELAUNCHED);
/*
 * Read, and then taken off the address.
 *
 * The mark is for this load and nothing after it, and the address is a
 * person's: it is what they see, copy, and put on a home screen. Everything
 * else is kept exactly as it stands — the fragment above all, which carries
 * the document and its key and must survive untouched.
 */
if (reloadedThisLoad) {
  try {
    const clean = new URL(location.href);
    clean.searchParams.delete(RELAUNCHED);
    history.replaceState(history.state, "", clean.href);
  } catch {
    /* The mark stays in the address; it means the same either way. */
  }
}

/** Whether this load was already the relaunch — for this document, or at all. */
function relaunchedAlready(uuid: string): boolean {
  return reloadedThisLoad || reloadedFor === uuid;
}
/** Set by the load that took the iOS reload, read by the load it caused. */
const RELOAD_TAKEN = KEYS.IOS_RELOAD_TAKEN;
try {
  // The second witness. The address is the first, and the only one a device
  // that refuses storage still has.
  const taken = sessionStorage.getItem(RELOAD_TAKEN);
  if (taken !== null) {
    sessionStorage.removeItem(RELOAD_TAKEN);
    // The path that asked for the reload, which this load would otherwise hide.
    if (taken !== "1") reloadedFrom = taken;
    reloadGate = "taken on the load before this one";
    reloadedFor = hintedUuid(location.hash, location.search);
    reloadedThisLoad = true;
  }
} catch {
  /* No session storage: the line says only what this load decided. */
}

async function workerBuild(): Promise<string> {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) return "no worker";
  const channel = new MessageChannel();
  const answer = new Promise<string>((done) => {
    channel.port1.onmessage = (event) => done(String((event.data as { build?: unknown })?.build ?? "no build"));
    window.setTimeout(() => done("no answer"), 2000);
  });
  worker.postMessage({ type: WORKER.BUILD }, [channel.port2]);
  const build = await answer;
  return /^[0-9a-f]{12,}$/.test(build) ? build.slice(0, 7) : build;
}

/**
 * A `data:` manifest, read where it stands.
 *
 * Fetched, it is refused: the opener's policy lists `connect-src 'self' https:`
 * and no `data:` (measured on the live deploy, 22 September), so the line fell
 * back to printing the whole address — the manifest's bytes, on a phone.
 */
function dataManifest(address: string): unknown {
  const comma = address.indexOf(",");
  const body = address.slice(comma + 1);
  const text = address.slice(0, comma).endsWith(";base64")
    ? new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)))
    : decodeURIComponent(body);
  return JSON.parse(text);
}

/**
 * The arrived manifest, asked for with a bound.
 *
 * The panel that prints this is for a launch that has stalled, and a fetch
 * with no bound on that same stalled page left the whole panel on
 * "gathering…" — the error ring with it (review of 2e371a5, Q4). Two seconds,
 * as the worker's build is given, and then it is unreadable, which says so.
 */
async function fetchManifest(address: string): Promise<unknown> {
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), 2000);
  try {
    return await (await fetch(address, { signal: abort.signal })).json();
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * An address as a line, never as its contents.
 *
 * A launch address carries the document for a file or an inline arrival —
 * that payload is what an iOS icon opens from, and it stays. What must not
 * happen is printing it: a phone read a `start_url` of 11,847 characters on
 * e1f9b45, which put the whole document on a screen somebody may photograph
 * and send on, and pushed everything else off the reading.
 *
 * So an address is printed as where it points and what its fragment carries:
 * each field by name and by size, with the document's id in full, because
 * that is the one value a reading is for.
 */
export function addressLine(address: string): string {
  let url: URL;
  try {
    url = new URL(address, location.href);
  } catch {
    return `an unreadable address (${address.length} B)`;
  }
  const fields = url.hash
    .replace(/^#/, "")
    .split("&")
    .filter((part) => part.length > 0)
    .map((part) => {
      const at = part.indexOf("=");
      const key = at < 0 ? part : part.slice(0, at);
      const value = at < 0 ? "" : part.slice(at + 1);
      // The id in full: it is what names the document, and it is short.
      if (key === HINT_KEY) return `${key}=${value}`;
      return `${key}=(${value.length} B)`;
    });
  const where = `${url.origin}${url.pathname}`;
  return fields.length > 0 ? `${where}#${fields.join("&")}` : where;
}

async function arrivedManifestReading(): Promise<string> {
  if (!arrivedManifest) return "no manifest";
  try {
    const read = (
      arrivedManifest.startsWith("data:") ? dataManifest(arrivedManifest) : await fetchManifest(arrivedManifest)
    ) as { name?: unknown; start_url?: unknown };
    return `${String(read.name ?? "?")} → ${addressLine(String(read.start_url ?? ""))}`;
  } catch {
    // Never the address itself: a data: one is the manifest's bytes.
    return arrivedManifest.startsWith("data:")
      ? "a data: manifest (unreadable)"
      : `${addressLine(arrivedManifest)} (unreadable)`;
  }
}

async function showArrival(): Promise<void> {
  const [build, manifest] = await Promise.all([workerBuild(), arrivedManifestReading()]);
  const entry = entryPoint ? ` · opened from ${entryPoint}` : "";
  // Said here too, not only on the launch panel: this line is the reading a
  // phone takes, and a data: manifest with no account of it is what sent the
  // last sitting looking (cold review of 8f0dd9f, Q5).
  const fallback = manifestFallback();
  const wrote = fallback ? ` · manifest as data: ${fallback}` : "";
  const text = `worker ${build} · arrived with ${manifest}${entry} · iOS reload: ${reloadGate}${wrote}`;
  for (const id of ["sheet-arrival", "chooser-arrival"]) {
    const slot = document.getElementById(id);
    if (slot) slot.textContent = text;
  }
}

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

/*
 * Ask the browser to keep this origin's storage, and record what it answered (D49).
 *
 * The answer used to be thrown away, which is why the seven-day phone reading
 * cannot be interpreted: it measured an install whose persistence status was
 * never known, and what it saw is the expected outcome for an unpersisted one.
 * Both the request's answer and the standing state are breadcrumbed, with the
 * context each belongs to, because an installed app and a tab can be granted
 * differently and it is the install that matters.
 *
 * When the request is made is D55, **ruled 21 September: after the first thing
 * worth keeping is written, never at boot.** Boot is the weakest moment the
 * code could pick — no document open, no engagement, nothing the person has
 * done with this origin — and it was the only moment it picked. The request
 * now follows the first save this device commits for a document, which is the
 * first moment there is something to lose. `askForPersistence()` below makes
 * it, once per page.
 *
 * The *reading* stays at boot. It asks the browser nothing and answers the
 * question "is what I already have kept", which the person can be looking at
 * before they have written anything (D49).
 *
 * The standing state never waits on the request. On Firefox `persist()` can go
 * unanswered — most likely held on a permission prompt — and when the reading
 * was chained behind it, neither line was ever written: the one engine where
 * the question is visible to a person was the one where the reading went
 * silent (CI, 18 September). So the two are separate, and the request is
 * written down when it is made as well as when it is answered: "asked, no
 * answer yet" is a fact, and it is legible instead of indistinguishable from
 * never asking.
 */
void readPersistence().then((standing) => console.info(`dai: ${persistenceLine(standing)}`));

/** Asked once per page, and only where there is something to keep (D55). */
let persistenceRequested = false;

/**
 * Ask the browser to keep this origin, now that this device has written
 * something it would mind losing.
 *
 * Called from the save path, after a save is written and off its acknowledgment,
 * so nothing a person is waiting for waits on this.
 */
function askForPersistence(why: string): void {
  if (persistenceRequested) return;
  persistenceRequested = true;
  if (typeof navigator !== "undefined" && typeof navigator.storage?.persist === "function") {
    console.info(`dai: storage persistence asked ${why}; waiting on the browser`);
  }
  void askToPersist().then((asked) => {
    if (!asked) return;
    console.info(`dai: ${requestLine(asked)} (asked ${why})`);
    // The answer may have changed what is true: read it again, for the log and
    // for the line on screen. Whatever the answer — a rejection can still leave
    // the state different from what was read before the request.
    void readPersistence().then((after) => console.info(`dai: ${persistenceLine(after)} (after the request)`));
    showPersistence();
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

/** The badge count, from `/badge.js`, which the service worker loads too (D34). Absent if that script did not load. */
interface DaiBadge {
  opened(uuid: string): Promise<unknown>;
  reported(uuid: string, sessions: string[]): Promise<unknown>;
}
const badge = (): DaiBadge | undefined => (globalThis as unknown as { daiBadge?: DaiBadge }).daiBadge;
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
  target.postMessage({ type: TO_DOCUMENT.CANVAS, colour }, "*");
}

function tellInsets(): void {
  const target = cartridgeFrame.contentWindow;
  if (!target || !mountedNonce) return;
  target.postMessage({ type: TO_DOCUMENT.INSETS, ...screenInsets() }, "*");
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

/**
 * One writer at a time for a document's library record (backlog D41).
 *
 * The save path always held this lock, because two tabs each writing a whole
 * database can interleave. Every other write — the keys, the shares, standing
 * consent — read the record and wrote it back outside it, and a read that
 * straddles a save's commit writes `revision` back to what it was before. The
 * tab that saved has already moved its own `knownRevision` on, so from then on
 * every save it makes reads as "another tab saved this" and is refused, for the
 * life of that page. Nothing recovers it but a reopen.
 *
 * So it is one helper, used by every writer. Read the record *inside* the lock
 * and write it there too: a read from outside is exactly the stale snapshot
 * this exists to prevent.
 */
function withLibraryLock<T>(documentUuid: string, work: () => Promise<T>): Promise<T> {
  const key = libraryLock(documentUuid);
  return navigator.locks?.request
    ? navigator.locks.request(key, { mode: "exclusive" }, work)
    : work();
}

/**
 * Changes one document's library record under the lock, from a fresh read.
 *
 * `change` receives the record as it is at that moment and returns what to
 * write. A document this device does not hold is left alone.
 */
async function amendLibraryRecord(
  documentUuid: string,
  change: (held: LibraryItem) => LibraryItem,
): Promise<void> {
  await withLibraryLock(documentUuid, async () => {
    const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
    if (!held) return;
    await saveCartridgeToLibrary(change(held)).catch(() => undefined);
  });
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

const RESUME_KEY = KEYS.RESUME;

/**
 * How many times this device has opened a document, counted here rather than
 * in the library because it is about what to say to a person, not about the
 * document. Kept beside the record of a dismissed offer, for the same reason.
 */
/** How many times this document has been opened here, without counting this one. */
function seenOpens(uuid: string): number {
  try {
    return Number(localStorage.getItem(opensKey(uuid)) ?? "0");
  } catch {
    return 0;
  }
}

function countOpen(uuid: string): number {
  try {
    const next = Number(localStorage.getItem(opensKey(uuid)) ?? "0") + 1;
    localStorage.setItem(opensKey(uuid), String(next));
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
/** Saves this host has written, as opposed to asked (`hostSaves`). Read by tests. */
let hostSavesWritten = 0;

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

/*
 * The launch screen is never a dead end.
 *
 * A document is launched by loading the page at its own address and letting
 * the splash stand until it mounts. When that load is the programmatic
 * relaunch to `#u=` — set the hash, reload — it can fail to complete on iOS
 * Safari, and the splash then sits forever with no way off it: the screen
 * hung, which reads as a broken app and loses the person.
 *
 * So the splash carries a fail-safe, not a fix. A few seconds after it
 * appears, if nothing has mounted, it reveals a sentence and a *Tap to open*
 * control. The tap matters: a plain navigation from a real user gesture
 * completes where the programmatic one it stands in for did not, and it uses
 * neither a hash trick nor a reload. It is the same debt the merge card pays —
 * a sentence and a way forward, whatever the screen failed to do — and it
 * stays after the device session finds the root cause.
 */
let launchGuard: number | undefined;
let launchTarget: string | null = null;
/** A few seconds: longer than a working mount, short enough to rescue one. */
const LAUNCH_STALL_MS = 6000;

/**
 * The stall wait, shortened for a test through `window.__daiTimers`, injected
 * before the page loads — the same move as `__daiStore`. The opener's own
 * timing and nothing else: a document's runtime has no such seam and gets
 * none. What the fail-safe tests check is what happens after the wait, and
 * each of them used to sit out six real seconds to reach it.
 */
function launchStallMs(): number {
  const injected = (window as unknown as { __daiTimers?: { launchStallMs?: number } }).__daiTimers;
  return typeof injected?.launchStallMs === "number" ? injected.launchStallMs : LAUNCH_STALL_MS;
}

/*
 * The step the launch is on, for the details panel below.
 *
 * A phone has no inspector, so "it hangs" is all a report can say without
 * this. Updated at each host-visible step so a stalled splash can name the one
 * it stopped on — the frame's own later steps it cannot see, but which door
 * the launch went through and got no further is most of the answer.
 */
let launchStep = "starting up";
function markStep(step: string): void {
  launchStep = step;
  /*
   * Also a trace, not only the latest.
   *
   * The single step field names where a hang stopped, but not the path it took
   * to get there — and when the same label covers several awaits, that path is
   * the missing half. Every step is stamped into the same ring the panel reads,
   * so one screenshot shows the whole sequence and its last entry is the exact
   * line, without another round of narrowing.
   */
  try {
    const ring = (window as unknown as { __daiLog?: string[] }).__daiLog;
    if (ring) {
      ring.push(`${new Date().toISOString().slice(11, 23)} step: ${step}`);
      if (ring.length > 30) ring.shift();
    }
  } catch {
    /* The trace is a convenience; never let it throw into the launch. */
  }
}

/**
 * What the launch knows about itself, for a screenshot to carry back.
 *
 * Seven things and the error ring: the build, the step it is on, the id in the
 * address and whether this device holds it, whether a worker controls the
 * page, whether this device's storage is kept and which context answered
 * (D49), and the last errors captured since the first line of the first script
 * (see `__daiLog` in the head). Gathered on demand; nothing here runs until
 * somebody taps Show details.
 */
async function launchDetails(): Promise<string> {
  const lines: string[] = [];
  const build =
    document.querySelector('meta[name="dai-build"]')?.getAttribute("content") ?? "unknown";
  lines.push(`build: ${build}`);
  lines.push(`step: ${launchStep}`);

  // The address the launch is aiming at: the guard's target when one is set —
  // which is where a stalled relaunch was trying to go — otherwise this page's.
  const address = launchTarget ?? location.href;
  let uuid = "";
  try {
    const url = new URL(address, location.href);
    uuid = hintedUuid(url.hash, url.search) ?? "";
  } catch {
    /* A malformed address is itself worth seeing, below. */
  }
  lines.push(`hint (${HINT_KEY}): ${uuid || "(none)"}`);
  lines.push(`address: ${addressLine(address)}`);

  try {
    const held = (await listCartridgesFromLibrary()).some((item) => item.documentUuid === uuid);
    lines.push(`library holds it: ${uuid ? (held ? "yes" : "no") : "n/a"}`);
  } catch (error) {
    lines.push(`library holds it: error ${String(error).slice(0, 80)}`);
  }

  const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
  lines.push(
    `service worker controls page: ${sw ? (sw.controller ? "yes" : "no") : "unavailable"}`,
  );
  /*
   * Both causes of the wrong icon in one place. The manifest this load arrived
   * with and whether the iOS reload was taken (and by which path); and beside
   * them the build of the worker that served this page, which is D56's case —
   * a worker from an older deploy serving the page describes it the old way.
   */
  const [workerStamp, arrivedWith] = await Promise.all([workerBuild(), arrivedManifestReading()]);
  lines.push(`arrived with: ${arrivedWith}`);
  lines.push(`opened from: ${entryPoint || "(nothing opened yet)"}`);
  lines.push(`iOS reload: ${reloadGate}`);
  lines.push(`manifest written as data: ${manifestFallback() ?? "never, in this tab"}`);
  lines.push(`worker build that served this page: ${workerStamp} (page build ${build.slice(0, 7)})`);

  // D49: a stall on a device whose storage was swept is a case worth having
  // here, and the panel already exists for exactly this argument.
  lines.push(persistenceLine(await readPersistence()));

  const log = (window as unknown as { __daiLog?: string[] }).__daiLog;
  lines.push("");
  lines.push(`trace (${log?.length ?? 0}):`);
  if (log && log.length > 0) for (const entry of log.slice(-16)) lines.push(`  ${entry}`);
  else lines.push("  (none captured)");

  return lines.join("\n");
}

function guardLaunch(target: string): void {
  launchTarget = target;
  window.clearTimeout(launchGuard);
  launchGuard = window.setTimeout(() => {
    const body = document.body.classList;
    /*
     * Mounted, or no longer launching: nothing to rescue. A merge rehearsed
     * behind the launch screen is the exception — mounted, and deliberately
     * covered, which is exactly the wait that needs a way off it.
     */
    if (body.contains("loaded") && !rehearsingMerge) return;
    if (!body.contains("launching") && !body.contains("booting")) return;
    body.add("launch-stalled");
    // The splash is aria-hidden while it is only decoration; now it holds the
    // one control on screen, so it must reach assistive technology.
    document.getElementById("launch")?.setAttribute("aria-hidden", "false");
  }, launchStallMs());
}

/** Which way the document on screen was opened, for the arrival line. */
let entryPoint = "";

/** What the worker and the manifest are told about a document. */
/**
 * The short address a document came by, when this device kept one.
 *
 * A document that arrived from a store has a way back in that is nothing but
 * an address — its `/d/<hash>` path and key. That is worth remembering,
 * because the load that opens the document is usually not the load that
 * followed the link: an icon is made days later, from a page that resumed the
 * document out of the library, and that page knows no link at all.
 */
function shortArrivalLink(): string | undefined {
  if (!arrivedByLink) return undefined;
  try {
    // Inline is the document itself, and the library already holds that.
    return inlineFrom(new URL(arrivedByLink).hash) ? undefined : arrivedByLink;
  } catch {
    return undefined;
  }
}

async function keptLink(uuid: string): Promise<string | undefined> {
  const held = await getCartridgeFromLibrary(uuid).catch(() => null);
  return held?.link;
}

async function identityOf(cartridge: Cartridge): Promise<Identity> {
  /*
   * The address this load arrived by, then the one this device kept, and only
   * then a freshly minted inline link.
   *
   * Minting was tried first once, by accident of ordering: a store arrival
   * opened from the library got an inline address with the whole document in
   * it, and the icon made from it launched a snapshot rather than the stored
   * copy. On the phone that read as the icon flipping (D56).
   */
  const uuid = cartridge.manifest.documentUuid;
  return {
    uuid,
    name: cartridge.manifest.appName ?? "container",
    favicon: cartridge.manifest.favicon,
    opens: 0,
    link: arrivedByLink ?? (await keptLink(uuid)) ?? (await launchLinkForDocument(cartridge.html)),
  };
}

/**
 * On iOS, a document is on screen only at its own launch address.
 *
 * iOS names and launches a home-screen icon from the manifest the page was
 * linked with when it loaded, so Add to Home Screen gives the document's icon
 * only on a page loaded at the document's address. This used to be decided in
 * `ingest` alone, so a copy already held — opened from an icon, a resume or a
 * merge — was never moved there, and its icon was the opener's. Every path that
 * opens a document asks here, and names itself (`entry`) for the arrival line.
 *
 * Returns true when it navigated: the caller stops, the next load opens it.
 * A load that was itself the reload never reloads again, whatever the address
 * says, so a mismatch can cost one extra load and never a loop.
 */
async function relaunchAtOwnAddress(identity: Identity, entry: string): Promise<boolean> {
  const reloadedAlready = relaunchedAlready(identity.uuid);
  // The path that asked for the reload names this open only when it was this document.
  entryPoint = (reloadedAlready ? reloadedFrom : undefined) ?? entry;
  if (platform() !== "ios") {
    reloadGate = `not taken: platform is ${platform()}`;
    return false;
  }
  describedIdentity = identity;
  const target = launchAddress(identity);
  if (sameLaunch(location.href, target)) {
    if (!reloadedAlready) reloadGate = "not needed: already at the document's address";
    return false;
  }
  if (reloadedAlready) {
    reloadGate = "not taken: still not at the document's address after a reload";
    return false;
  }
  // Marked in the address, so the load it causes knows it was a relaunch
  // whatever its storage says.
  const marked = new URL(target);
  marked.searchParams.set(RELAUNCHED, "1");
  const address = marked.href;
  // The worker describes the next load with this document's manifest.
  await describeDocument(identity);
  markStep("reloading at the document's address");
  reloadGate = "taken";
  try {
    sessionStorage.setItem(RELOAD_TAKEN, entryPoint);
  } catch {
    /* The reloaded page cannot say it was reloaded; still true of this load. */
  }
  // If this relaunch does not complete — the iOS reload bug — the splash stays
  // up on this same page, and the guard turns it into Tap to open.
  guardLaunch(address);
  // A real load, and marked as this page's own so it is not heard as a link.
  loadAt(address, "replace");
  return true;
}

function clearLaunchGuard(): void {
  window.clearTimeout(launchGuard);
  document.body.classList.remove("launch-stalled");
  document.getElementById("launch")?.setAttribute("aria-hidden", "true");
}

const launchOpenButton = document.getElementById("launch-open") as HTMLButtonElement | null;
/**
 * What Tap to open does, when it is not a navigation.
 *
 * A merge rehearsed behind the launch screen has nowhere to send the person:
 * the address it would go to is where it will go by itself once the move is
 * in, and going there now would leave the move behind. So the cover's control
 * ends the wait instead — the copy as it stands, and a sentence saying the
 * move did not land (cold review of c424598, Q2.1). Set while a rehearsal is
 * on; cleared when it ends.
 */
let onLaunchTap: (() => void) | undefined;

launchOpenButton?.addEventListener("click", () => {
  clearLaunchGuard();
  if (onLaunchTap) {
    const end = onLaunchTap;
    onLaunchTap = undefined;
    end();
    return;
  }
  // The gesture the automatic path could not make. Plain navigation to the
  // launch address — the `#u=` open path is the same one a healthy launch
  // takes, and it is known to work; only reaching it by script was the problem.
  location.assign(launchTarget ?? location.href);
});

const launchDetailsToggle = document.getElementById("launch-details-toggle") as HTMLButtonElement | null;
const launchDetailsPanel = document.getElementById("launch-details") as HTMLElement | null;
launchDetailsToggle?.addEventListener("click", () => {
  if (!launchDetailsPanel) return;
  if (!launchDetailsPanel.hidden) {
    launchDetailsPanel.hidden = true;
    launchDetailsToggle.textContent = "Show details";
    return;
  }
  launchDetailsPanel.textContent = "gathering…";
  launchDetailsPanel.hidden = false;
  launchDetailsToggle.textContent = "Hide details";
  void launchDetails().then((text) => {
    launchDetailsPanel.textContent = text;
  });
});

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
  frameSessionLanes = false;
  // The mailbox loop belongs to the document that was open; it stops with it.
  mailboxSession?.stop();
  mailboxSession = null;
  arrivedKey = undefined;
  // With it: a game named by the last link must not file the next document's key.
  arrivedSession = undefined;
  document.body.classList.remove("loaded", "launching", "booting");
  clearLaunchGuard();
  document.documentElement.style.removeProperty("--app-ground");
  declaredGround = undefined;
  mountedUuid = undefined;
  describedIdentity = undefined;
  paintAbove();
  const saveState = document.getElementById("save-state");
  if (saveState) saveState.hidden = true;
  const docNote = document.getElementById("doc-note");
  if (docNote) docNote.hidden = true;
  // What the arrival line and the loop guard say about the document that was
  // open. The next open on this page decides its own.
  reloadGate = "not reached";
  reloadedFrom = undefined;
  reloadedFor = undefined;
  reloadedThisLoad = false;
  // A rehearsal cannot outlive the document it was for.
  onLaunchTap = undefined;
  rehearsingMerge = false;
  entryPoint = "";
  // And the lines that print them, so the panel does not describe what is gone.
  void showArrival();
  hostSaves = 0;
  hostSavesWritten = 0;
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

async function launchFromLibrary(item: LibraryItem, entry: string): Promise<void> {
  markStep("opening this device's own copy");
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
      /*
       * The library kept the app and the database is gone (D51).
       *
       * This is the state a partial sweep leaves: the row survives, the stored
       * database does not, and the container mounts as it arrived — so the app
       * opens, looks right, and is empty. The opener knew: the breadcrumb below
       * has always logged the difference. The person was not told.
       *
       * Said only where this device is known to have written something worth
       * keeping. Not `revision`, which counts every committed save: the setup
       * SQL every copy runs, and whatever an application writes for itself
       * before a person has touched it — chess lays out a practice board on
       * open. Read through `revision`, a copy nobody had used was told it had
       * lost something, and the test guarding this sentence turned on whether
       * the count was read before or after that write.
       */
      if (item.wrote === true) {
        say(
          `${item.appName} opened empty: what this device had saved for it isn't here any more. ` +
            `If you have a link to it, or another copy, open that here and the data comes back with it.`,
        );
      }
    }
    // Permanent, on purpose (D22): which database a reopen mounts as its own
    // is the other half of which replica id it keeps.
    console.info(
      opfsDb && opfsDb.byteLength > 0
        ? `dai: reopen mounted the stored database (${opfsDb.byteLength} bytes)`
        : "dai: reopen mounted the library's own copy (no stored database)",
    );

    /*
     * Update last opened time in library.
     *
     * A library write replaces the whole record, so everything not named here
     * is dropped — which is how opening a document from the library erased
     * its own account of when its data was last written, and left an arriving
     * copy with nothing to be newer than. Opening is not saving: `savedAt` is
     * carried across untouched.
     *
     * That was fixed by naming `savedAt`, which fixed one field and left the
     * shape. Standing consent to merge and the shares this copy has issued
     * were still dropped, so opening a document silently withdrew the answer
     * the person gave the last time they were asked. The whole record is
     * carried now, and only what this write owns is overwritten.
     */
    /*
     * Under the lock, and the revision learned inside it (D41).
     *
     * `learnRevision` reads the record and records what this tab believes;
     * writing it back outside the lock lets a save commit in between, so the
     * write rewinds `revision` while the saving tab has moved on — and every
     * save that tab makes afterwards is refused as another tab's work.
     */
    const opened = loaded;
    await withLibraryLock(opened.manifest.documentUuid, async () => {
      const held = (await getCartridgeFromLibrary(opened.manifest.documentUuid).catch(() => null)) ?? item;
      await saveCartridgeToLibrary({
        ...held,
        documentUuid: opened.manifest.documentUuid,
        appName: opened.manifest.appName ?? "container",
        lastOpened: new Date().toISOString(),
        html: opened.html,
        publicKeyFingerprint: opened.publicKeyFingerprint,
        revision: await learnRevision(opened.manifest.documentUuid),
      });
    });

    rememberOpen(loaded.manifest.documentUuid);
    /*
     * At the document's own address before it is mounted (iOS). Not while a
     * move waits to be merged: it is held only in this page, so the reload
     * waits until the merge is in and flushed (`applyPendingMerge`).
     */
    const identity = await identityOf(loaded);
    if (
      pendingMerge &&
      platform() === "ios" &&
      !relaunchedAlready(identity.uuid) &&
      !sameLaunch(location.href, launchAddress(identity))
    ) {
      // Rehearsed, like a first open: see finishMerge.
      entryPoint = entry;
      reloadGate = "waiting: the arriving move is merged first";
      hostMark("prepared");
      rehearsing = true;
      rehearsingMerge = true;
      /*
       * Before the mount, not after it.
       *
       * The merge starts on the frame's handshake, which can arrive while the
       * mount is still finishing. With `mergeFinished` still true from the
       * last one, that merge answered into a finishMerge that returned at its
       * first line: no reload, no sentence, and the cover left standing
       * (second cold review of c1490cb). The wait is declared open before
       * anything can answer it.
       */
      mergeFinished = false;
      mergeCancelled = false;
      onLaunchTap = () => {
        mergeCancelled = true;
        void finishMerge(false);
      };
    } else if (await relaunchAtOwnAddress(identity, entry)) {
      return;
    }
    await mount(loaded);
    /*
     * The cover is never a dead end, here either. `mount` clears the launch
     * guard, so it is armed again after it: the merge can wait on a frame that
     * never answers, and without this the launch screen stood over it with no
     * way off (cold review of c424598, Q2.1). Tap to open ends the wait rather
     * than navigating — see `onLaunchTap`. Only while the wait is still on: a
     * merge that answered during the mount has ended it already.
     */
    if (rehearsingMerge) {
      markStep("merging the move that arrived");
      guardLaunch(launchAddress(identity));
    }
    void showArrival();
    // Off the open's path: the app is on screen before anything is asked.
    void offerNewVersion(loaded);
  } catch (error) {
    say(`Failed to load ${item.appName} (${(error as Error).message})`, true);
  } finally {
    slot.classList.remove("busy");
  }
}

/**
 * Ask whether the author has published a newer version, and offer it (C).
 *
 * After the document is on screen, never before: the check is for somebody
 * using their app, and nothing about it may delay the app appearing. Once a day
 * per document, and only when a relay address is configured — a build with none
 * asks nothing of anybody.
 *
 * Everything here can come to nothing quietly. That is the design: a check that
 * finds nothing is not news, and a check that cannot be made is not a failure a
 * person should read about.
 */
async function offerNewVersion(cartridge: Cartridge): Promise<void> {
  if (!relayBase) return;
  const uuid = cartridge.manifest.documentUuid;
  const version = buildOf(cartridge.manifest);
  if (!version) return; // An unsigned document cannot say which build it is.

  const held = await getCartridgeFromLibrary(uuid).catch(() => null);
  if (!checkIsDue(held?.versionCheckedAt, Date.now())) return;

  // The key this device pinned for the document, which is the only one whose
  // successor it will take.
  const pinned = await trustStore()
    .get(uuid)
    .catch(() => null);
  /*
   * The relay's origin, not the address the mailbox uses.
   *
   * One value configures the relay (`DAI_RELAY_BASE`), and the mailbox is
   * handed it with `/m` on the end — `httpMailbox` appends the document to
   * whatever it is given. The version door is `/v` on the same worker, so the
   * origin is what this needs, and deriving it here keeps one address in the
   * page rather than two that can disagree.
   */
  let origin: string;
  try {
    origin = new URL(relayBase, location.href).origin;
  } catch {
    return;
  }
  const successor = await askForSuccessor({
    relayOrigin: origin,
    documentUuid: uuid,
    version,
    trustedKey: pinned?.publicKey ?? undefined,
  });

  // Asked, whatever came back: the next ask is a day away either way, so a
  // relay that is down is not asked again on every open.
  await withLibraryLock(uuid, async () => {
    const now = await getCartridgeFromLibrary(uuid).catch(() => null);
    if (now) await saveCartridgeToLibrary({ ...now, versionCheckedAt: new Date().toISOString() });
  }).catch(() => undefined);

  if (successor) showUpdateCard(cartridge, successor);
}

/**
 * What a person reads when their app has a new version (the ruling's order):
 * what changed, that their data is kept, Update or Not now.
 *
 * Not now is answered by the card closing. It comes back on the next open,
 * because the successor is still there and the question is still open; nothing
 * is scheduled and nothing happens on its own.
 */
function showUpdateCard(cartridge: Cartridge, successor: Successor): void {
  const sheet = document.getElementById("update-sheet");
  const title = document.getElementById("update-title");
  const note = document.getElementById("update-note");
  const icon = document.getElementById("update-icon") as HTMLImageElement | null;
  const go = document.getElementById("update-go") as HTMLButtonElement | null;
  const later = document.getElementById("update-later");
  if (!sheet || !title || !note || !icon || !go || !later) return;

  const name = cartridge.manifest.appName ?? "this document";
  title.textContent = `${successor.label} of ${name}`;
  note.textContent = successor.note;
  const art = faviconUrl(cartridge.manifest.favicon);
  icon.hidden = !art;
  if (art) icon.src = art;

  const close = (): void => {
    slideClose(sheet);
    go.onclick = null;
    later.onclick = null;
  };
  later.onclick = close;
  sheet.onclick = (event) => {
    if (event.target === sheet) close();
  };
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = "Updating…";
    close();
    /*
     * The address the author published, opened the way any address is opened.
     * What happens next is succession's, not this card's: the successor names
     * the document it replaces, it is adopted only under the key this device
     * pinned, and the rows are carried across once. If it cannot be adopted,
     * the person is told why and the version they have keeps working.
     */
    await openFromUrl(successor.address);
    go.disabled = false;
    go.textContent = "Update";
  };
  slideOpen(sheet);
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
  markStep("mounting the application");
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
  // The person is looking at the document: nothing on its icon is news (D34).
  void badge()?.opened(cartridge.manifest.documentUuid).catch(() => undefined);
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
  clearLaunchGuard();
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
 * Whether a launch for a document this device does not hold means the document
 * was here and is gone (D50).
 *
 * True only where the install shares storage with the browser: an icon is made
 * from a document the device holds, so on Android a launch for one it does not
 * hold means it was there — wiped, or removed by the person. "Any more" is
 * true for both and claims neither.
 *
 * Never on iOS. The icon has storage of its own there (6.3), and its first
 * launch is indistinguishable from a wiped one: a marker saying "this icon has
 * launched before" would live in the storage the wipe reaches. That is a
 * boundary, not a gap — the same shape as D18's hole versus empty stretch —
 * so iOS gets the sentence that is true in both cases.
 *
 * Never on a desktop install either, since D59: a macOS "Add to Dock" app is
 * standalone and classes as desktop, but whether it has its own storage has
 * not been read on a Mac. Asserting a loss on an inference is how a person
 * gets told they lost something they never had. `installStorageIsRead()` holds
 * that line, and a Mac reading is what moves it.
 *
 * The old name for this, `iconLostItsDocument`, claimed a detection it does not
 * do (D64): it is a question about storage, answered from the platform, and
 * nothing in it looks at whether a document was lost.
 */
function installSharesBrowserStorage(): boolean {
  return standalone() && installShareStorage() && installStorageIsRead();
}

/**
 * What the opener says when a document it was sent to is not here (D50, D60).
 *
 * It used to say "Open {name} from your files once … and it will be here every
 * time after that": right for an iOS icon's first launch, wrong for every wipe,
 * and in the wiped case a promise repeated at the moment it had been broken.
 * No sentence here says why the document is not here, because that cannot be
 * known, and none promises anything about next time.
 *
 * Two things vary, and only one of them is the platform. The other is how the
 * person got here, which the address says: an icon launches with the document
 * in the query (`?doc=`, and `?name=` where the icon was made with a name),
 * and a notification carries only the id in the fragment (`sw.js`). Telling
 * somebody who tapped a notification that "this icon will open it again"
 * describes a thing they did not do (D60).
 *
 * `fromIcon` is read from the address and not from the absence of a name: an
 * icon made without one is still an icon, and keying on the name told its owner
 * they had tapped a notification. That is what the runner's own `?doc=` test
 * caught.
 */
function documentNotHere(name: string | null, fromIcon: boolean): string {
  const lost = installSharesBrowserStorage();
  if (!fromIcon) {
    // A notification tap, or any address carrying only the id. Nothing here is
    // an icon, so nothing here says icon.
    return lost
      ? `That document isn't on this device any more. If you still have the file or a link to it, open it here.`
      : `That document isn't on this device. If you have the file or a link to it, open it here.`;
  }
  if (!name) {
    // An icon whose address never carried a name. It used to borrow one — "This
    // icon is for your document" — which named nothing and read as a stand-in.
    return lost
      ? `The document this icon is for isn't on this device any more. If you still have the file, ` +
          `open it here and this icon will open it again.`
      : `This icon is for a document that isn't on this device. If you have the file, open it here ` +
          `and this icon will open it.`;
  }
  return lost
    ? `${name} isn't on this device any more. If you still have the file, open it here ` +
        `and this icon will open it again.`
    : `This icon is for ${name}, and it isn't on this device. If you have the file, open ` +
        `it here and this icon will open it.`;
}

/**
 * Set when an icon launched for a document this device held and no longer
 * does, and the icon carries a link to fetch it from (D50). The card says so,
 * once, for that document.
 */
let returningTo: string | undefined;

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
  markStep("reading the document");
  slot.classList.add("busy");
  say(`Reading ${file.name}…`);

  startHostTiming();

  try {
    markStep("verifying the container");
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
    markStep("checking trust");
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
    markStep("checking the publisher");
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
    markStep("reading the library");
    const library = await listCartridgesFromLibrary();
    const succession = await planSuccession(cartridge, library);

    /*
     * Another copy of a document this device already has (§7).
     *
     * This has to be decided before `familiar` is used, because a sibling is
     * familiar by definition — same document, already held — and the familiar
     * path mounts without asking. For an ordinary document that is right: a
     * newer copy replaces an older one by `savedAt` and nobody needs a
     * question. For a replicated one it is wrong twice over. §1 says `savedAt`
     * succession does not apply to a document with replicated tables at all,
     * and §8.2 says a host must not merge without the person choosing it — so
     * the silent path would both use the wrong rule and skip the only choice
     * that matters.
     *
     * The replication test is the host's own (T1-D4), read from the signed
     * manifest of a container it has already verified. The frame is never
     * asked, and nothing here parses somebody else's SQLite.
     */
    const incomingData = cartridge.archive["document.sqlite"];
    const heldHere = library.find(
      (item) => item.documentUuid === cartridge.manifest.documentUuid,
    );
    /*
     * The game's key is filed here, the moment the document it opens is known.
     *
     * It used to be filed when the mailbox started, which is too late and was
     * the whole of why this fix did not work: a copy that already holds the app
     * takes the merge path, and that runs through `launchFromLibrary` — which
     * ejects first, and `eject` clears the arriving key. The key was gone before
     * anything wrote it down, so the invited copy kept reading the address
     * derived from the document key while the inviter published to the game's
     * own. The same two-addresses failure as D37, one layer along.
     *
     * Here it is known and nothing has ejected yet, so it survives the mount.
     */
    if (arrivedKey && arrivedSession && heldHere) {
      await rememberSessionKey(cartridge.manifest.documentUuid, arrivedSession, arrivedKey);
    }
    const kin =
      heldHere && declaresReplication(cartridge.manifest)
        ? siblingTest(
            {
              documentUuid: cartridge.manifest.documentUuid,
              publicKeyFingerprint: cartridge.publicKeyFingerprint,
              replicated: true,
            },
            {
              documentUuid: heldHere.documentUuid,
              // The same document by the same publisher is the same
              // application, so a replicated incoming copy means a replicated
              // local one; there is nothing further to read.
              publicKeyFingerprint: cartridge.publicKeyFingerprint,
              replicated: true,
            },
          )
        : undefined;

    /*
     * The same id, from somebody else, for a replicated document held here.
     *
     * It cannot be merged — the publishers differ — and it cannot be opened
     * beside the copy here either: this host keeps one copy per document, so
     * opening it would mean replacing the person's own. Refused before the
     * card, in words, with nothing changed. (It used to be offered as *Open as
     * a separate copy*, which is exactly the replacement it named as avoided.)
     */
    if (heldHere && declaresReplication(cartridge.manifest) && kin?.sibling === false) {
      slot.classList.remove("busy");
      say(
        `This link carries a copy of ${cartridge.manifest.appName ?? "a document"} published by somebody else, ` +
          `under the same id as the one on this device. It cannot be opened here without replacing yours, ` +
          `so it was not opened, and nothing on this device was changed.`,
        true,
      );
      return;
    }

    /*
     * A sibling the person has already said yes to (T1-D23).
     *
     * §8.2 requires the person to choose, and a choice can be standing. The
     * first arrival asks; after that, copies this host would have permitted
     * anyway merge without a card, because approving each one is not consent,
     * it is friction — nobody re-approves each message from a sender they
     * already accepted, and a relay delivering moves would be unusable.
     *
     * Silence is only ever for merges that were going to be permitted. Every
     * refusal still reaches the card, and the sibling test still runs on every
     * arrival: this decides whether to *ask*, never whether to *check*.
     */
    const standing = kin?.sibling === true && heldHere?.mergeStanding === true;
    if (standing && incomingData && heldHere) {
      markStep("merging by standing consent");
      if (mountedNonce) {
        // A document is already open: merge the arriving copy straight into it.
        const report = await mergeSiblingInto(incomingData);
        slot.classList.remove("busy");
        // A line, not a card: it says what happened and interrupts nothing.
        say(describeMerge(report), Boolean(report.refused));
        if (!report.refused) return;
        // A refusal is a decision after all, and falls through to the card.
      } else {
        // A cold launch — nothing to merge into yet. Open this device's copy
        // and fold the arriving one in once it is up, silently, as the
        // standing choice asks.
        slot.classList.remove("busy");
        await openThenMerge(heldHere, incomingData, false);
        return;
      }
    }

    /*
     * An icon for a replicated document held here: this device's own copy.
     *
     * The address an icon launches with carries the document's id and the link
     * it first came by. For a document held here that is a return to it, not
     * an arrival — so it opens from the library, as every other return does,
     * and never through the mount decision below, which a held replicated
     * document must not reach (see the guard there).
     */
    if (
      heldHere &&
      kin?.sibling === true &&
      carrier.consentedFor === cartridge.manifest.documentUuid &&
      who.state !== "conflict"
    ) {
      slot.classList.remove("busy");
      await launchFromLibrary(heldHere, "a link to a copy already here");
      return;
    }

    markStep("choosing how to open");
    /*
     * A resume of this device's own held copy — the brought=false gate (T1-D33).
     *
     * We hold this UUID and nothing newer is arriving, so there is no merge and
     * no new rows: §8.2 has nothing to ask, and a reopen of your own game must
     * not stop at a card. It is deliberately *not* `mergeStanding`: that flag is
     * sibling consent (T1-D23), and a reopen must not pre-consent to the other
     * party's future merges — the first of those still asks. This is the
     * narrower gate that silences the reopen and leaves that ask intact.
     *
     * The stamp read here is its own load; the mount below loads again after any
     * succession inherit has been written, which this must not read across. A
     * succession-adoption is an arrival, not a resume, so it is excluded.
     */
    const storedForResume = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    const resumeStamp = savedAtOf(cartridge);
    const resume =
      Boolean(heldHere) &&
      // Not a sibling — the OTHER player's copy of this document. `brought` cannot
      // stand in for this: a sibling that is not newer, or carries no save stamp,
      // reads as bringing nothing, and the resume would mount this device's stored
      // copy as-is and drop the other player's moves and their seat binding with no
      // card and no error. The card is the only place the first sibling merge is
      // offered (T1-D23). The distinction is whose copy, not whether it is newer —
      // the same imprecision D33 corrected in D22's carrier test (T1-D33).
      kin?.sibling !== true &&
      who.state !== "conflict" &&
      !succession?.inherit &&
      Boolean(storedForResume && storedForResume.byteLength > 0) &&
      !(resumeStamp !== undefined && heldHere?.savedAt !== undefined && resumeStamp > heldHere.savedAt);
    const familiar =
      !kin?.sibling &&
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
    if (!familiar && !consented && !resume) {
      markStep("showing the launch card");
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
        // The icon's own document, fetched again because it was gone (D50).
        // Only for the document the icon named: the payload is authoritative,
        // and a link that carried something else is not a return.
        returning:
          returningTo === cartridge.manifest.documentUuid
            ? `${cartridge.manifest.appName ?? "This document"} wasn't on this device any more, ` +
              `so it was fetched again from its link.`
            : undefined,
        // Opening an invite is choosing to play with whoever sent it: the
        // moment, inside the gesture, to ask whether this device may be told
        // when they move (Track 5, slice two).
        onOpen: arrivedKey && declaresReplication(cartridge.manifest) ? askForPush : undefined,
        // Narrowed on the discriminant rather than on its truthiness, which
        // TypeScript does not follow through a nested conditional.
        sibling:
          kin === undefined
            ? undefined
            : kin.sibling === true
              ? ({ offer: true } as const)
              : ({ offer: false, why: whyNotSibling(kin.because) } as const),
        onMerge: kin?.sibling && incomingData
          ? async () => {
              // A cold launch has nothing mounted to merge into: open this
              // device's copy first, then fold the arriving one in, and record
              // the standing choice once it lands. See openThenMerge.
              if (!mountedNonce && heldHere) {
                hideCard();
                await openThenMerge(heldHere, incomingData, true);
                return;
              }
              const report = await mergeSiblingInto(incomingData);
              hideCard();
              say(describeMerge(report), Boolean(report.refused));
              /*
               * The choice, recorded — and only when the merge worked.
               *
               * Standing consent to something that has never succeeded is not
               * a choice anybody made knowingly, and it would silence the very
               * refusal they need to see next time.
               */
              if (!report.refused && heldHere) {
                await saveCartridgeToLibrary({ ...heldHere, mergeStanding: true });
              }
            }
          : undefined,
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
    markStep("recording the publisher");
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
    /*
     * The guard: a replicated document held here is merged into, never mounted over.
     *
     * Past this point the choice is "which whole copy mounts" — the stored one
     * or the arriving one, by `savedAt`. For a document with replicated tables
     * held on this device both answers lose something: the stored copy drops
     * everything the arrival carries (a new game, a seat, the name step), and
     * the arriving copy is written over the person's own and takes their other
     * games with it. Both happened, silently, to a person following a second
     * invite. Every path above sends such an arrival to a merge or to the
     * library, so this is unreachable — and it is here so that the next change
     * that reopens a path is refused out loud instead of costing somebody a
     * game. Permanent, on purpose; the console line is what a test and a trace
     * look for.
     */
    if (heldHere && declaresReplication(cartridge.manifest)) {
      console.error(
        `dai: refused to mount an arriving copy of ${cartridge.manifest.documentUuid} over this device's copy without merging it`,
      );
      slot.classList.remove("busy");
      say(
        `This could not be added to your copy of ${cartridge.manifest.appName ?? "this document"}, so it was not opened, ` +
          `and nothing on this device was changed. Try the link again.`,
        true,
      );
      return;
    }

    markStep("reading stored data (OPFS)");
    const opfsDb = await loadDatabaseFromOpfs(cartridge.manifest.documentUuid);
    const arriving = savedAtOf(cartridge);
    const heldItem = library.find(
      (item) => item.documentUuid === cartridge.manifest.documentUuid,
    );
    /*
     * Which copy opens is decided from what each has seen, not whose clock ran
     * last (D36, src/copy-choice.ts). A save that changed nothing a person did
     * used to move this copy's stamp past a real move made elsewhere, and the
     * move was dropped with nothing said.
     */
    const incomingDb = cartridge.archive["document.sqlite"];
    const hasStored = Boolean(opfsDb && opfsDb.byteLength > 0);
    const localDigest = hasStored ? await databaseDigest(opfsDb!) : undefined;
    const arrivingDigest = incomingDb && incomingDb.byteLength > 0 ? await databaseDigest(incomingDb) : undefined;

    /*
     * A different build of the application, arriving over something a person
     * wrote here: refused before any of the questions below are asked (D85).
     *
     * It is asked here rather than inside `chooseCopy` because it is not a
     * question about data, and the data cannot answer it. A rebuild ships the
     * same empty database its first build did, so every comparison of
     * databases reads an author's new version and a person's own install file
     * exactly alike — by stamps, by digest, by history. What tells them apart
     * is the signature, which covers the author's files and not the database,
     * and is the same for every copy of one build however it travelled.
     *
     * Both sides must be able to say which build they are. An unsigned
     * container cannot, and an older record does not have it written down;
     * either way this is undecided and nothing is refused on a guess.
     */
    const arrivingBuild = buildOf(cartridge.manifest);
    const differentBuild =
      heldItem?.build !== undefined && arrivingBuild !== undefined && heldItem.build !== arrivingBuild;
    if (hasStored && heldItem?.wrote === true && differentBuild) {
      console.error(
        `dai: refused a different build of ${cartridge.manifest.documentUuid}: ` +
          `this device holds one somebody has written to, and succession is the only update`,
      );
      slot.classList.remove("busy");
      const appName = cartridge.manifest.appName ?? "this document";
      say(
        `This copy of ${appName} did not come from the one on this device, so opening it would have put what you have ` +
          `written aside; nothing was opened and nothing here was changed. A new version from the same author keeps your ` +
          `entries and says so before it opens.`,
        true,
      );
      return;
    }

    const decided =
      hasStored && heldItem && localDigest !== undefined && arrivingDigest !== undefined
        ? chooseCopy(heldItem, localDigest, { savedAt: arriving, digest: arrivingDigest })
        : // Nothing stored here, or nothing arriving to compare: the old rule, which
          // is all either case ever needed.
          hasStored && arriving !== undefined && heldItem?.savedAt !== undefined && arriving > heldItem.savedAt
          ? ({ kind: "take" } as const)
          : ({
              kind: "keep",
              older: arriving !== undefined && heldItem?.savedAt !== undefined && arriving < heldItem.savedAt,
            } as const);

    /*
     * Two copies that both changed since they last matched. Neither has seen
     * the other, so there is no correct one to open, and opening either would
     * drop the other's changes without a word. Nothing is mounted, nothing
     * stored is touched, and the person is told what happened. The console
     * line is what a test and a trace look for.
     */
    if (hasStored) {
      // What the choice was made from, for a trace: the stamps, and whether
      // each database is the matched one or this copy's own past.
      console.info(
        `dai: copy choice for ${cartridge.manifest.documentUuid.slice(0, 8)}: ${decided.kind}` +
          ` (arriving ${arriving ?? "unstamped"}, matched ${heldItem?.matchedAt ?? "none"}, ` +
          `here ${localDigest === heldItem?.matchedDigest ? "unchanged" : "changed"} since the match, ` +
          `arriving ${arrivingDigest !== undefined && heldItem?.history?.includes(arrivingDigest) ? "is" : "is not"} this copy's own)`,
      );
    }
    /*
     * A copy with no relationship to the one here, arriving over something a
     * person has written (D85).
     *
     * Same id, and nothing says they are related: not this copy's own past, not
     * the copy it last matched, and no match to reason from at all. An author
     * who rebuilds their app under the same id lands exactly here, and what
     * used to happen is that the newer stamp won and the person's rows were
     * replaced with the ones in the rebuild — usually none — with nothing said.
     *
     * Succession is the only update (the ruling): a new id, signed
     * `supersedes`, adopted under the key this device already pinned, and the
     * rows carried across. This branch is what stands where that is missing.
     */
    if (hasStored && decided.kind === "diverged") {
      console.error(
        `dai: refused to choose between diverged copies of ${cartridge.manifest.documentUuid}: both changed since they last matched`,
      );
      slot.classList.remove("busy");
      const appName = cartridge.manifest.appName ?? "this document";
      say(
        `This link and the copy of ${appName} on this device were both changed since they last matched, so neither was opened over the other. ` +
          `Nothing on this device was changed. To see what the link holds without replacing your copy, open it in a private window; ` +
          `to keep one, agree with whoever sent it which copy goes on.`,
        true,
      );
      return;
    }

    const brought = hasStored && decided.kind === "take";

    if (opfsDb && opfsDb.byteLength > 0 && !brought) {
      // Resuming this device's own held copy — a stored database for a UUID this
      // device holds, with nothing newer arriving. It writes under the same
      // author id it always has (T1-D33), because that id is this device's key,
      // not a property of the copy: a resume cannot rebind a session's seat.
      markStep("preparing the document");
      loaded = await resealCartridge(cartridge, opfsDb);
      console.info(`dai: resumed this device's own copy from the stored database (${opfsDb.byteLength} bytes)`);
      if (decided.kind === "keep" && decided.older) {
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
        markStep("saving the arriving copy (OPFS)");
        await saveDatabaseToOpfs(cartridge.manifest.documentUuid, incoming);
      }
    }

    // Kept on this device — and said only once it is. Storage can refuse
    // (a private window, a full quota); the document still opens, and the
    // menu says it was not kept rather than promising it was.
    markStep("keeping it on this device");
    try {
      /*
       * Read again rather than reuse `heldItem`, which was read before the
       * document was identified and before an arriving game's key was filed
       * against it (D37). A write built from the older snapshot silently drops
       * whatever was added in between — the same shape of loss the note below
       * describes for standing consent and issued shares.
       */
      const kept = loaded;
      const keepRecord = async (): Promise<Parameters<typeof saveCartridgeToLibrary>[0]> => {
      // Read inside the lock, with the revision learned there too (D41): a
      // record read outside it can be written back over a save that committed
      // in between, rewinding the counter and refusing every later save.
      const keepItem = (await getCartridgeFromLibrary(kept.manifest.documentUuid).catch(() => null)) ?? heldItem;
      return {
        // Standing consent and issued shares belong to the copy, not to this
        // write. See the note on the save path above.
        ...keepItem,
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
        /*
         * The last match (D36). A copy taken in is a match, by its own stamp and
         * database. So is the first copy this device ever holds: the file or link
         * it came from. A resumed copy keeps the match it had; one with no match
         * recorded, from before this existed, starts one here, at what it holds.
         */
        ...matchAfterOpen(keepItem, brought, hasStored, localDigest, arrivingDigest, arriving),
        // The address this copy came by, when it is short enough to be an
        // address rather than the document (a store link). See identityOf.
        link: shortArrivalLink() ?? heldItem?.link,
        html: loaded.html,
        publicKeyFingerprint: loaded.publicKeyFingerprint,
        revision: await learnRevision(kept.manifest.documentUuid),
      };
      };
      await withLibraryLock(kept.manifest.documentUuid, async () => {
        await saveCartridgeToLibrary(await keepRecord());
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
    const entry = "a file or a link, opened here";
    if (!keptOnDevice) {
      // Nothing held to launch into: the address would open an empty chooser.
      entryPoint = entry;
      reloadGate =
        platform() !== "ios" ? `not taken: platform is ${platform()}` : "not taken: this device could not keep a copy";
    } else {
      const identity = await identityOf(loaded);
      if (
        platform() === "ios" &&
        !relaunchedAlready(identity.uuid) &&
        !sameLaunch(location.href, launchAddress(identity))
      ) {
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
      }
      if (await relaunchAtOwnAddress(identity, entry)) return;
    }

    void showArrival();
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

  /*
   * Anything pending is written before the bytes are read.
   *
   * Autosave lands a moment after the last edit, and this reads OPFS — so a
   * copy saved inside that window was the document as it stood *before* the
   * thing the person had just done. Playing a move and immediately sending the
   * board produced a file with the move missing, and neither the sender nor the
   * recipient had any way to tell: the file was valid, complete, and one move
   * stale.
   *
   * `currentHtml` has always flushed first. This path did not, which is the
   * cost of two functions packaging the same document.
   */
  let opfsDb: Uint8Array | null;
  try {
    await flushBeforeLeaving();
    opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
    await mayLeave(opfsDb);
  } catch (error) {
    say((error as Error).message, true);
    return;
  }
  const activeCartridge = opfsDb ? await resealCartridge(loaded, opfsDb) : loaded;
  loaded = activeCartridge;
  if (opfsDb) await noteSentOut(activeCartridge, opfsDb);

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
/**
 * What an open does to a copy's record of its last match (D36). Taking a copy
 * in, or holding a document for the first time, is a match with that copy.
 * Resuming leaves the match alone, and starts one for a record that predates it.
 */
function matchAfterOpen(
  held: LibraryItem | null | undefined,
  brought: boolean,
  hasStored: boolean,
  localDigest: string | undefined,
  arrivingDigest: string | undefined,
  arrivingAt: string | undefined,
): Pick<LibraryItem, "matchedAt" | "matchedDigest" | "history"> {
  const tookIn = brought || !hasStored;
  if (tookIn && arrivingDigest !== undefined) {
    return { matchedAt: arrivingAt, matchedDigest: arrivingDigest, history: remember(held?.history, arrivingDigest) };
  }
  // Held for the first time, as built: no database yet. The match is the blank
  // document, which the first open's setup save then fills in (afterSave).
  if (!hasStored && held?.matchedDigest === undefined) {
    return { matchedAt: arrivingAt, matchedDigest: BLANK_DIGEST, history: held?.history ?? [] };
  }
  if (held?.matchedDigest === undefined && localDigest !== undefined) {
    return { matchedAt: held?.savedAt, matchedDigest: localDigest, history: remember(held?.history, localDigest) };
  }
  return { matchedAt: held?.matchedAt, matchedDigest: held?.matchedDigest, history: held?.history };
}

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

  if (data.type === TO_HOST.ISOLATION_REPORT) {
    // Kept for the harness that holds this host's claim against the probe.
    if (event.source === cartridgeFrame.contentWindow) lastIsolationReport = data;
    return;
  }

  if (data.type === TO_HOST.HANDSHAKE) {
    // The frame this runner mounted, and no other window.
    if (event.source !== cartridgeFrame.contentWindow) return;
    handshakeEstablished = true;
    mountedNonce = (data.payload?.sessionNonce as string) ?? null;
    // A new mount: whatever this host agreed to write for the last one is gone
    // with it (cold review of identity step 3, finding 1). A document that
    // follows a shared one must not inherit the right to have its headers signed.
    mountWrites = null;
    frameSessionLanes = data.payload?.sessionLanes === true;

    // A sibling that arrived on a cold launch, now that there is a frame to
    // merge it into. See openThenMerge.
    if (pendingMerge) void applyPendingMerge();

    // The mailbox loop, now that there is a frame to publish from and pull into
    // (Track 5). No-op unless the document is replicated, a relay is set, and
    // this device holds the key.
    void startMailboxIfPossible();

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

    /*
     * The write rules, pushed to a replicated document at mount (T1-D23).
     *
     * Pushed and not requested. The host already knows whether this document
     * is replicated — it computed that from bytes it verified, before any of
     * this — so it can simply send the module, and a frame-initiated request
     * channel never has to exist. Host computes, host decides, frame receives
     * and checks against its own pin.
     *
     * A document with no replicated tables is sent nothing and pays nothing.
     * One that has them cannot function without these rules: the first move of
     * a game is a write, long before any merge, so this is not lazy in the
     * sense the merge delivery is — it is the difference between a working
     * document and a read-only one.
     */
    void (async () => {
      if (!loaded || !declaresReplication(loaded.manifest)) return;
      const writingUuid = loaded.manifest.documentUuid;
      /*
       * Whether this device may write this document at all, decided before any
       * write rule or save goes through (cold review of identity step 2, #5).
       * The first use of the person key is here, on the first mount that can
       * write: made now if the store says none is kept. A key that cannot be
       * read is not replaced by a new one, and a floor that cannot be read is
       * not read as 0; either way every write is refused, saves included, and
       * the page says so. The save handler waits on this same answer.
       */
      const decided = (async (): Promise<{ me: Person; seqFloor: number } | { refused: string }> => {
        const me = await person().catch(() => null);
        if (!me) {
          return {
            refused:
              "This document can be read here but not changed: this device's key could not be read. " +
              "Reload the page to try again.",
          };
        }
        // Read again for up to four seconds, the key's deadline: a store that
        // never answers is not waited on forever (cold review, step 3, #4).
        const seqFloor = await seqFloorWithin(writingUuid).catch(() => null);
        if (seqFloor === null) {
          return {
            refused:
              "This document can be read here but not changed: this device could not read how far it " +
              "has written it. Reload the page to try again.",
          };
        }
        return { me, seqFloor };
      })();
      mountWrites = { nonce: mountedNonce, documentUuid: writingUuid, decided };
      /*
       * A failure here is said out loud, because the alternative already
       * happened.
       *
       * This swallowed the error and returned. The host had decided the
       * document was replicated and then quietly delivered nothing, so the
       * application refused its own first write and the person was shown
       * `WRITE_SURFACE_UNAVAILABLE` — a code, from inside the frame, about a
       * decision this side made. Nothing on screen came from the half that
       * knew what went wrong.
       *
       * The document still opens: it is intact, and reading it is worth more
       * than nothing. What it cannot do is take a write, and that is what the
       * sentence says.
       */
      const source = await loadMergeModule().catch(() => null);
      if (!source) {
        say(
          "This document can be read here but not changed: the part of the app that " +
            "writes its shared tables could not be loaded. Reload the page to try again.",
          true,
        );
        return;
      }
      const decision = await decided;
      if ("refused" in decision) {
        say(decision.refused, true);
        return;
      }
      const replica = decision.me.id;
      const seqFloor = decision.seqFloor;
      (event.source as Window | null)?.postMessage(
        {
          type: TO_DOCUMENT.WRITE_RULES,
          sessionNonce: mountedNonce,
          source,
          // The author id this device writes under: the fingerprint of the
          // host's person key. The frame writes under it whatever the mounted
          // file holds, on every mount (docs/identity.md, binding rule 1).
          replica,
          seqFloor,
          // The document every batch header names (docs/identity.md, step 3).
          document: loaded.manifest.documentUuid,
          // T1-D32: who may close this session, from the signed manifest. The
          // frame refuses a close the policy forbids at write time; the views are
          // the convergent net. Undefined for a document with no session.
          closePolicy: loaded.manifest.session ? (loaded.manifest.session.close ?? "any") : undefined,
        },
        "*",
      );
    })();

    (event.source as Window | null)?.postMessage(
      {
        type: TO_DOCUMENT.HANDSHAKE_ACK,
        // A viewer: this host keeps a copy on the device and can export. It
        // cannot write the file it was given in place, and it says so.
        // What this host applies, by the probe's own ids. A claim, checked in
        // CI by mounting the probe here; see src/host-profile.ts.
        payload: { sessionNonce: mountedNonce, hostClass: "viewer", applied: ISOLATION_CLAUSES },
      },
      "*",
    );
  } else if (data.type === TO_HOST.REFUSED) {
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
  } else if (data.type === TO_HOST.GROUND) {
    // The colour at the top edge of the application, measured by it once it
    // had painted, for the strip above it that only this page can colour.
    // An application that declared a theme-color said what that strip should
    // be, and what it said stands.
    if (!fromMountedContainer(event, data)) return;
    if (declaredGround) return;
    const colour = typeof data.colour === "string" ? data.colour.trim() : "";
    if (!COLOUR.test(colour)) return;
    settleGround(colour);
  } else if (data.type === TO_HOST.REQUEST_SHARE) {
    /*
     * The application asked for its host's own share sheet.
     *
     * Identical to a tap on the menu's "Share app": the same sheet, the same
     * name and icon read from the same manifest, the same choice of whether
     * to include data, the same press of Send before anything is built. The
     * application chose the moment; the person still chooses what happens.
     */
    if (!fromMountedContainer(event, data)) return;
    // A session id makes the sheet an invite into that one session (T1-D28).
    // Checked again here: a malformed one is ignored, never guessed at.
    const session = typeof data.session === "string" && /^[0-9a-f]{32}$/.test(data.session) ? data.session : undefined;
    void sendDocument(session);
  } else if (data.type === TO_HOST.WAITING) {
    /*
     * The application's count of games waiting on this person (D34), kept for
     * the service worker to badge the icon from when a push lands and the
     * application is not running. Only well-formed session ids are kept, and
     * the badge is cleared: this is reported while the person is looking.
     */
    if (!fromMountedContainer(event, data)) return;
    const sessions = Array.isArray(data.sessions)
      ? (data.sessions as unknown[]).filter((s): s is string => typeof s === "string" && /^[0-9a-f]{32}$/.test(s))
      : [];
    if (mountedUuid) void badge()?.reported(mountedUuid, sessions).catch(() => undefined);
  } else if (data.type === TO_HOST.WRITE_RULES_REFUSED) {
    /*
     * The rules were delivered and the frame would not adopt them.
     *
     * This host decided the document was replicated and sent the module; the
     * frame checked it against the digest compiled into its own runtime and
     * said no. Until now that ended in silence, and the person met
     * `WRITE_SURFACE_UNAVAILABLE` — the consequence, raised in the frame, of a
     * disagreement between two halves neither of which had said anything.
     *
     * The reason is shown rather than logged. It is the only thing that
     * separates "this build shipped mismatched parts", which nobody but us can
     * fix, from "this browser will not run the module", which a different
     * browser might.
     */
    if (!fromMountedContainer(event, data)) return;
    const why = String(data.why ?? "unknown");
    const detail = typeof data.detail === "string" ? data.detail : "";
    say(
      `This document can be read here but not changed: the app could not load the part ` +
        `that writes its shared tables (${why}${detail ? ` — ${detail}` : ""}).`,
      true,
    );
  } else if (data.type === TO_HOST.SAVE_STATE) {
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
  } else if (data.type === TO_HOST.TIMING) {
    // The boot finished. The handshake went out before the application had
    // painted, so this is the message carrying the number that matters.
    if (fromMountedContainer(event, data)) {
      recordTimings(data.payload?.timings as { phase: string; at: number }[] | undefined);
      // The app has drawn: the launch screen has done its job — unless a
      // first open on iOS is about to load the page again (see rehearsing).
      window.clearTimeout(bootingGuard);
      if (!rehearsing) document.body.classList.remove("booting");
    }
  } else if (data.type === TO_HOST.USED) {
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
  } else if (data.type === TO_HOST.LEAVE_CHECK) {
    // The shell is about to write a file itself (a download or a picker save)
    // and asks first; the answer comes from the bytes, opened here (#2).
    if (!fromMountedContainer(event, data)) return;
    const answer = (ok: boolean, error?: string): void => {
      (event.source as Window | null)?.postMessage(
        { type: TO_DOCUMENT.LEAVE_CHECKED, id: data.id, ok, ...(error ? { error } : {}) },
        "*",
      );
    };
    const bytes = data.sqlite instanceof Uint8Array ? data.sqlite : null;
    void mayLeave(bytes).then(
      () => answer(true),
      (error: unknown) => answer(false, error instanceof Error ? error.message : String(error)),
    );
  } else if (data.type === TO_HOST.SIGN) {
    /*
     * Signing a batch header with this device's person key (docs/identity.md,
     * step 3). The private key never leaves here. Signed only when the header
     * is this device's own author, for the document that is open, in the
     * format this host speaks; and only after the sequence floor has counted
     * the batch, so the order at a leave point is floor, seal, send.
     */
    if (!fromMountedContainer(event, data)) return;
    const reply = (answer: { sig?: Uint8Array; pub?: Uint8Array; error?: string }): void => {
      (event.source as Window | null)?.postMessage({ type: TO_DOCUMENT.SIGNED, id: data.id, ...answer }, "*");
    };
    void (async () => {
      // Only for the document mounted now, under the decision made for this
      // very mount: never a header for a document opened before this one.
      const mount = mountWrites && mountWrites.nonce === mountedNonce ? mountWrites : null;
      const writes = mount ? await mount.decided : null;
      if (!mount || !writes || !loaded || loaded.manifest.documentUuid !== mount.documentUuid) {
        return reply({ error: "This document is not open for writing here." });
      }
      const seq = Number(data.seq);
      if (!Number.isSafeInteger(seq) || seq <= 0) return reply({ error: "A batch names no sequence this device can record." });
      if ("refused" in writes) return reply({ error: writes.refused });
      const header = data.header instanceof Uint8Array ? data.header : null;
      let fields: unknown = null;
      try {
        fields = header ? decodeCbor(header) : null;
      } catch {
        fields = null;
      }
      const ours =
        Array.isArray(fields) &&
        fields.length === 5 &&
        fields[0] === BATCH_FORMAT_VERSION &&
        fields[1] === mount.documentUuid &&
        fields[2] instanceof Uint8Array &&
        showAuthorId(fields[2]) === writes.me.author;
      if (!header || !ours) return reply({ error: "This device signs only its own changes to the document that is open." });
      try {
        await raiseSeqFloor(mount.documentUuid, seq);
      } catch {
        return reply({ error: "This device could not record how far it has written, so the change was not signed." });
      }
      reply({ sig: await signBytes(writes.me.keys.privateKey, header), pub: writes.me.pub });
    })();
  } else if (data.type === TO_HOST.SAVE) {
    // A save writes to this device's storage under a document's identity, so it
    // is answered only for the container that handshook.
    if (!fromMountedContainer(event, data)) return;
    hostSaves += 1;
    const saveNumber = hostSaves;
    // Echoed on the reply so the container can tell this answer from any
    // other message that happens to be shaped like one.
    const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
    const { databaseBytes, documentUuid } = data.payload || {};
    if (databaseBytes && documentUuid) {
      const bytes = new Uint8Array(databaseBytes);
      // Permanent, on purpose (D22): "asked" is not "written", and a kept
      // trace of a lost replica id has to be able to tell which one happened.
      console.info(`dai: save ${saveNumber} asked (${bytes.byteLength} bytes)`);
      /*
       * One save at a time per document, across every tab of this origin.
       * Two tabs on one document each write the whole database; without the
       * lock the second write can land under the first's reseal and the
       * library keeps a copy that matches neither.
       */
      /*
       * The shared lock, not a second spelling of it (D41).
       *
       * This path had its own `locked` helper taking `dai:<uuid>` — the same
       * lock `withLibraryLock` takes, under another name. One lock with two
       * names is the shape that cost a night already: a guard reading the
       * source cannot see that the two are the same, and every writer that
       * should have been holding it looked unlocked. One spelling, so the rule
       * is checkable.
       */
      const locked = <T,>(work: () => Promise<T>): Promise<T> =>
        withLibraryLock(documentUuid, work);
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
        // A document this device may not write is not saved: the same answer
        // the mount gave, waited on here so no save goes through before it.
        const writes = mountWrites?.documentUuid === documentUuid ? await mountWrites.decided : null;
        if (writes && "refused" in writes) throw new Error(writes.refused);
        const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
        const current = held?.revision ?? 0;
        if (knownRevision.has(documentUuid) && knownRevision.get(documentUuid) !== current) {
          throw new Error(
            "This document was saved from another tab since it was opened here. " +
              "To keep these changes, use Save a copy; to see the other tab's, reopen it.",
          );
        }
        // The floor first, then the save: a save that fails after this has
        // still counted its seqs, and one that fails before it wrote nothing.
        await raiseSeqFloor(documentUuid, Number(data.payload?.seq ?? 0));
        await saveDatabaseToOpfs(documentUuid, bytes);
        const next = current + 1;
        if (loaded && loaded.manifest.documentUuid === documentUuid) {
          loaded = await resealCartridge(loaded, bytes);
          await saveCartridgeToLibrary({
            /*
             * What this write does not own, it keeps.
             *
             * A library item carries more than the document: standing consent
             * to merge (T1-D23) and the shares this copy has issued. Rebuilding
             * it as a literal silently dropped both — so playing a move, which
             * is a save, revoked the consent given a moment earlier, and the
             * person was asked again on the very next exchange. That is exactly
             * the friction the standing-consent ruling exists to remove, caused
             * by the code that implements it.
             */
            ...held,
            documentUuid: loaded.manifest.documentUuid,
            appName: loaded.manifest.appName ?? "container",
            lastOpened: new Date().toISOString(),
            // Stamped by the reseal a line above. Without it here, this
            // device has no record of when its own copy was last written,
            // and an arriving copy cannot be told newer or older than it.
            savedAt: savedAtOf(loaded),
            // Every database this copy has held, so a link it sends now can be
            // recognized as its own when it comes back (D36). A save is a change
            // since the last match, unless the runtime says it was only the
            // document's own setup SQL, which every copy runs.
            ...(held ? afterSave(held, await databaseDigest(bytes), data.payload?.setup === true) : {}),
            html: loaded.html,
            publicKeyFingerprint: loaded.publicKeyFingerprint,
            revision: next,
            // "Something has been written here that nobody would want to lose."
            // Not `revision`, which counts the setup SQL every copy runs and
            // any write an application makes before a person has touched it
            // (D51). Once true, it stays true.
            ...(data.payload?.setup === true ? {} : { wrote: true }),
            // Which build this copy is running, so an arriving copy can be told
            // apart by its application rather than by its data (D85).
            ...(buildOf(loaded.manifest) ? { build: buildOf(loaded.manifest) } : {}),
          });
        } else if (held) {
          await saveCartridgeToLibrary({ ...held, revision: next });
        }
        knownRevision.set(documentUuid, next);
      })
        .then(async () => {
          console.info(`dai: save ${saveNumber} written`);
          hostSavesWritten += 1;
          /*
           * The first thing worth keeping is on this device, so now is when the
           * browser is asked to keep it (D55).
           *
           * Not the document's own setup SQL, which every copy runs on first
           * open and which nobody would mind losing: the runtime says which
           * this was, and the library write above already reads it for the same
           * reason. Off the save's path, like the replica record below.
           */
          if (data.payload?.setup !== true) askForPersistence("after the first save");
          (event.source as Window | null)?.postMessage(
            { type: TO_DOCUMENT.SAVE_ACK, status: "ok", requestId },
            "*",
          );
        })
        .catch((error: unknown) => {
          console.info(`dai: save ${saveNumber} refused: ${String(error)}`);
          (event.source as Window | null)?.postMessage(
            { type: TO_DOCUMENT.SAVE_ACK, status: "error", error: String(error), requestId },
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
  // Checked here, on menu open, and never at load: the offline-open guarantee is
  // that a held document asks the network for nothing (T1 note in showVersion).
  void checkForUpdate();
});
document.getElementById("doc-note")?.addEventListener("click", (event) => {
  (event.currentTarget as HTMLElement).hidden = true;
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
/** Said when outgoing bytes would carry a row of this device's that nobody signed. */
const UNSIGNED_LEAVE =
  "This has changes of yours that were never signed, so it was not sent or saved to a file. " +
  "Let the app save once more, then try again.";

/**
 * Whether these database bytes may leave this device: for a replicated
 * document, none of this author's rows in them is pending or names a batch the
 * bytes hold no header for. The host opens the bytes itself (cold review of
 * identity step 3, #2); the frame belongs to the document. Throws the sentence
 * when they may not.
 */
async function mayLeave(bytes: Uint8Array | null | undefined): Promise<void> {
  if (!bytes || !loaded || !declaresReplication(loaded.manifest)) return;
  const mount = mountWrites && mountWrites.nonce === mountedNonce ? mountWrites : null;
  const writes = mount ? await mount.decided : null;
  // No key this mount may write under: nothing of this device's could be signed.
  if (!writes || "refused" in writes) return;
  if ((await unsealedOwnRows(bytes, writes.me.id)) > 0) throw new Error(UNSIGNED_LEAVE);
}

/**
 * Flushes before the document leaves this device (an export, a share, an
 * invite). For a replicated document a flush that did not land refuses the
 * leave: its rows are sealed as part of the flush, and a document whose seal
 * or save failed would carry rows nobody signed (docs/identity.md, step 3).
 */
async function flushBeforeLeaving(): Promise<void> {
  const landed = await flushDocument();
  if (!landed && loaded && declaresReplication(loaded.manifest)) {
    throw new Error(
      "The latest changes here could not be signed and saved, so this was not sent. Try again in a moment.",
    );
  }
}

/** Resolves true once the frame confirms its pending writes are stored, false if it did not say so in time. */
function flushDocument(): Promise<boolean> {
  const target = cartridgeFrame.contentWindow;
  if (!target || !mountedNonce) return Promise.resolve(false);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    // Long enough for a seal: the frame asks this host to sign before it saves
    // (identity step 3), and its own wait for a signature is 15 seconds.
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onFlushed);
      resolve(false);
    }, 10_000);
    const onFlushed = (event: MessageEvent): void => {
      const data = event.data as { type?: string; id?: string; sessionNonce?: string; saved?: boolean } | null;
      if (!data || data.type !== TO_HOST.FLUSHED || data.id !== id) return;
      if (!fromMountedContainer(event, data)) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onFlushed);
      // An older runtime does not say; its answer meant "done" and is taken so.
      resolve(data.saved !== false);
    };
    window.addEventListener("message", onFlushed);
    target.postMessage({ type: TO_DOCUMENT.FLUSH, id }, "*");
  });
}

/**
 * What a merge did, in a sentence.
 *
 * The counts are four numbers and a list, and three of them are the kind of
 * detail that belongs in a log. What a person needs is what changed, whether
 * anything now disagrees, and — if nothing happened — why.
 *
 * `conflicts` gets words rather than a number. "2 conflicts" tells somebody
 * there is a problem and nothing about what to do; the entities are still
 * there, both versions are kept, and the application is where they are looked
 * at. A count with no route to the thing it counts is an alarm.
 */
export function describeMerge(report: MergeReport): string {
  if (report.refused) {
    switch (report.refused) {
      case "SCHEMA_MISMATCH":
        return "These two copies were built from different versions of the app, so their rows cannot be lined up. Open the newer one first.";
      case "NOT_REPLICATED":
        return "This document is replaced as a whole rather than merged.";
      case "UNSUPPORTED_LEVEL":
        return "This copy expects checks this app cannot make yet. Nothing was merged, and your copy is untouched.";
      case "MERGE_MODULE_MISMATCH":
        return "This app could not verify its own merge, so it did not run one. Your copy is untouched.";
      case "MERGE_TIMED_OUT":
        return "The merge did not finish in time. Nothing here has changed; try again.";
      case "NOT_A_DATABASE":
        return "There is nothing readable in that copy to merge.";
      default:
        return "Nothing was merged, and your copy is exactly as it was.";
    }
  }

  const added = report.applied;
  const parts: string[] = [];
  parts.push(
    added === 0
      ? "Nothing new — you already had everything in that copy."
      : added === 1
        ? "One change came across."
        : `${added} changes came across.`,
  );
  if (report.rejected.length > 0) {
    // Said, never hidden: a row refused is a row somebody wrote that this copy
    // will not hold, and the rest of the exchange still happened.
    parts.push(
      report.rejected.length === 1
        ? "One row was refused because it claims an id another row already uses."
        : `${report.rejected.length} rows were refused because they claim ids other rows already use.`,
    );
  }
  /*
   * Conflicts are not mentioned here, deliberately.
   *
   * They are the application's to surface, where the person can act on them —
   * *Keep Nf3 / Keep d4*, in the app, next to the thing being chosen between.
   * A host line reading "2 conflicts" is friction with no action attached: it
   * reports a problem, offers no route to it, and the count is already
   * travelling in dai:merged for the app to use.
   */
  return parts.join(" ");
}

/**
 * What a merge did, as the frame reports it (T1-D20).
 */
export interface MergeReport {
  applied: number;
  duplicate: number;
  rejected: string[];
  newReplicas: number;
  /** Batches refused by author and code (identity step 4); always present. */
  refusedBatches: { author: string; reason: string }[];
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

/**
 * Merge requests this host has stopped waiting for.
 *
 * A timeout stops the host waiting; it does not stop the frame. If the frame
 * finishes at thirty-one seconds its answer arrives for a request already
 * reported as timed out — and with no id to match against, that answer would
 * resolve whatever request happened to be listening, which after a retry is a
 * different merge entirely.
 *
 * The frame's transaction is the frame's to finish. It commits or rolls back on
 * its own terms and is never left open because this side stopped listening;
 * otherwise the timeout becomes a second source of the half-written row the
 * transaction was added to prevent.
 */
const closedMerges = new Set<string>();

/**
 * The write rules and the merge, fetched once.
 *
 * Against `document.baseURI`, as every other runtime asset is — the engine,
 * the confusables table, the roots — and never against `location.href`. The
 * page carries `<base href="/">`, so the base is the site root whatever
 * address the person is on; `location.href` is the address itself.
 *
 * That difference is the whole of a bug. A document opened from its own page
 * has an address like `/d/<uuid>`, and `runtime/dai-merge.js` resolved against
 * *that* asks for `/d/runtime/dai-merge.js`, which does not exist. The fetch
 * failed, the push was skipped, and the application refused its own first write
 * with `WRITE_SURFACE_UNAVAILABLE` — on a phone, on the route people actually
 * use, while every test opening from the root passed.
 */
/** The merge module's digest, stamped in at build (vite `define`); "" in a bare dev server. */
declare const __DAI_MERGE_DIGEST__: string;

async function loadMergeModule(): Promise<string> {
  if (mergeSource !== null) return mergeSource;
  // Asked for by its digest, so a browser that cached an older merge module
  // under the plain name — a service worker that never updated on iOS is the
  // case — cannot answer with it: a new build is a new URL, missed by that
  // cache and fetched fresh, while a held document asks for the URL it holds and
  // still opens offline. `force-cache` is safe on a name that means one thing.
  // The plain name remains the fallback where the digest was not stamped in.
  const name =
    typeof __DAI_MERGE_DIGEST__ === "string" && __DAI_MERGE_DIGEST__.length > 0
      ? `runtime/dai-merge.${__DAI_MERGE_DIGEST__}.js`
      : "runtime/dai-merge.js";
  const response = await fetch(new URL(name, document.baseURI), {
    cache: "force-cache",
  });
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
/*
 * An arriving sibling to fold in once this device's copy is open.
 *
 * A merge runs inside the frame, over the database the frame has open, so it
 * needs a document mounted. A cold launch from a link has none — nothing is
 * mounted yet — and mergeSiblingInto then answers NO_DOCUMENT_OPEN. The older
 * path read that as a failed merge, said "nothing was merged", and left the
 * person on the chooser without opening their copy at all. So instead this
 * device's copy is opened and the arriving one is remembered here; the merge
 * is applied from the handshake, once there is a frame to merge into.
 */
let pendingMerge: { data: Uint8Array; heldItem: LibraryItem; recordStanding: boolean } | null = null;

/** Open this device's copy, then merge the arriving sibling into it. */
async function openThenMerge(
  heldItem: LibraryItem,
  data: Uint8Array,
  recordStanding: boolean,
): Promise<void> {
  pendingMerge = { data, heldItem, recordStanding };
  await launchFromLibrary(heldItem, "a copy already here, with an arriving move to merge");
}

/**
 * Applies a merge remembered for after the frame is up (see the handshake).
 *
 * The frame is mounted but its database may not be open for the first instant,
 * so this retries until the merge is taken or a bound passes, rather than
 * racing the application's own open. It never falls back to the chooser on a
 * failure: the document is already on screen, and ejecting it to say a move
 * did not arrive would be worse than the silence.
 */
async function applyPendingMerge(): Promise<void> {
  const job = pendingMerge;
  if (!job) return;
  pendingMerge = null;

  const deadline = Date.now() + 15_000;
  for (;;) {
    // Ended by the person: nothing more is asked of the frame.
    if (mergeCancelled) return;
    const report = await mergeSiblingInto(job.data);
    // Permanent, on purpose: a merge folded in after a cold launch has no other
    // trace, and "it did not land" looked exactly like "nothing to merge".
    console.info(
      report.refused
        ? `dai: pending merge refused: ${report.refused}`
        : `dai: pending merge applied (${report.applied} rows, ${report.duplicate} already here)`,
    );
    if (report.refused !== "NO_DOCUMENT_OPEN") {
      // Mounted, so #report is off screen and the application redraws from the
      // dai:merged event. Not an error say: that would call arrived(false) and
      // eject the document the person just opened.
      if (!report.refused && job.recordStanding) {
        /*
         * Re-read, never rebuilt from the snapshot this job was made with.
         *
         * `job.heldItem` was captured before the document was opened and before
         * the merge ran. Writing it back here would undo anything filed in
         * between — the game's key from the invite that caused this very merge
         * (D37) among it. Only the flag this write owns is changed.
         */
        const held = await getCartridgeFromLibrary(job.heldItem.documentUuid).catch(() => null);
        // Named before it is spread: `library-record.spec` reads the shape of
        // every write here, and a spread of a parenthesised expression is not a
        // shape it can see. The rule it enforces is the one this write depends
        // on, so it is met literally rather than argued with.
        const record = held ?? job.heldItem;
        await saveCartridgeToLibrary({ ...record, mergeStanding: true }).catch(() => undefined);
      }
      await finishMerge(!report.refused);
      return;
    }
    if (Date.now() > deadline) {
      await finishMerge(false);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (mergeCancelled) return;
  }
}

/** Whether a merge is being rehearsed behind the launch screen, and whether it has ended. */
let rehearsingMerge = false;
let mergeFinished = true;
/*
 * A merge the person ended before it landed.
 *
 * Tapping the cover's control says the copy as it stands is what they want to
 * see, and the sentence under it says the move was not added. The retry loop
 * kept going, so the move could land a moment later under a sentence saying it
 * had not (second cold review of c1490cb). Cancelled, it stops asking, and
 * the move is not applied here. What keeps it is whatever carried it — the
 * file, or the link it arrived by — which is still where it was; this path
 * has no mailbox behind it, and nothing here is holding the move for later.
 */
let mergeCancelled = false;

/** What a person is told when a move that arrived was not added to their copy. */
const MOVE_NOT_APPLIED = "The move that arrived couldn't be added to your copy, so your copy is as it was.";

/**
 * The end of a merge folded in after a cold launch.
 *
 * On iOS away from the document's address, the merge was rehearsed
 * (`launchFromLibrary`): the copy mounted behind the launch screen, nothing
 * usable. Applied, the move is saved and only then is the page loaded at the
 * address, where the merged copy is drawn — the reload never runs ahead of the
 * save, and nobody is using a page that is about to be replaced. Not applied —
 * refused, or given up at the deadline — the page does not reload: the copy is
 * shown here as it was, and one sentence says the move did not land.
 */
async function finishMerge(applied: boolean): Promise<void> {
  // Once. The person's tap ends the wait, and a merge that answers afterwards
  // must not then reload the page under the copy they are looking at.
  if (mergeFinished) return;
  mergeFinished = true;
  onLaunchTap = undefined;
  rehearsingMerge = false;
  clearLaunchGuard();
  const open = loaded;
  if (rehearsing && applied && open) {
    await flushDocument();
    if (await relaunchAtOwnAddress(await identityOf(open), entryPoint)) return;
  }
  if (rehearsing) {
    rehearsing = false;
    window.clearTimeout(bootingGuard);
    document.body.classList.remove("booting");
    if (!applied) reloadGate = "not taken: the arriving move was not applied";
  }
  if (!applied) tellOverDocument(MOVE_NOT_APPLIED);
  void showArrival();
}

/** One sentence over an open document, where the chooser's report cannot be seen. */
function tellOverDocument(sentence: string): void {
  const note = document.getElementById("doc-note");
  if (!note) return;
  note.textContent = sentence;
  note.hidden = false;
}

async function mergeSiblingInto(databaseBytes: Uint8Array, level = 1): Promise<MergeReport> {
  const target = cartridgeFrame.contentWindow;
  const refused = (why: string): MergeReport => ({
    applied: 0,
    duplicate: 0,
    rejected: [],
    newReplicas: 0,
    refusedBatches: [],
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
      // Closed, not cancelled: the frame carries on, and its answer is
      // discarded when it arrives rather than resolving something else.
      closedMerges.add(id);
      window.removeEventListener("message", onResult);
      resolve(refused("MERGE_TIMED_OUT"));
    }, 30_000);
    const onResult = (event: MessageEvent): void => {
      const data = event.data as
        | ({ type?: string; id?: string; sessionNonce?: string } & MergeReport)
        | null;
      if (!data || data.type !== TO_HOST.MERGE_RESULT) return;
      if (!fromMountedContainer(event, data)) return;
      // The answer to *this* request. One the host gave up on may still land,
      // and it belongs to nobody.
      if (data.id !== id || closedMerges.has(id)) return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onResult);
      const { applied, duplicate, rejected, newReplicas, conflicts, refused: why } = data;
      const refusedBatches = Array.isArray(data.refusedBatches) ? data.refusedBatches : [];
      resolve({ applied, duplicate, rejected, newReplicas, refusedBatches, conflicts, ...(why ? { refused: why } : {}) });
    };
    window.addEventListener("message", onResult);
    target.postMessage(
      { type: TO_DOCUMENT.MERGE, id, payload: { databaseBytes, mergeSource: source, level } },
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
  await flushBeforeLeaving();
  const opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
  await mayLeave(opfsDb);
  const current = opfsDb ? await resealCartridge(loaded, opfsDb) : loaded;
  if (opfsDb) await noteSentOut(current, opfsDb);
  return current.supplied.length > 0 ? refatten(current) : current.html;
}

/**
 * A copy leaving with its data is a match (D36): whoever answers it starts from
 * exactly this. Recorded as the copy that left, by its own stamp, so a reply
 * made from it reads as further along, and a change made here after it left
 * reads as this copy moving on.
 */
async function noteSentOut(sent: Cartridge, database: Uint8Array): Promise<void> {
  const digest = await databaseDigest(database);
  await amendLibraryRecord(sent.manifest.documentUuid, (held) => ({
    ...held,
    matchedAt: savedAtOf(sent),
    matchedDigest: digest,
    history: remember(held.history, digest),
  }));
}

/**
 * An invite into one session: this document with its database filtered to that
 * session's rows — the other sessions gone, local tables emptied — around the
 * same application and the same signature (T1-D28). Nothing is re-signed: the
 * database is outside the signed set, and a fresh signature would stop the
 * recipient's copy recognizing this as the same document.
 */
async function inviteHtml(session: string): Promise<string> {
  if (!loaded) throw new Error("nothing open");
  await flushBeforeLeaving();
  const opfsDb = await loadDatabaseFromOpfs(loaded.manifest.documentUuid);
  if (!opfsDb) throw new Error("This game has not been saved on this device yet, so there is nothing to invite anyone into.");
  await mayLeave(opfsDb);
  // Made by the one invite function every host shares (exportSession), then
  // re-verified before it leaves, as any resealed document is.
  const invite = await reverify(await inviteFor(loaded, opfsDb, session));
  return invite.supplied.length > 0 ? refatten(invite) : invite.html;
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
async function linkToSend(
  html: string,
  preview: boolean,
  /** The game being invited into, when this link is an invite into one. */
  session?: string,
): Promise<{ link: string; uploaded: boolean }> {
  const cfg = storeConfig();
  const store = cfg ? presignedStore(cfg) : undefined;
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
  /*
   * An invite into a game seals under that game's own key (backlog D37); a
   * share of the whole document seals under the document's.
   *
   * The two sides converge because both derive from the key the invite carried,
   * and a later invite into a different game carries a different key and leaves
   * this one alone. Under one key per document they did not converge: whoever
   * invited second overwrote the first key, and the games already running under
   * it moved to addresses nobody read.
   */
  const key =
    loaded && declaresReplication(loaded.manifest)
      ? session
        ? await ensureSessionKey(loaded.manifest.documentUuid, session)
        : await ensureDocumentKey(loaded.manifest.documentUuid)
      : undefined;
  if (store) {
    try {
      const { links, sealed } = await publish(html, store, location.origin + "/", { preview, icon, key }, key ? session : undefined);
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

async function sendDocument(inviteSession?: string): Promise<void> {
  if (!loaded) return;
  // An invite into one session means something only for a session document.
  const invite = inviteSession && loaded.manifest.session ? inviteSession : undefined;
  const name = loaded.manifest.appName ?? "this document";
  const sheetEl = document.getElementById("send-sheet");
  const icon = document.getElementById("send-icon") as HTMLImageElement | null;
  const titleEl = document.getElementById("send-title");
  const sub = document.getElementById("send-sub");
  const withData = document.getElementById("send-with-data") as HTMLInputElement | null;
  const note = document.getElementById("send-note");
  const backup = document.getElementById("send-backup");
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
  const viaStore = Boolean(storeConfig());
  const canShare = typeof navigator.share === "function";
  const url = faviconUrl(loaded.manifest.favicon);
  icon.hidden = !url;
  if (url) icon.src = url;
  titleEl.textContent = invite ? "Invite someone into this game" : `Share ${name}`;
  sub.textContent = viaStore
    ? "Sealed with a key that only the link holds, then put in the store, which cannot read it."
    : "The whole app travels inside the link. Nothing is uploaded.";
  /*
   * What the toggle starts on, ruled 21 September.
   *
   * A document with replicated tables is shared to be joined: the data is the
   * point, and sending it without would send an app the other person cannot
   * play with. A document with none is a single person's — a log, a list — and
   * "here is the app I use" should hand over the app, not the sender's
   * entries. The default is the common case, and the toggle is still there for
   * the other one.
   */
  withData.checked = Boolean(loaded.manifest.replication);
  // An invite always carries its one game, so there is no data choice to make.
  // Set on the style rather than `hidden`: the row is a flex label, and a
  // display rule beats the hidden attribute.
  const toggle = withData.closest("label") as HTMLElement | null;
  if (toggle) toggle.style.display = invite ? "none" : "";
  const describe = (): void => {
    note.textContent = invite
      ? "Only this game goes. Your other games, and this device's own settings, stay here."
      : loaded?.manifest.session && withData.checked
        ? "This sends the whole document, with every game in it. To invite someone into one game, use that game's own Invite."
        : withData.checked
          ? "Anyone with the link can open it, with what is in it now."
          : "Anyone with the link gets the app as it arrived, with none of your entries.";
    /*
     * What this link is to the person making it (D53).
     *
     * The key lives in this device's library row and on no server, so a store
     * holds ciphertext nobody can read again once this device forgets the
     * document. The link carries the key, which is what makes it the way back
     * — a property the person is otherwise never told, and one that can only
     * be acted on before the loss.
     *
     * Both states, because the fact is the same one and only the sentence
     * changes: a link with the data is the way back, and a link without it is
     * not — which is worth more to somebody who is about to send the app to a
     * friend and assume they have a copy of their own.
     *
     * Not for an invite. That carries one game to one person, and calling it
     * either a backup or not-a-backup would be answering a question nobody
     * inviting somebody into a game is asking.
     */
    if (backup) {
      backup.textContent = invite
        ? ""
        : withData.checked
          ? "Keep this link yourself: it is the way back if this device ever forgets this app."
          : "This link carries the app without your entries, so it is not a copy of them. What you have written lives on this device only.";
    }
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
    // Inviting someone is choosing to hear from them: the moment, inside the
    // gesture, to ask whether this device may be told when they move.
    if (loaded && declaresReplication(loaded.manifest)) askForPush();
    go.disabled = true;
    go.textContent = viaStore ? "Sealing…" : "Preparing…";
    let made: { link: string; uploaded: boolean };
    try {
      // Packaged now, not when the sheet opened: what goes is what the
      // person sees at the moment they press Share.
      const html = invite ? await inviteHtml(invite) : await currentHtml(withData.checked);
      // The name and icon go with it, as they do when a phone shares any
      // app; the person can take the card off in the share sheet itself.
      made = await linkToSend(html, true, invite);
    } catch (error) {
      close();
      const why = error instanceof Error ? error.message : "The store could not be reached.";
      /*
       * A replicated app is played together, and a file has no key — it cannot
       * join the mailbox, so it is not the invite that was asked for. Handed
       * over silently, it gives the other person a copy that can never sync.
       * So for a replicated document the link failing is said and stopped;
       * "Save a copy…" in the menu is still there for a deliberate file. A
       * document with nothing to sync keeps the old behaviour: the file is an
       * equal carrier of a snapshot, and going ahead with it is no loss.
       */
      if (loaded && declaresReplication(loaded.manifest)) {
        say(
          `${why} The invite link could not be made — try again in a moment. ` +
            `To send this app as a file instead, use "Save a copy…".`,
          true,
        );
        return;
      }
      say(
        `${why} Sharing the file instead — the other person will need to open it at ${OPENER}.`,
        true,
      );
      await exportContainer();
      return;
    }
    close();
    // Sharing is the moment a solo document becomes a shared one: the key was
    // just minted, so the mailbox that had nothing to run on can now start. A
    // no-op unless the document is replicated and a relay is configured.
    void startMailboxIfPossible();
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
  markStep("reading the document from the link");
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

/*
 * A store pointed somewhere else, for a test that stands one up locally.
 *
 * The same move as `useRelay`: the production store is a bucket this repo does
 * not run, so an end-to-end test serves its own — presign, PUT and GET — and
 * points the opener at it through `window.__daiStore`, injected before the page
 * loads. Setting the base is scenery; the key still crosses in the link, which
 * is the fact the key-path e2e exists to prove. Deliberately a different origin
 * than the opener, so the opener's own service worker (scoped to this origin)
 * does not intercept the presign the way it would a same-origin `/api/presign`
 * — the interception that made the mocked store read as a 404 on WebKit, and the
 * reason the test serves a real store rather than routing to a fake one.
 */
function storeConfig(): { presignUrl: string; publicBase: string } | undefined {
  const injected = (window as unknown as { __daiStore?: { presignUrl?: string; publicBase?: string } })
    .__daiStore;
  if (injected?.presignUrl && injected.publicBase) {
    return { presignUrl: injected.presignUrl, publicBase: injected.publicBase };
  }
  return STORE_BASE
    ? { presignUrl: new URL("/api/presign", location.origin).href, publicBase: STORE_BASE }
    : undefined;
}

/*
 * The mailbox relay (Track 5), where a document's moves are carried between two
 * copies with no file passed by hand. Stamped into the page at build from
 * DAI_RELAY_BASE, the way the build id is (see the `dai-relay` meta in
 * index.html), so the address is a fact the page carries rather than a bundle
 * patched after the fact. Empty until the relay is deployed and the value set
 * on the deploy; a test injects one through `__runner.useRelay`. When it is
 * unset no session starts and a document behaves exactly as it does today —
 * carried by file and by link, never by mailbox.
 */
let relayBase: string | undefined =
  document.querySelector('meta[name="dai-relay"]')?.getAttribute("content")?.trim() || undefined;

/** The document key this open carried in its link, if any — the mailbox seals under it. */
let arrivedKey: string | undefined;

/**
 * The game that key opens, when the link named one (backlog D37).
 *
 * A key with a game named beside it is filed against that game and changes
 * nothing else this device holds. Without it — every link made before per-game
 * keys — the key is the document's, and behaves as it always did.
 */
let arrivedSession: string | undefined;

/** The running mailbox loop for the mounted document, or none. */
let mailboxSession: MailboxSession | null = null;

/**
 * The mounted runtime said, in its handshake, that it scopes a batch to one
 * session (T1-D30). Decided from what the runtime is, never from how quickly it
 * answers a question: see startMailboxSession's `sessionLanes`.
 */
let frameSessionLanes = false;

/** base64url of 32 random bytes, for a fresh document key. */
function mintKeyBase64Url(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The document's root key: the one the store seal and the mailbox both run on.
 *
 * The key from the link this copy opened wins and is written into the library
 * entry, so a later launch that carries no fragment (a home-screen icon) still
 * has it. Otherwise it is whatever this copy has kept. Null for a copy that has
 * never been shared and never opened a link — which has no partner yet, so no
 * mailbox, which is correct and not a failure.
 */
async function documentRootKey(documentUuid: string): Promise<string | null> {
  const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  /*
   * A key that named a game is that game's, and never the document's (D37).
   *
   * This is the line that stranded a game. An arriving key used to replace the
   * document key whatever it was for, so opening somebody's invite re-keyed
   * every game this copy already had: their mailboxes moved to addresses
   * derived from the new key, their partners kept reading the old ones, and
   * nothing anywhere said a word. A named key is filed against its own game by
   * `rememberSessionKey` and changes nothing else.
   */
  if (arrivedKey && !arrivedSession) {
    if (held && held.documentKey !== arrivedKey) {
      // Under the lock, from a fresh read: see `withLibraryLock` (D41).
      await amendLibraryRecord(documentUuid, (record) => ({ ...record, documentKey: arrivedKey }));
    }
    return arrivedKey;
  }
  return held?.documentKey ?? null;
}

/**
 * The document's root key, minting one if it has none — for the moment of
 * sharing, which is where a solo document becomes a shared one.
 *
 * Minted at the invite, not before: until then there is no second party, so no
 * key needs to exist and none is put in a link. From here every share of this
 * document carries the same key, so the two sides converge on one mailbox.
 */
async function ensureDocumentKey(documentUuid: string): Promise<string> {
  const existing = await documentRootKey(documentUuid);
  if (existing) return existing;
  const key = mintKeyBase64Url();
  // Under the lock, from a fresh read: a write built from a read taken outside
  // it can rewind `revision` and refuse every later save (D41).
  await amendLibraryRecord(documentUuid, (record) => ({ ...record, documentKey: key }));
  return key;
}

/** Every key this device holds for a game of a document (session hex → base64url). */
async function sessionKeysFor(documentUuid: string): Promise<Record<string, string>> {
  const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  return held?.sessionKeys ?? {};
}

/**
 * The key for one shared game, minting one the first time it is invited into.
 *
 * The key belongs to the game, not to the document (backlog D37). A document
 * key meant both at once, so two people who each invited before opening the
 * other's invite held different keys, derived different mailbox addresses, and
 * published moves the other never read — with nothing on either screen saying
 * so. Minted at the invite, kept here, carried by that invite, and never
 * replaced by a key arriving for a different game.
 */
async function ensureSessionKey(documentUuid: string, session: string): Promise<string> {
  /*
   * The document still gets a key, even though this invite does not use it.
   *
   * `startMailboxIfPossible` asks for the document's key and gives up when
   * there is none — "updates arrive when you invite someone" — so routing
   * invites through per-game keys alone left a copy that had invited somebody
   * with no mailbox session at all: no lanes, no polling, nothing published,
   * and both copies holding matching game keys they never used. That was this
   * fix breaking the layer above the one it was fixing.
   *
   * Minted first, and the record re-read afterwards, because these are two
   * writes to one record and the second built from a stale read would undo the
   * first — the same trap as the keep-step and standing-consent writes.
   */
  await ensureDocumentKey(documentUuid);
  const held = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  const existing = held?.sessionKeys?.[session];
  if (existing) return existing;
  const key = mintKeyBase64Url();
  await amendLibraryRecord(documentUuid, (record) => ({
    ...record,
    sessionKeys: { ...(record.sessionKeys ?? {}), [session]: key },
  }));
  /*
   * The lanes are rebuilt, because this key did not exist when they were.
   *
   * A mailbox session builds a lane per game when the document mounts, and a
   * game's key is minted later — at the invite. Without this the inviter keeps
   * publishing that game to the address derived from the document key while the
   * copy they invited reads the one derived from the key it was sent: the same
   * two-addresses failure as D37, reintroduced by the order the fix runs in.
   * Restarting re-derives every lane; a re-keyed lane republishes from the
   * start, which a merge already ignores where it has the rows.
   */
  await startMailboxIfPossible();
  return key;
}

/**
 * Files a key that arrived in a link against the game it opens.
 *
 * The document gets a key here too, for the same reason the inviting side does:
 * `startMailboxIfPossible` asks for the document's key and gives up when there
 * is none. A copy that only ever *receives* invites never mints one, so it held
 * the right key for the game and ran no mailbox at all — no lanes, no polling,
 * nothing published or pulled. Measured: the inviting copy reported two lanes
 * and a running session, the receiving copy reported none.
 *
 * The record is re-read between the two writes, because they are two writes to
 * one record and the second built from a stale read would undo the first.
 */
async function rememberSessionKey(documentUuid: string, session: string, key: string): Promise<void> {
  const existing = await getCartridgeFromLibrary(documentUuid).catch(() => null);
  if (!existing) return;
  if (!existing.documentKey) await ensureDocumentKey(documentUuid);
  // Under the lock, from a fresh read (D41). This is the write that was
  // measured rewinding `revision` on a copy that had just saved: the receiving
  // copy filed the key at lane construction and every save after it was
  // refused, 37 in a row, with no recovery but a reopen.
  await amendLibraryRecord(documentUuid, (record) =>
    record.sessionKeys?.[session] === key
      ? record
      : { ...record, sessionKeys: { ...(record.sessionKeys ?? {}), [session]: key } },
  );
}

/**
 * Starts the mailbox loop for the mounted document, when there is one to start.
 *
 * A mailbox needs three things: the document declares replicated tables, a
 * relay is configured, and this device holds the document's key — from the
 * link it opened, or kept from a link it opened or shared before. A document
 * that only ever arrived as a file, and was never shared, has no key and so no
 * mailbox; that is the open tier, not a failure, and the app says as much.
 */
async function startMailboxIfPossible(): Promise<void> {
  mailboxSession?.stop();
  mailboxSession = null;
  if (!loaded || !mountedNonce || !relayBase) return;
  if (!declaresReplication(loaded.manifest)) return;
  const frameWindow = cartridgeFrame.contentWindow;
  if (!frameWindow) return;

  const uuid = loaded.manifest.documentUuid;
  // The person has this document open: a notification about it has done its job.
  void clearNotices(uuid);
  // An invite that named its game hands this copy that game's key. Filed first,
  // so the lane below derives from it on this very open rather than the next.
  if (arrivedKey && arrivedSession) await rememberSessionKey(uuid, arrivedSession, arrivedKey);
  const key = await documentRootKey(uuid);
  if (!key) {
    // Replicated, but no key yet: this copy came by file and has not been
    // shared. Sharing a link (or opening one) is what gives it a mailbox, and
    // the person is told rather than left wondering.
    say("Updates from the other copy arrive when you invite someone, or open a shared link.");
    return;
  }
  if (mountedNonce !== null) {
    const relay = relayBase;
    mailboxSession = startMailboxSession({
      documentUuid: uuid,
      keyBase64Url: key,
      mailbox: httpMailbox({ base: relay, fetch: window.fetch.bind(window), sender: pushSender }),
      frame: frameWindow,
      sessionNonce: mountedNonce,
      // A session document's rows travel in one mailbox per session (T1-D30),
      // when its runtime can scope a batch to one — said in its handshake.
      sessions: Boolean(loaded.manifest.session),
      sessionLanes: frameSessionLanes,
      // Each game's own key, for the lanes that have one (D37).
      sessionKeys: await sessionKeysFor(uuid),
      // And each mailbox wakes this device when it moves, if it may (slice
      // two), until its game closes.
      relay,
      onLane: (address) => wantPush(address, relay),
      onLaneClosed: (address) => void releasePush(address, relay),
      // Before a batch leaves: the floor counts its seqs first (identity step 2
      // review, #1), so a save lost after this publish cannot reissue them.
      beforePublish: (head) => raiseSeqFloor(uuid, head),
      // This person's own move reached the relay: whatever the icon said is
      // answered (D34). After the confirmation, never before it, so a move
      // that never left clears nothing. Applies whether or not the app reports
      // its waiting games; for one that does not, this is the only clear.
      onPublished: () => {
        if (mountedUuid === uuid) void badge()?.opened(uuid).catch(() => undefined);
      },
      // A pulled move is stored on this device before the cursor passes it.
      persist: flushDocument,
      onNote: (message) => say(message),
    });
  }
}

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
  markStep("fetching the document from the store");
  const href = reference.url ?? (storeConfig() ? `${storeConfig()!.publicBase}${reference.hash}` : undefined);
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
  // The document's key, kept for the mailbox — the same key that just decrypted
  // it. A home-screen launch will not carry it again, so the session records it.
  arrivedKey = reference.key;
  // Which game it opens, when the link said. Filed against that game once the
  // document is in the library, so it never displaces a key for another game.
  arrivedSession = reference.session;
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
 * And while a document is open, too — but never by throwing its state away.
 * This used to return when anything was loaded, so a link followed in a tab
 * that already showed a document changed the address and nothing else: the old
 * document stayed on screen, under a link for a different one, and nothing
 * said so. That is the same silence as a second invite showing the old game.
 * So the open document's pending writes are flushed first, and then the page
 * reloads at the new address, which takes the link through the one open path
 * every link takes — the card, a merge, or a refusal in words.
 */
window.addEventListener("hashchange", () => {
  // The page moving itself to a document's address, not a link arriving.
  if (ownWrite()) return;
  const carried = inlineFrom(location.hash);
  if (!carried) return;
  if (!loaded) {
    void openFromLink(carried);
    return;
  }
  console.info("dai: a link arrived while a document was open; saving it and opening the link");
  void flushDocument().finally(() => location.reload());
});

async function start(): Promise<void> {
  markStep("reading the address");
  /*
   * Loaded already on a document's address — the head script painted the
   * launch splash before any of this ran. If the mount that should follow
   * never arrives, the guard turns the splash into Tap to open pointed at this
   * same address, which is the healthy open path reached by a gesture. Armed
   * before the async work below so a hang anywhere in it is still caught.
   */
  if (document.body.classList.contains("launching")) guardLaunch(location.href);

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
   * the browser, find it in a Files app and pick it out of a chooser — a flow
   * long enough to be abandoned before it finishes. The bytes come across by
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
      ...corrected.hash.replace(/^#/, "").split("&").filter((part) => part.length > 0 && !part.startsWith(`${HINT_KEY}=`)),
      `${HINT_KEY}=${wanted}`,
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
      await launchFromLibrary(held, "an icon, or an address naming a copy already here");
      return;
    }
    // Painted as launching into it by the worker, and it is not here: the
    // chooser, or a card for what the link carries, is the honest screen.
    document.body.classList.remove("launching");
    // An icon whose document is gone, with a link to fetch it again: the card
    // for it says so, on a device where that can be known (D50).
    if (installSharesBrowserStorage()) returningTo = wanted;
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
    // An icon launch names the document in the query; a notification does not.
    say(documentNotHere(parameters.get("name"), parameters.has("doc") || parameters.has("name")));
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

  await launchFromLibrary(item, "the document open last time, resumed");
}

void start();
// Off the first-paint path, alongside the engine: the table a name is compared
// with is wanted at the first card, not at the first frame.
void confusables();

/**
 * The mounted copy's replica id, in the shown author-id form, or null when it has none yet.
 *
 * Asks the frame, which reads it from `_dai_replica`. For tests that need to
 * assert identity directly — that an arrived copy took its own id at mount and
 * kept it across a reopen (D22), and that an own copy's id does not change —
 * rather than inferring it from whether a later exchange collided.
 */
/**
 * Whether this device may write the mounted replicated document: decided once
 * per mount from the person key and the sequence floor, and waited on by every
 * save of that document. Null before a replicated document mounts.
 */
let mountWrites: {
  /** The mount this was decided for: a decision never outlives the frame it was made for. */
  nonce: string | null;
  documentUuid: string;
  decided: Promise<{ me: Person; seqFloor: number } | { refused: string }>;
} | null = null;

function requestReplicaId(): Promise<string | null> {
  return new Promise((resolve) => {
    const target = cartridgeFrame.contentWindow;
    if (!target) {
      resolve(null);
      return;
    }
    const nonce = `rid-${crypto.randomUUID()}`;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onReply);
      resolve(null);
    }, 5_000);
    const onReply = (event: MessageEvent): void => {
      const data = event.data as { type?: string; nonce?: string; replica?: Uint8Array | null };
      if (data?.type === TO_HOST.REPLICA_ID_ANSWER && data.nonce === nonce) {
        window.clearTimeout(timer);
        window.removeEventListener("message", onReply);
        resolve(data.replica instanceof Uint8Array ? showAuthorId(data.replica) : null);
      }
    };
    window.addEventListener("message", onReply);
    target.postMessage({ type: TO_DOCUMENT.REPLICA_ID, nonce }, "*");
  });
}

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
    /** Saves asked. A save asked is not a save kept: wait on savesWritten for that. */
    get saves() {
      return hostSaves;
    },
    /** Saves written to this device's storage. */
    get savesWritten() {
      return hostSavesWritten;
    },
    eject,
    exportContainer,
    deleteApp,
    refreshLibrary,
    listLibrary: listCartridgesFromLibrary,
    // A document's stored database, read the way a reopen reads it: from OPFS,
    // falling back to IndexedDB exactly as a save does. A test that reads OPFS
    // itself assumes the save went there, and on WebKit 2359 OPFS is exposed but
    // every operation throws, so the save lands in IndexedDB instead (D28).
    loadStored: loadDatabaseFromOpfs,
    // The card is a pure renderer over what it is handed. Exposed so a test
    // can draw it with a weaker profile than this host has, which is the only
    // way to check that a sentence disappears when its clause does.
    showCard,
    // A move folded into this device's copy on a cold launch, as a link or a
    // card would ask for it: the merge path's own test drives this.
    openThenMerge: async (uuid: string, bytes: number[]): Promise<void> => {
      const held = (await listCartridgesFromLibrary()).find((item) => item.documentUuid === uuid);
      if (!held) throw new Error("not held here");
      await openThenMerge(held, new Uint8Array(bytes), false);
    },
    // The launch fail-safe arms inside iOS-only launch paths a desktop test
    // cannot enter (the service worker injects the launching class; the
    // relaunch is platform-gated). Exposed so the reveal, and the gesture it
    // offers, can be checked where the stall itself cannot be produced.
    guardLaunch,
    // Track 5: a test points the mailbox at a relay it stands up locally, since
    // the production relay is a Durable Object this repo does not run, and
    // supplies the key a file-opened test document has no link to carry.
    // Setting these after a document is open restarts the session against them.
    useRelay: (base: string, keyBase64Url?: string): void => {
      relayBase = base;
      if (keyBase64Url) arrivedKey = keyBase64Url;
      void startMailboxIfPossible();
    },
    // Pull now, as the foreground poll would.
    pullMailbox: (): void => mailboxSession?.pull(),
    /*
     * Ask the version relay now, as the next open would (`docs/version-ping.md`).
     *
     * The same seam as `useRelay` beside it, and for the same reason: the check
     * happens on a mount, against an address a deploy stamps into the page, and
     * a test stands its relay up after the page has loaded. Without this a test
     * could only reach the check by reloading — which throws away the address
     * it just injected.
     *
     * It does not shorten the day between checks; it makes the one that would
     * happen on the next open happen now. Whether a day has passed is
     * `checkIsDue`, which is its own test.
     */
    checkForNewVersion: async (): Promise<void> => {
      if (loaded) await offerNewVersion(loaded);
    },
    // How many timer polls have run, so a test that must show nothing is
    // polled can wait for polls to happen instead of for time to pass.
    get mailboxPolls(): number | undefined {
      return mailboxSession?.polls;
    },
    // Track 5, slice two: the relay's public push key, which a deploy stamps
    // into the page and a test supplies for the relay it stands up.
    usePush: (publicKey: string): void => {
      setPushKey(publicKey);
      void startMailboxIfPossible();
    },
    // The mounted copy's replica id, for a test that asserts D22 as a fact
    // about identity rather than the absence of a collision.
    replicaId: requestReplicaId,
    // This device's author id, asked of the host and never of the frame, so a
    // test can hold the frame's id against it (docs/identity.md). Asking is a
    // use: it makes the key if there is none.
    authorId,
  },
});

/*
 * Foreground is when a waiting copy catches up (Track 5, slice one).
 *
 * Push is slice two; until then the poll on becoming visible is how a move that
 * arrived while the app was backgrounded appears. It is also the cheapest
 * possible trigger — no timer, no socket — and the one a person's own gesture
 * already provides by bringing the app forward.
 */
/*
 * Bring the other copy's moves in whenever the person comes back to the page.
 *
 * The mailbox session polls on a timer, but iOS suspends a page's timers while
 * it is idle, so a move can sit unseen until something wakes the page. Coming
 * back to it is exactly that wake: switching to the tab (`visibilitychange`),
 * focusing the window (`focus`), or a back-forward restore (`pageshow`). Each
 * pulls once and resets the poll to fast. Fully hands-off delivery to an idle
 * phone — a move arriving with no interaction at all — is what push (slice two)
 * is for; a timer cannot promise it on iOS.
 */
const wakeMailbox = (): void => mailboxSession?.pull();
/*
 * Coming back to a document is opening it, for the badge (D34). On a phone the
 * icon usually resumes the page iOS kept, and a resumed page does not mount the
 * document again, so the clear on mount alone left the badge standing until a
 * reload. Found on a phone, after the suite was green.
 */
const backToDocument = (): void => {
  if (mountedUuid && document.visibilityState === "visible") void badge()?.opened(mountedUuid).catch(() => undefined);
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    wakeMailbox();
    backToDocument();
  }
});
window.addEventListener("focus", wakeMailbox);
window.addEventListener("pageshow", () => {
  wakeMailbox();
  backToDocument();
});

/**
 * Registers the service worker that makes the runner itself work offline.
 */
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((error: unknown) => {
      console.warn("DAI Runner: offline support unavailable.", error);
    });
    // Push registrations nothing on this device accounts for any more — a
    // document removed before its release ran, a game closed while offline —
    // are released here, once per start (see push.ts).
    void listMailboxes().then((records) => (records ? sweepPush(records, relayBase) : undefined));
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
    // A push woke a mailbox while this page was showing: read it now rather
    // than at the next poll (see sw.js).
    if ((event.data as { type?: string } | null)?.type === WORKER.MAILBOX_MOVED) {
      wakeMailbox();
      return;
    }
    // The push worker asking whether this page is showing a document, so it
    // can tell a move the person is looking at from one they are not.
    if ((event.data as { type?: string } | null)?.type === WORKER.WHICH_DOCUMENT) {
      event.ports[0]?.postMessage({ uuid: loaded?.manifest.documentUuid ?? null });
      return;
    }
    if ((event.data as { type?: string } | null)?.type !== WORKER.SHELL_UPDATED) return;
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

/**
 * Whether this device's documents are kept, beside the build stamp (D49).
 *
 * The same argument the stamp is in both places for: the person who most needs
 * to read this is the one whose documents are gone, and that person is looking
 * at the chooser, which has no menu. It is a reading, not a control — the
 * browser grants persistence or it does not, and a button that asked again
 * would be a control that usually does nothing.
 *
 * Asked again whenever it may have changed, never remembered: once at load, and
 * again when the boot request settles, whatever its answer. It used to be read
 * once, at load, in parallel with the request, and never again — so on a device
 * that granted the request the line said "not kept" for the rest of the visit.
 * The first launch after installing is exactly when this is read before a
 * multi-day phone test, so a stale line meant the test measured something other
 * than what the screen said (review of 454858c..7abb896, item 1).
 *
 * The newest reading wins. Each call takes a number, and a reading that comes
 * back after a newer one was asked for is dropped: a slow first `persisted()`
 * must not land after the post-grant one and put "not kept" back.
 *
 * Failure is silence, as with the stamp: a browser that will not answer leaves
 * the line empty rather than printing a "no" it never got. The two cases are
 * different facts, and conflating them is the mistake this whole cluster is about.
 */
let persistenceAsked = 0;
function showPersistence(): void {
  const mine = ++persistenceAsked;
  void readPersistence().then((reading) => {
    if (mine !== persistenceAsked) return;
    const text = !reading
      ? ""
      : reading.kept
        ? `kept on this device · ${reading.context}`
        : `not kept · ${reading.context}`;
    for (const id of ["sheet-storage", "chooser-storage"]) {
      const slot = document.getElementById(id);
      if (slot) slot.textContent = text;
    }
  });
}

showPersistence();
void showArrival();

/**
 * On the menu opening — never on load — the stamp becomes a one-tap update when a
 * newer build is live.
 *
 * The check must not touch the network at load: a held document opens with zero
 * network, and a fetch there broke the test that holds that (see showVersion's
 * note). So this runs only when the person opens the menu, and on any failure —
 * offline, no version.json — it leaves the stamp exactly as it was. version.json
 * is served fresh (the worker excludes it), so it names the *deployed* build; the
 * meta names the *running* one, cached by the worker and possibly a deploy behind.
 * Different commits mean the running shell is stale, which is the whole failure
 * this repository has been bitten by — a phone two deploys back with no way to
 * know. The remedy is offered, not forced: one tap clears the caches, drops the
 * old worker, and reloads onto the deployed bytes.
 */
async function checkForUpdate(): Promise<void> {
  const slot = document.getElementById("sheet-version");
  const stamp = document.querySelector('meta[name="dai-build"]')?.getAttribute("content");
  if (!slot || !stamp || stamp === "dev") return;
  const running = stamp.split("·")[0]!.trim();
  if (!running) return;
  let live: unknown;
  try {
    const response = await fetch(`/version.json?at=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return;
    live = (await response.json())?.commit;
  } catch {
    return; // offline, or no version.json: the stamp stays, and nothing is said.
  }
  if (typeof live !== "string" || live.slice(0, running.length) === running) return;

  slot.textContent = "New version — update";
  slot.classList.add("update-available");
  slot.setAttribute("role", "button");
  slot.setAttribute("tabindex", "0");
  const apply = (): void => void applyUpdate();
  slot.onclick = apply;
  slot.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      apply();
    }
  };
}

/** Clear the shell caches and the worker, then reload onto the deployed build. */
async function applyUpdate(): Promise<void> {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    /* A browser that will not clear its caches still gets a reload below. */
  }
  try {
    // The shell's worker only. The per-mailbox push workers (/push/<address>/)
    // hold this device's subscriptions; unregistering them switched push off
    // for every document but the next one opened. They cache nothing, so an
    // update has nothing of theirs to clear.
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(
      registrations
        .filter((registration) => !new URL(registration.scope).pathname.startsWith("/push/"))
        .map((registration) => registration.unregister()),
    );
  } catch {
    /* Same: unregister is best-effort; the reload is the load-bearing step. */
  }
  location.reload();
}
