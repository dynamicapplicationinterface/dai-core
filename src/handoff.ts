/**
 * Getting a finished container from a page onto the device it is being read on.
 *
 * An anchor with a `download` attribute pointing at a blob URL is the ordinary
 * way to hand somebody a file, and on iOS it does nothing at all: no save, no
 * error, no navigation. The button appears to work and the visitor is left with
 * nothing — which is worse than no button, because they have no reason to look
 * for another way. That failure took this project's whole mobile path with it:
 * no file on the phone means nothing to open in the runner.
 *
 * The share sheet is the route that works there, and the one people on that
 * device already know, because it ends in "Save to Files".
 *
 * Framework-free on purpose. The decision is small, it is the part worth
 * testing, and every host that hands a user a file needs it — the runner, the
 * site, and anything anybody else builds.
 */

/** The parts of `navigator` this needs. Narrow so a caller can pass a stub. */
export interface ShareCapableNavigator {
  share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  canShare?: (data: { files?: File[] }) => boolean;
}

/**
 * Whether this device can be handed this file directly.
 *
 * Asked with the file in hand rather than sniffed from the user agent, because
 * `canShare` answers the question actually being asked — can this device accept
 * this file — while a user-agent string answers a different one and goes stale.
 *
 * A browser with a share sheet but no file support answers false, which is the
 * honest answer: offering that button would trade one dead end for another.
 */
export function canHandOff(navigator: ShareCapableNavigator | undefined, file: File | null): boolean {
  if (!file || !navigator?.share) return false;
  return navigator.canShare ? navigator.canShare({ files: [file] }) : false;
}

export interface HandOffResult {
  /** True only when the file reached the device. */
  shared: boolean;
  /** Set when something went wrong. Absent when the person simply declined. */
  error?: string;
}

/**
 * Hands the file to the device's share sheet.
 *
 * A cancelled share is a choice, not a failure, and the sheet raises the same
 * exception either way. Reporting it would tell somebody their file failed to
 * save at the moment they decided not to save it.
 */
export async function handOff(
  navigator: ShareCapableNavigator | undefined,
  file: File,
  title: string,
): Promise<HandOffResult> {
  if (!navigator?.share) {
    return { shared: false, error: "This device cannot be handed a file directly." };
  }

  try {
    await navigator.share({ files: [file], title });
    return { shared: true };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return { shared: false };
    return {
      shared: false,
      error: "This device would not accept the file. Use the download link below instead.",
    };
  }
}
