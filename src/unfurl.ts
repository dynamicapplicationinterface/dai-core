/**
 * What a chat client sees before anybody opens the link. Backlog 3.3.
 *
 * A reference link is `<opener>/d/<id>#h=…&k=…`, and the opener answers at that
 * path. A host that can run code at the edge fills the placeholder in that same
 * document with the document's name and icon, read from the store's sidecar.
 * Everything here is an enhancement: a host that cannot serves the page
 * untouched, and the link opens exactly as well.
 *
 * Three things this must never do, and the reason each is possible at all:
 *
 * - **Serve the blob.** It only reads the sidecar, which is the small object
 *   beside it. The ciphertext is never fetched and never appears in a response.
 * - **See the key.** The key is in the fragment, and a fragment is not sent to
 *   a server. There is nothing here to leak because nothing here arrives.
 * - **Show a name nobody offered.** A preview exists only when the sender put
 *   one in the sidecar. Absent means the generic tags stand, and so does an
 *   `id` the store has never held or no longer holds.
 *
 * The name in a preview is a claim the sender made, exactly as `appName` is a
 * claim the document makes. A preview is not a trust signal and must not be
 * written as one — that is the card's job, after verification, on the device.
 */

/** What a sender consented to show. Absent from a sidecar means no preview. */
export interface Preview {
  name: string;
  /** The app's own one line about itself, from its <meta name="description">. */
  description?: string;
  /** The name the publisher signs under, when the document carries one. */
  publisherName?: string;
  /** Set when an icon was stored beside the blob. The URL is derived, not carried. */
  icon?: boolean;
}

const PLACEHOLDER = "<!--DAI_PREVIEW-->";

/** The most a preview will say about an app in its own words. */
const DESCRIPTION_CAP = 200;

/**
 * The app's one line about itself, as the card on the device reads it: the
 * first <meta name="description"> in the head of its index.html, whitespace
 * folded, and only when it is a line rather than a paragraph.
 */
export function descriptionOf(indexHtml: string): string | undefined {
  const head = indexHtml.slice(0, 20_000);
  const found =
    /<meta\s+(?:[^>]*?\s)?name=["']description["'][^>]*?content=["']([^"']{1,300})["']/i.exec(head) ??
    /<meta\s+(?:[^>]*?\s)?content=["']([^"']{1,300})["'][^>]*?name=["']description["']/i.exec(head);
  const line = found?.[1]?.replace(/\s+/g, " ").trim();
  return line && line.length > 0 && line.length <= DESCRIPTION_CAP ? line : undefined;
}

/** HTML attribute text. A name is somebody's text and must not become markup. */
function attribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface UnfurlResult {
  html: string;
  /**
   * What to send with it. A content-addressed id names bytes that never
   * change, so a preview for one may be cached for ever; the absence of a
   * preview is a fact about right now, and is not cached at all.
   */
  cacheControl: string;
}

/**
 * Fills the placeholder, or leaves the document exactly as it was.
 *
 * `iconUrl` is where the store serves the sidecar's PNG. It is passed rather
 * than derived so this function needs to know nothing about the store.
 */
export function injectPreview(
  html: string,
  preview: Preview | undefined,
  iconUrl?: string,
  options: { expired?: boolean } = {},
): UnfurlResult {
  if (!preview?.name) {
    // Never an error page. A link to something the store no longer holds still
    // opens the opener, which says what happened in words a person can act on.
    const html2 = options.expired
      ? html.replace(
          PLACEHOLDER,
          `<meta property="og:title" content="A DAI app — this link has expired">`,
        )
      : html;
    return { html: html2, cacheControl: "no-store" };
  }

  const name = attribute(preview.name);
  // The app's own line, and whose it is: the card is the app's, made with DAI.
  const description = preview.description ? `${attribute(preview.description)} · Made with DAI` : "Made with DAI";
  const tags = [
    `<title>${name}</title>`,
    `<meta property="og:title" content="${name}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:type" content="website">`,
    `<meta name="twitter:card" content="summary">`,
  ];
  if (preview.icon && iconUrl) {
    tags.push(`<meta property="og:image" content="${attribute(iconUrl)}">`);
    tags.push(`<link rel="apple-touch-icon" href="${attribute(iconUrl)}">`);
  }

  return {
    // The generic tags that follow the placeholder stay in the document. A
    // reader takes the first of a repeated og:title, which is this one.
    html: html.replace(PLACEHOLDER, tags.join("\n    ")),
    cacheControl: "public, max-age=31536000, immutable",
  };
}

/** Whether a path is a reference link, and which document it names. */
export function documentIdFrom(pathname: string): string | undefined {
  return /^\/d\/([0-9a-f]{64})\/?$/i.exec(pathname)?.[1]?.toLowerCase();
}

/**
 * Whether a path names a preview for a document that travels inside the
 * link, and which one.
 *
 * `/p/<id>#a=…` is an inline link with a card: the document is in the
 * fragment, as ever, and the store holds only what a chat may show about
 * it - name, line, icon - under an id that names nothing else. The id says
 * nothing about the document: it is random, not a digest.
 */
export function previewIdFrom(pathname: string): string | undefined {
  return /^\/p\/([0-9a-f]{64})\/?$/i.exec(pathname)?.[1]?.toLowerCase();
}
