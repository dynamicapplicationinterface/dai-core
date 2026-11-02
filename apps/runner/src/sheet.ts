/**
 * Sheets that move the way a phone's do.
 *
 * Three sheets — the document's menu, keeping it, sharing it — used to appear
 * and vanish: `hidden` on, `hidden` off. A panel that rises from the bottom
 * edge and does not go back down the same way reads as broken, because every
 * other sheet on the phone does. This slides the panel up on open and down on
 * close, and sets `hidden` only once it is off screen, so nothing that waits
 * for `hidden` sees a panel that is still visible. Respects reduced motion.
 */

const DURATION_MS = 220;

function panelOf(sheet: HTMLElement): HTMLElement | null {
  return sheet.querySelector<HTMLElement>(".sheet-panel, .keep-panel");
}

function reduced(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/*
 * A sheet's rows are settled before it is shown, and an open sheet gains,
 * loses and reorders none: a row that moves between the moment a finger (or a
 * test) finds it and the tap lands the tap on its neighbor. A change to a
 * sheet's rows asked while it is open, or sliding shut, waits until it is
 * hidden; for each kind of change only the latest is kept.
 */
const waiting = new WeakMap<HTMLElement, Map<string, () => void>>();

/** Changes `sheet`'s rows now if it is hidden, or once it is. `kind` names the change, so a later one replaces an earlier. */
export function whileClosed(sheet: HTMLElement | null, kind: string, change: () => void): void {
  if (!sheet || sheet.hidden) {
    change();
    return;
  }
  let held = waiting.get(sheet);
  if (!held) waiting.set(sheet, (held = new Map()));
  held.set(kind, change);
}

/** Hides a sheet at once, with no slide, and makes the row changes that waited for it. */
export function hideSheet(sheet: HTMLElement): void {
  sheet.hidden = true;
  const held = waiting.get(sheet);
  if (!held) return;
  waiting.delete(sheet);
  for (const change of held.values()) change();
}

export function openSheet(sheet: HTMLElement): void {
  sheet.hidden = false;
  const panel = panelOf(sheet);
  if (!panel || reduced() || typeof panel.animate !== "function") return;
  panel.animate(
    [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }],
    { duration: DURATION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
  );
}

export function closeSheet(sheet: HTMLElement): void {
  if (sheet.hidden) return;
  const panel = panelOf(sheet);
  if (!panel || reduced() || typeof panel.animate !== "function") {
    hideSheet(sheet);
    return;
  }
  // Marked so a second close during the slide does nothing, and an open
  // during it is honoured by the open's own animation.
  if (sheet.dataset.closing === "1") return;
  sheet.dataset.closing = "1";
  const slide = panel.animate(
    [{ transform: "translateY(0)" }, { transform: "translateY(100%)" }],
    { duration: DURATION_MS, easing: "cubic-bezier(0.4, 0, 1, 1)" },
  );
  const done = (): void => {
    delete sheet.dataset.closing;
    hideSheet(sheet);
  };
  slide.onfinish = done;
  slide.oncancel = done;
}
