/**
 * What link a document gets, decided once.
 *
 * The loop this project is built around ends with somebody sending a document
 * to somebody else, and until now every door produced a file and left the
 * sending to the person: "here is tasks.dai.html", with no way to hand it over
 * that did not involve an attachment. The link is the carrier that works on a
 * phone, so a door that produces a file and no link has not finished the job.
 *
 * Two carriers, in order (spec §1.1). The inline link carries the whole
 * document in the fragment and depends on nothing; it is the answer whenever
 * the document fits. Above the cap the reference link names a document in a
 * store, which needs a store to have been configured — so a door with no store
 * says plainly that the document is too big to link rather than emitting one
 * that will be cut in transit.
 *
 * The decision lives here rather than in each door because three doors making
 * it separately would drift, and the day they disagree is the day one of them
 * hands somebody a link that does not open.
 */
import { parseContainer } from "./container.js";
import { INLINE_CAP, inlineLink } from "./link.js";
import { packInline, type Host } from "./inline.js";
import { publish, type Store } from "./store.js";

export type { Host } from "./inline.js";

/** Where links point when a door does not say. */
export const DEFAULT_OPENER = "https://opendai.app";

export interface SenderOptions {
  /** The opener a link opens in. */
  opener?: string;
  /** The shell this sender can rebuild, so the compact carrier may elide it. */
  host: Host;
  /**
   * A store, when one is configured. Without it a document too large for the
   * fragment gets no link, which is the honest answer rather than a truncated
   * one.
   */
  store?: Store;
}

export type Handoff =
  | { kind: "inline"; link: string; bytes: number }
  | { kind: "reference"; link: string; anyHost: string; bytes: number; href: string }
  | { kind: "none"; why: string };

/**
 * The most direct link this document can have.
 *
 * Inline first, always: it needs no host, no network and nothing that can
 * expire, so a document that fits in the fragment should never be put in a
 * store. Only what does not fit goes to one.
 */
export async function linkFor(html: string, options: SenderOptions): Promise<Handoff> {
  const opener = options.opener ?? DEFAULT_OPENER;

  const inline = await inlineLink(html, opener, options.host);
  if (inline) return { kind: "inline", link: inline, bytes: inline.length };

  if (!options.store) {
    const packed = await packedSize(html, options.host);
    return {
      kind: "none",
      why:
        `This document is ${Math.round(packed / 1024)} kB packed into a link, and a link carries ` +
        `at most ${Math.round(INLINE_CAP / 1024)} kB. Configure a store to get a link for it, ` +
        `or send the file itself.`,
    };
  }

  const { href, links } = await publish(html, options.store, opener);
  return { kind: "reference", link: links.known, anyHost: links.anyHost, bytes: links.known.length, href };
}

/** How big the compact carrier makes this document, for a message about the cap. */
async function packedSize(html: string, host: Host): Promise<number> {
  try {
    return (await packInline(parseContainer(html), host)).length;
  } catch {
    return 0;
  }
}

/**
 * The sentence a door ends with.
 *
 * Written here so the command line, the MCP server and anything else that
 * hands a document over end the same way — with the link, last, because the
 * last line is what a person copies.
 */
export function lastLine(handoff: Handoff): string {
  switch (handoff.kind) {
    case "inline":
      return `Send this link — it carries the whole document, and needs no server:\n${handoff.link}`;
    case "reference":
      return (
        `Send this link. The document is in the store, sealed so the store cannot read it; ` +
        `the key is in the part after # and is never sent anywhere:\n${handoff.link}`
      );
    case "none":
      return handoff.why;
  }
}
