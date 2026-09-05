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
import type { PublisherState } from "../../../src/publisher.js";
import { faviconUrl } from "./install.js";

export interface CardInput {
  name: string;
  /** The manifest's icon: a data URL or inline SVG. */
  favicon?: string;
  /**
   * Who signed it, as far as this device has seen. Never a bare fingerprint
   * and never the word "verified": a name in one of the states
   * `src/publisher.ts` defines, and what to do about it.
   */
  publisher: PublisherState;
  /** Where it came from, in a person's words. Shown under the button. */
  from?: string;
  /**
   * What this document says about the one it replaces, and what this host is
   * doing about it (4.1). Absent when it replaces nothing this host has.
   */
  succession?: { state: "adopting" | "refused" | "nothing-here"; previous: string; why?: string };
  /** The §4 clauses this host applies. */
  applied: readonly string[];
}

/** "3 of their apps", said the way a person would. */
function ofTheirApps(count: number): string {
  return count === 1 ? "you've opened 1 of their apps before" : `you've opened ${count} of their apps`;
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
  const verify = document.getElementById("card-verify") as HTMLButtonElement | null;
  const safety = document.getElementById("card-safety");
  const succession = document.getElementById("card-succession");

  if (!card || !icon || !name || !publisher || !claims || !open || !from || !verify || !safety || !succession) {
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
   * Who signed it, in the states this device can actually distinguish.
   *
   * Known is the only one that looks good, because it is the only one that
   * says anything: this key has signed things opened here before, under this
   * name. New is neutral and offers a way to check — a number two people can
   * read to each other, which is what a device cannot do for them. Conflict is
   * red: a key this device has never seen is using a name it has.
   */
  const who = input.publisher;
  verify.hidden = true;
  safety.hidden = true;
  safety.textContent = "";
  switch (who.state) {
    case "unsigned":
      publisher.textContent = "Not signed — anyone could have made this.";
      break;
    case "anonymous":
      publisher.textContent = "Signed, under no name — the first time you've seen this key.";
      verify.hidden = false;
      safety.textContent = `Safety number ${who.safetyNumber}. Ask whoever sent this to read you theirs. If it matches, it is the same key.`;
      break;
    case "known":
      publisher.textContent = who.renamedFrom
        ? `${who.name} (renamed from ${who.renamedFrom}) · ${ofTheirApps(who.count)}`
        : `${who.name} · ${ofTheirApps(who.count)}`;
      break;
    case "new":
      publisher.textContent = `${who.name} · first time you've seen this publisher`;
      verify.hidden = false;
      safety.textContent = `Safety number ${who.safetyNumber}. Ask ${who.name} to read you theirs over a call or another channel. If it matches, it is the same key.`;
      break;
    case "conflict":
      publisher.textContent = `Claims to be ${who.claimed}, but the ${who.knownAs} you know uses a different key. Treat as a stranger.`;
      break;
  }
  publisher.dataset.state = who.state;
  const reveal = (): void => {
    safety.hidden = false;
    verify.hidden = true;
  };
  verify.addEventListener("click", reveal, { once: true });

  claims.replaceChildren();
  for (const claim of claimsFor(input.applied)) {
    const item = document.createElement("li");
    item.dataset.claim = claim.id;
    item.textContent = claim.says;
    claims.appendChild(item);
  }

  from.textContent = input.from ?? "";
  from.hidden = !input.from;

  /*
   * The next version of something you already have.
   *
   * Said before the person opens it, because what happens to their data is
   * the one thing about a successor they would want to know first. Adopting
   * is a copy: the previous document keeps everything it had.
   */
  const next = input.succession;
  succession.hidden = !next;
  succession.dataset.state = next?.state ?? "";
  succession.textContent = !next
    ? ""
    : next.state === "adopting"
      ? `Replaces ${next.previous}. What you saved there comes along; the old one is kept as it was.`
      : next.state === "refused"
        ? `Claims to replace ${next.previous}, but ${next.why ?? "this device cannot confirm that"}. Your data stays where it is.`
        : `Replaces ${next.previous}, which this device does not have. It starts empty.`;

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
