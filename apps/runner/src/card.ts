/**
 * The launch card: what somebody is about to open, before it opens.
 *
 * A document arrives from somebody else — a link, a share, a message. The
 * moment before it runs is the only moment a person has to decide anything
 * about it, and until now that moment was either nothing at all or a button
 * naming a hostname. This is the screen instead: what the thing is called,
 * what it looks like, who signed it, and what it will not be able to do.
 *
 * ## No claim without a passing probe
 *
 * The ticks are not decoration and they are not this host's opinion of itself.
 * Each one names the §4 clauses that make it true, and is shown only when this
 * host applies all of them — the same list it declares to every container it
 * mounts, which the isolation probe checks in CI. Take a clause away and the
 * sentence it backed disappears from the card. That is the whole rule: a host
 * may say less than it does, and never more.
 *
 * The card therefore says nothing about the document's own behaviour, which
 * nobody can know before running it. It says what this host will not let any
 * document do, which is knowable and checked.
 */
import { claimsFor } from "../../../src/host-profile.js";
import { faviconUrl } from "./install.js";

export interface CardInput {
  name: string;
  /** The manifest's icon: a data URL or inline SVG. */
  favicon?: string;
  signature: "valid" | "unsigned";
  fingerprint?: string;
  /** What this device remembers: a first sighting, or the key it pinned. */
  trust: "first" | "known";
  /** Where it came from, in a person's words. Shown under the button. */
  from?: string;
  /** The §4 clauses this host applies. */
  applied: readonly string[];
}

/**
 * Shows the card and resolves when somebody asks for the document to open.
 *
 * Never resolves on its own. A document that is not asked for does not run,
 * which is the point of the screen.
 */
export function showCard(input: CardInput): Promise<void> {
  const card = document.getElementById("card");
  const icon = document.getElementById("card-icon") as HTMLImageElement | null;
  const name = document.getElementById("card-name");
  const publisher = document.getElementById("card-publisher");
  const claims = document.getElementById("card-claims");
  const open = document.getElementById("card-open");
  const from = document.getElementById("card-from");

  if (!card || !icon || !name || !publisher || !claims || !open || !from) {
    // No card in this document. Opening without one is the old behaviour and
    // is better than refusing to open at all.
    return Promise.resolve();
  }

  name.textContent = input.name;

  const url = faviconUrl(input.favicon);
  if (url) {
    icon.src = url;
    icon.hidden = false;
  } else {
    icon.removeAttribute("src");
    icon.hidden = true;
  }

  /*
   * Who signed it, said plainly, and what this device remembers.
   *
   * A fingerprint is not a name and this does not pretend otherwise: it says
   * whether the same key signed the copy opened last time, which is the one
   * thing a device can actually establish on its own.
   */
  const short = (input.fingerprint ?? "").slice(0, 8);
  publisher.textContent =
    input.signature !== "valid"
      ? "Not signed — anyone could have made this."
      : input.trust === "known"
        ? `Signed by ${short} — the same publisher as last time.`
        : `Signed by ${short} — the first time you have opened this.`;
  publisher.dataset.state = input.signature !== "valid" ? "unsigned" : input.trust;

  claims.replaceChildren();
  for (const claim of claimsFor(input.applied)) {
    const item = document.createElement("li");
    item.dataset.claim = claim.id;
    item.textContent = claim.says;
    claims.appendChild(item);
  }

  from.textContent = input.from ?? "";
  from.hidden = !input.from;

  card.hidden = false;
  document.body.classList.add("deciding");
  open.focus();

  return new Promise<void>((asked) => {
    const go = (): void => {
      open.removeEventListener("click", go);
      card.hidden = true;
      document.body.classList.remove("deciding");
      asked();
    };
    open.addEventListener("click", go);
  });
}

/** Takes the card off screen without opening anything. */
export function hideCard(): void {
  const card = document.getElementById("card");
  if (card) card.hidden = true;
  document.body.classList.remove("deciding");
}
