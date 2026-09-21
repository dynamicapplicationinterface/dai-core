/**
 * Which kind of device this is, for the two decisions that depend on it.
 *
 * Kept to one file because the two places that need it — saving a copy, and
 * keeping a document as an app — had each started to guess for themselves,
 * and a desktop that answered "yes" to "can you share a file" was being sent
 * to a Windows share sheet when what it needed was a Save dialog.
 */

export type Platform = "ios" | "android" | "desktop";

export function platform(): Platform {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch points are what give it away.
  const ipad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/iPad|iPhone|iPod/.test(ua) || ipad) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** Already running as an app, by either platform's way of saying so. */
export function standalone(): boolean {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * Whether a home-screen app shares storage with the browser.
 *
 * On iOS it does not: an icon added to the home screen launches into its own
 * partition, with a library that has never seen anything. A document kept
 * that way has to be opened once from Files by the new icon. Everywhere else
 * an installed app is the same origin and the same storage, and the document
 * is already there.
 */
export function installShareStorage(): boolean {
  return platform() !== "ios";
}

/**
 * Whether this platform's installs have been read, so what they do with
 * storage is a finding rather than an inference (D59).
 *
 * A Safari "Add to Dock" app on macOS is standalone and classes as `desktop`,
 * so the answer above is "it shares the browser's storage" — from the platform
 * name, not from anything anyone has seen. The review says such an app has
 * storage of its own, like an iOS home-screen app. If that is right, its very
 * first launch looks exactly like a wipe, and a sentence built on the answer
 * above tells a person they have lost something they never had.
 *
 * Until a Mac says otherwise, an install on macOS is unread, and callers that
 * would assert a loss say the neutral thing instead. Saying less is the cost;
 * saying something false is not on the table.
 *
 * Narrow to macOS on purpose. Windows and Linux installs are the same origin
 * and the same storage, which is read and not in doubt, so calling every
 * desktop unread would take a true sentence away from them to fix a Mac.
 */
export function installStorageIsRead(): boolean {
  if (platform() !== "desktop") return true;
  // Either witness is enough. On a real Mac the two agree; they come apart only
  // where one has been set and the other has not, and a Mac claimed by either
  // is a Mac for the purpose of not asserting a loss.
  return !/Mac/.test(navigator.platform) && !/Macintosh|Mac OS X/.test(navigator.userAgent);
}
