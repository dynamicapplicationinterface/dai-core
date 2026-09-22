/**
 * A real load at an address, and the page's own writes told apart.
 *
 * iOS reads a home-screen icon's manifest, and the status bar's colour, as a
 * page loads and not again, so the opener moves a document to its own address
 * with a load, not a same-document navigation. When the address differs only
 * in its fragment, going there is a fragment navigation — no load — so the
 * page reloads after it.
 *
 * That fragment change fires `hashchange`, and the page listens for it: a link
 * tapped while a document is open arrives that way, and is saved and reloaded
 * into. Hearing its own write as a link arriving, the page reloaded twice —
 * the second after the first had already drawn (review of 454e2db, Q1.1). So
 * the write is marked immediately before it is made, and the listener asks
 * `ownWrite()` first. The mark lives in this page only: the load it asks for
 * starts without it.
 */

let writing = false;

/*
 * The mark is for the moment between the write and the load it asks for, and
 * for nothing else. A load that never comes -- one iOS drops, one a throw
 * stops -- used to leave it set, and a tab restored from the back/forward
 * cache came back with it still set: every real link arriving there was taken
 * for the tab's own write and ignored (cold review of 8b9273c, Q1.1). So it
 * is dropped whenever this tab is put away or shown again, and whenever the
 * navigation itself fails.
 */
const forget = (): void => {
  writing = false;
};
window.addEventListener("pagehide", forget);
window.addEventListener("pageshow", forget);

/** Whether the fragment change being heard is one this page made itself. */
export function ownWrite(): boolean {
  return writing;
}

/**
 * Loads `target`, whatever part of it differs from here.
 *
 * `replace` for a load that should not leave an entry behind (a relaunch);
 * otherwise the address is added to history, as a person's own navigation is.
 */
export function loadAt(target: string, how: "replace" | "assign"): void {
  const sameDocument = target.split("#")[0] === location.href.split("#")[0];
  writing = true;
  try {
    if (how === "replace") location.replace(target);
    else location.assign(target);
    if (sameDocument) location.reload();
  } catch (error) {
    forget();
    throw error;
  }
}
