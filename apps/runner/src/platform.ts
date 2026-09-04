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
