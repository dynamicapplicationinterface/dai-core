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
    sheet.hidden = true;
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
    sheet.hidden = true;
  };
  slide.onfinish = done;
  slide.oncancel = done;
}
