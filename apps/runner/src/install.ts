/**
 * Telling somebody, once, that the thing they are looking at is keepable.
 *
 * Somebody who has just watched their document run is in a browser tab. They
 * have no idea it can be anything else, and no browser will tell them. On a
 * phone the gesture that keeps it — Share, then Add to Home Screen — is buried
 * two menus deep and completely unguessable; the difference between a thing
 * somebody tried once and a thing somebody has is whether anyone said that
 * sentence to them at the right moment.
 *
 * The right moment is after a document is open and running. Before that there
 * is nothing to keep, and an install prompt on an empty chooser is asking
 * somebody to bookmark a file picker.
 *
 * ## Why this is honest
 *
 * A home screen icon launches this app cold, with no file attached. It is only
 * worth suggesting because the opener reopens whatever was last open and
 * re-verifies it on the way in — so the icon lands somebody back in their
 * document, with their data, exactly where they left it. If that ever stops
 * being true this prompt has to go with it, or it becomes an invitation to a
 * blank screen.
 *
 * ## The two platforms
 *
 * Android and desktop Chrome fire `beforeinstallprompt`, which can be saved and
 * replayed from a button: one tap, done. iOS has no such event and never will,
 * so all that is left is describing the gesture — which is why the text names
 * Share and Add to Home Screen literally rather than saying "install".
 */

/** What Chrome hands over, and which is not in the DOM typings. */
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const ASKED_KEY = "dai:install-asked";

/** Already an app, by either platform's way of saying so. */
function alreadyInstalled(): boolean {
  if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  return (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  // iPadOS reports itself as a Mac, and the touch points are what give it away.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const ipad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return ios || ipad;
}

function asked(): boolean {
  try {
    return localStorage.getItem(ASKED_KEY) === "yes";
  } catch {
    // Storage refused. Better to say it again than to lose the only chance
    // somebody has of learning this exists.
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(ASKED_KEY, "yes");
  } catch {
    /* Nothing to do; the prompt is not important enough to fail over. */
  }
}

/**
 * Wires the prompt up. Call once at start-up; it shows nothing until a document
 * is open and `offerInstall` is called.
 */
export function watchForInstall(): (() => void) | null {
  const bar = document.getElementById("install");
  const text = document.getElementById("install-text");
  const go = document.getElementById("install-go") as HTMLButtonElement | null;
  const dismiss = document.getElementById("install-dismiss");
  if (!bar || !text || !go || !dismiss) return null;

  if (alreadyInstalled() || asked()) return null;

  let saved: InstallEvent | null = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Kept rather than allowed to fire on its own, so it arrives after somebody
    // has seen their document work rather than on top of it loading.
    event.preventDefault();
    saved = event as InstallEvent;
  });

  const hide = () => {
    bar.hidden = true;
    remember();
  };

  dismiss.addEventListener("click", hide);

  go.addEventListener("click", () => {
    const prompt = saved;
    hide();
    if (!prompt) return;
    void prompt.prompt();
  });

  return () => {
    if (alreadyInstalled() || asked()) return;

    if (saved) {
      text.textContent = "Keep this on your home screen and open it like an app.";
      go.hidden = false;
    } else if (isIos()) {
      // No event exists on this platform, so the gesture has to be spelled out.
      text.textContent = "To keep this: tap Share, then Add to Home Screen.";
      go.hidden = true;
    } else {
      // A desktop browser with no install support has nothing useful to offer.
      return;
    }

    bar.hidden = false;
  };
}
