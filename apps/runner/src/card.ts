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
import { handOffToOpener } from "../../../src/handoff-tab.js";

export interface CardInput {
  name: string;
  /** The manifest's icon: a data URL or inline SVG. */
  favicon?: string;
  /** One line about the app, from its own <meta name="description">. */
  tagline?: string;
  /** The file's size in bytes, for the facts row. */
  size?: number;
  /**
   * Who signed it, as far as this device has seen. Never a bare fingerprint
   * and never the word "verified": a name in one of the states
   * `src/publisher.ts` defines, and what to do about it.
   */
  publisher: PublisherState;
  /**
   * An identity a root this host holds vouched for (spec §9.5). Shown only
   * when it verified; absent otherwise, and absent says nothing.
   */
  identity?: { identity: string; issuer?: string; root: string };
  /** Where it came from, in a person's words. Shown under the button. */
  from?: string;
  /**
   * What this document says about the one it replaces, and what this host is
   * doing about it (4.1). Absent when it replaces nothing this host has.
   */
  succession?: { state: "adopting" | "refused" | "nothing-here"; previous: string; why?: string };
  /** The §4 clauses this host applies. */
  applied: readonly string[];
  /**
   * The document was fetched from a store that held it unencrypted.
   *
   * Said on the card because the person reading it did not make this choice
   * and has no other way to learn it was made. Every other link in this format
   * is opened by a key that never reaches a server; this one was not, which
   * means the store could read it, and so could anything that carried it.
   *
   * Not styled as damage — a self-hosted store inside a perimeter is a
   * legitimate deployment, and the document is still verified byte for byte.
   * What is gone is confidentiality, and only that is what this says.
   */
  clear?: boolean;
  /**
   * Looking inside, before running it (backlog 1.5).
   *
   * The card says what this document claims and what this host will not let
   * any document do. It cannot say what is actually in the archive, and
   * somebody who wants to know that has had no way to find out that did not
   * come down to trusting this page's summary.
   *
   * So: the same bytes, handed to the playground, which unpacks them,
   * recomputes every digest, checks the signature and shows what it found —
   * and never mounts anything. The document goes tab to tab by `postMessage`,
   * the same way a freshly built one reaches this app: no upload, no server,
   * nothing on the network.
   *
   * Absent when there is nothing to look inside of.
   */
  inspect?: { file: File; playground: string };
  /** Offered when the document is signed by a key worth naming: the host's own naming UI. */
  onNamePublisher?: () => void;
}

/** " with github.com", from an issuer URL, or nothing. */
/**
 * What the app says about itself, from its own index.html: the one line a
 * store page puts under the name. Read from the signed application, never
 * from anything outside the file; shown as text, never as markup.
 */
export function describeApp(indexHtml: string | undefined): { tagline?: string; theme?: string } {
  if (!indexHtml) return {};
  const head = indexHtml.slice(0, 20_000);
  const meta = (name: string): string | undefined =>
    (new RegExp(`<meta\\s+(?:[^>]*?\\s)?name=["']${name}["'][^>]*?content=["']([^"']{1,200})["']`, "i").exec(head)
      ?? new RegExp(`<meta\\s+(?:[^>]*?\\s)?content=["']([^"']{1,200})["'][^>]*?name=["']${name}["']`, "i").exec(head))?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const tagline = meta("description");
  // A colour and nothing else: it goes into a style property on this page.
  const colour = meta("theme-color");
  const theme = colour && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|[a-z]{3,20})$/i.test(colour) ? colour : undefined;
  return { ...(tagline ? { tagline } : {}), ...(theme ? { theme } : {}) };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The publisher, in one or two words, for the facts row. */
function publisherFact(who: PublisherState): string {
  switch (who.state) {
    case "unsigned":
      return "Unsigned";
    case "test-key":
      return "Test key";
    case "anonymous":
      return "Anonymous";
    case "known":
      return who.name;
    case "new":
      return who.name;
    case "conflict":
      return "Disputed";
  }
}

function issuerHost(issuer?: string): string {
  if (!issuer) return "";
  try {
    return ` with ${new URL(issuer).hostname}`;
  } catch {
    return ` with ${issuer}`;
  }
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
  const identity = document.getElementById("card-identity");
  const inspect = document.getElementById("card-inspect") as HTMLButtonElement | null;
  const clear = document.getElementById("card-clear");

  if (!card || !icon || !name || !publisher || !claims || !open || !from || !verify || !safety || !succession || !identity) {
    // No card in this document. Opening without one is the old behaviour and
    // is better than refusing to open at all.
    return Promise.resolve();
  }

  name.textContent = input.name;

  const tagline = document.getElementById("card-tagline");
  if (tagline) {
    tagline.textContent = input.tagline ?? "";
    tagline.hidden = !input.tagline;
  }
  const factPublisher = document.getElementById("fact-publisher");
  if (factPublisher) {
    factPublisher.textContent = publisherFact(input.publisher);
    factPublisher.dataset.state = input.publisher.state;
  }
  const factSize = document.getElementById("fact-size");
  if (factSize) factSize.textContent = input.size !== undefined ? formatSize(input.size) : "—";

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
    /*
     * Signed with a key this project publishes.
     *
     * Worse than unsigned, and said so. Unsigned is honest: nobody claimed
     * anything. This is a signature anybody could have produced, which looks
     * like a claim and is not one — so it gets the conflict styling, not the
     * neutral kind, and the sentence says what the key is rather than showing
     * a fingerprint somebody might go and compare.
     */
    case "test-key":
      publisher.textContent =
        `Signed with a test key that is published in the DAI source — ${who.which}. ` +
        `Anyone can produce this signature, so it says nothing about who made this. ` +
        `Treat it as unsigned.`;
      break;
    case "anonymous":
      publisher.textContent = "Signed, under no name — the first time you've seen this key.";
      verify.hidden = false;
      safety.textContent = `Safety number ${who.safetyNumber}. Ask whoever sent this to read you theirs. If it matches, it is the same key.`;
      break;
    case "known": {
      // The person's own label first, then what the document says it is.
      const name = who.asserted ? `${who.name} (signs as ${who.asserted})` : who.name;
      const tail = who.org
        ? who.count > 0
          ? `${who.org} · ${ofTheirApps(who.count)}`
          : `${who.org} · trusted by your organisation`
        : ofTheirApps(who.count);
      publisher.textContent = who.renamedFrom
        ? `${name} (renamed from ${who.renamedFrom}) · ${tail}`
        : `${name} · ${tail}`;
      break;
    }
    case "new":
      publisher.textContent = `${who.name} · first time you've seen this publisher`;
      verify.hidden = false;
      safety.textContent = `Safety number ${who.safetyNumber}. Ask ${who.name} to read you theirs over a call or another channel. If it matches, it is the same key.`;
      break;
    case "conflict":
      publisher.textContent =
        who.rule === "mixed-script"
          ? `Claims to be ${who.claimed}, a name spelled from two alphabets so it looks like another. Treat as a stranger.`
          : `Claims to be ${who.claimed}, but the ${who.knownAs} you know uses a different key. Treat as a stranger.`;
      break;
  }
  publisher.dataset.state = who.state;

  // Who vouched for the key, when a root this host holds says so. The words
  // are "signed in as", which is what happened; not "verified", which is a
  // claim about the world this host cannot make.
  identity.hidden = !input.identity;
  identity.textContent = input.identity
    ? `Signed in as ${input.identity.identity}${issuerHost(input.identity.issuer)} · vouched for by ${input.identity.root}`
    : "";
  const reveal = (): void => {
    safety.hidden = false;
    verify.hidden = true;
  };
  verify.addEventListener("click", reveal, { once: true });

  const namer = document.getElementById("card-name-publisher") as HTMLButtonElement | null;
  if (namer) {
    namer.hidden = !input.onNamePublisher;
    namer.onclick = input.onNamePublisher ?? null;
  }

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

  /*
   * The tab must be opened inside the click itself. A popup opened after an
   * await is blocked, and the failure looks exactly like the button doing
   * nothing — which is the failure this whole card exists to stop.
   */
  if (inspect) {
    const target = input.inspect;
    inspect.hidden = !target;
    if (target) {
      inspect.onclick = () => {
        const tab = window.open(`${target.playground}#handoff`, "_blank", "noopener=no");
        if (!tab) {
          inspect.textContent = "Allow pop-ups to look inside";
          return;
        }
        inspect.disabled = true;
        void target.file
          .arrayBuffer()
          .then((buffer) =>
            handOffToOpener(
              tab,
              { name: target.file.name, bytes: new Uint8Array(buffer) },
              { origin: new URL(target.playground).origin, window },
            ),
          )
          .catch(() => {
            inspect.textContent = "The playground did not answer";
          })
          .finally(() => {
            inspect.disabled = false;
          });
      };
    }
  }

  // Carried in the clear: a fact about how it travelled, not about the
  // document, and never the word "unsafe".
  if (clear) {
    clear.hidden = !input.clear;
    clear.textContent = input.clear
      ? "Shared without encryption. The store this came from could read it, and so could anything that carried it. What it is has still been checked."
      : "";
  }

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
