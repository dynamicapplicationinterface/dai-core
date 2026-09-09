/**
 * The open screen: what somebody is about to open, before it opens.
 *
 * A document arrives from somebody else — a link, a share, a message. The
 * moment before it runs is the only moment a person has to decide anything
 * about it, and until now that moment was either nothing at all or a button
 * naming a hostname. This is the screen instead.
 *
 * ## The app first, the format last
 *
 * It used to be a card: a panel floating on a dimmed page, the app's name
 * small at the top, and four sentences about isolation filling the middle.
 * Testers read it as one store page imitating another, and two of them said
 * scam. The priority was wrong, not the facts. So the app's own account of
 * itself — its name, its line, three things it says it does — takes the
 * screen, who made it and when are a row of plain facts, and everything true
 * of every DAI document rather than of this one sits behind a single line at
 * the bottom.
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
  /** One line about the app, from its own <meta name="description">. */
  tagline?: string;
  /**
   * Up to three things the app says it does, from its own
   * `<meta name="dai:does">` lines.
   *
   * The app's own words, shown as text and never as markup, and the reason
   * this screen has something to say that is about *this* document. Absent on
   * anything built before the recipe asked for them, and then the tagline
   * carries the whole job on its own.
   */
  does?: readonly string[];
  /** The file's size in bytes, for Details. */
  size?: number;
  /** The database's size in bytes: what data comes with it. Zero means it starts empty. */
  dataBytes?: number;
  /** The publisher's own account of when it was made (ISO). A claim, labelled as one. */
  createdAt?: string;
  /** The signing key's fingerprint, for Details. */
  fingerprint?: string;
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
  /**
   * Another copy of a document this device already holds (§7).
   *
   * `offer` puts *Merge into my copy* beside *Get*; anything else replaces it
   * with a sentence saying why not, and *Get* stays as *Open as a separate
   * copy* — a refusal to merge is never a refusal to open.
   */
  sibling?: { offer: true } | { offer: false; why: string };
  /** Chosen instead of opening. Resolves when the merge has been attempted. */
  onMerge?: () => void | Promise<void>;
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
  /** Offered when the document is signed by a key worth naming: the host's own naming UI. */
  onNamePublisher?: () => void;
}

/** " with github.com", from an issuer URL, or nothing. */
/**
 * What the app says about itself, from its own index.html: the one line a
 * store page puts under the name. Read from the signed application, never
 * from anything outside the file; shown as text, never as markup.
 */
export function describeApp(
  indexHtml: string | undefined,
): { tagline?: string; theme?: string; does?: string[] } {
  if (!indexHtml) return {};
  const head = indexHtml.slice(0, 20_000);
  const meta = (name: string): string | undefined =>
    (new RegExp(`<meta\\s+(?:[^>]*?\\s)?name=["']${name}["'][^>]*?content=["']([^"']{1,200})["']`, "i").exec(head)
      ?? new RegExp(`<meta\\s+(?:[^>]*?\\s)?content=["']([^"']{1,200})["'][^>]*?name=["']${name}["']`, "i").exec(head))?.[1]
      ?.replace(/\s+/g, " ")
      .trim();
  const tagline = meta("description");
  /*
   * Three at most, and short.
   *
   * A fourth line would push what the app costs and who made it off the first
   * screen, which is the trade this whole screen was rebuilt to stop making.
   * Anything longer than a phone line is the app writing a paragraph where it
   * was asked for a bullet, and is dropped rather than wrapped to four lines.
   */
  const does = [
    ...head.matchAll(
      /<meta\s+(?:[^>]*?\s)?name=["']dai:does["'][^>]*?content=["']([^"']{1,120})["']/gi,
    ),
    ...head.matchAll(
      /<meta\s+(?:[^>]*?\s)?content=["']([^"']{1,120})["'][^>]*?name=["']dai:does["']/gi,
    ),
  ]
    .map((found) => found[1]?.replace(/\s+/g, " ").trim() ?? "")
    .filter((line) => line.length > 0)
    .slice(0, 3);
  // A colour and nothing else: it goes into a style property on this page.
  const colour = meta("theme-color");
  const theme = colour && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%/]+\)|hsla?\([\d\s.,%/]+\)|[a-z]{3,20})$/i.test(colour) ? colour : undefined;
  return { ...(tagline ? { tagline } : {}), ...(theme ? { theme } : {}), ...(does.length ? { does } : {}) };
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
      return "Not signed";
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
  const sibling = document.getElementById("card-sibling");
  const merge = document.getElementById("card-merge") as HTMLButtonElement | null;
  const identity = document.getElementById("card-identity");
  const clear = document.getElementById("card-clear");
  const alert = document.getElementById("card-alert");

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
  /*
   * What the app says it does, in its own words.
   *
   * Text, never markup — the same rule the tagline follows, and for the same
   * reason: this is a string out of a file somebody else wrote.
   */
  const doesBlock = document.getElementById("card-does-block");
  const does = document.getElementById("card-does");
  if (doesBlock && does) {
    const lines = (input.does ?? []).slice(0, 3);
    does.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement("li");
        item.textContent = line;
        return item;
      }),
    );
    doesBlock.hidden = lines.length === 0;
  }

  /*
   * Who made it, when, and what comes with it — the questions somebody asks
   * about a thing a person sent them, answered in the words they asked in.
   *
   * "Works — offline, on this phone" is a claim like any other on this
   * screen, so it appears only when this host actually applies the clause
   * that makes it true. A host that does not say less; it never says more.
   */
  const meta = document.getElementById("card-meta");
  if (meta) {
    const claimIds = claimsFor(input.applied).map((claim) => claim.id);
    const rows: { term: string; value: string; state?: string }[] = [
      { term: "Made by", value: publisherFact(input.publisher), state: input.publisher.state },
    ];
    if (input.createdAt) {
      const when = new Date(input.createdAt);
      if (!Number.isNaN(when.getTime())) {
        rows.push({
          term: "Made on",
          value: when.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        });
      }
    }
    rows.push({
      term: "Comes with",
      value: input.dataBytes && input.dataBytes > 0 ? `${formatSize(input.dataBytes)} of data` : "No data yet",
    });
    if (claimIds.includes("offline")) {
      // The device somebody is holding, named. A coarse pointer is a finger,
      // which is the only part of this worth asking the browser about; the
      // rest of the sentence is true either way.
      const handheld = window.matchMedia?.("(pointer: coarse)").matches === true;
      rows.push({ term: "Works", value: `Offline, on this ${handheld ? "phone" : "computer"}` });
    }
    meta.replaceChildren(
      ...rows.map(({ term, value, state }) => {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        if (state) dd.dataset.state = state;
        row.append(dt, dd);
        return row;
      }),
    );
  }

  // The technical facts, labelled for what they are, under the one line at
  // the bottom that carries everything about the format.
  const about = document.getElementById("card-about");
  const list = document.getElementById("card-details-list");
  if (about) about.removeAttribute("open");
  if (list) {
    const rows: [string, string][] = [];
    if (input.fingerprint) rows.push(["Key", input.fingerprint]);
    if (input.createdAt) {
      const when = new Date(input.createdAt);
      if (!Number.isNaN(when.getTime())) {
        rows.push(["Made", when.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) + " (as stated by the publisher)"]);
      }
    }
    if (input.size !== undefined) rows.push(["Size", formatSize(input.size)]);
    if (input.dataBytes !== undefined) rows.push(["Data", input.dataBytes > 0 ? formatSize(input.dataBytes) : "none yet"]);
    list.replaceChildren(
      ...rows.flatMap(([term, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
      }),
    );
    list.hidden = rows.length === 0;
  }

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

  /*
   * Out front, or behind the line at the bottom.
   *
   * "Made by — Not signed" in the facts row is the whole truth for a document
   * nobody claimed anything about, and the sentence explaining it is one tap
   * away. A test key and a name in conflict are different: both are
   * signatures that look like a claim and are not one, and somebody who never
   * opens the disclosure still has to be told.
   */
  if (alert) {
    const shout = who.state === "conflict" || who.state === "test-key";
    alert.hidden = !shout;
    alert.dataset.state = who.state;
    alert.textContent = shout ? publisher.textContent : "";
  }

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
   * Another copy of this document, and what can be done about it (§7).
   *
   * Offered, never done. A host may put the choice on screen and must not make
   * it: the copy already here has the person's own work in it, and merging is
   * an answer to a question they have to be asked.
   *
   * When it cannot be offered, the reason is a sentence and the document still
   * opens. A refusal to merge is not a refusal to open, and a card that said a
   * merge was unavailable and stopped would have told somebody their document
   * was broken when nothing is wrong with it.
   */
  const kin = input.sibling;
  if (sibling) {
    sibling.hidden = !kin || kin.offer;
    sibling.textContent = kin && !kin.offer ? kin.why : "";
  }
  if (merge) {
    merge.hidden = !kin?.offer;
    merge.onclick = kin?.offer && input.onMerge ? () => void input.onMerge?.() : null;
  }
  /*
   * The other copy still opens, and says so.
   *
   * "Get" is the word for a document this device does not have. When it does
   * have one, opening this is a second copy beside the first, and calling that
   * "Get" would hide the only thing about it worth knowing.
   */
  if (kin) open.textContent = "Open as a separate copy";

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
  card.scrollTop = 0;
  /*
   * Focus lands at the top of the screen, not on the button.
   *
   * Focusing the button drew a ring around it on arrival — a script's focus()
   * is keyboard focus as far as both engines are concerned — and it put a
   * screen reader on the word "Get" before it had said what the app was.
   * From here, a reader reads the name, the line and the three things it does
   * in order, and one Tab reaches the button.
   */
  (card.querySelector(".card-panel") as HTMLElement | null)?.focus({ preventScroll: true });

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
