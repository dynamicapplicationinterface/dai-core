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
  if (how === "replace") location.replace(target);
  else location.assign(target);
  if (sameDocument) location.reload();
}
