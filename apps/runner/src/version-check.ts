/**
 * Asking whether the author has published a newer version (`docs/version-ping.md`).
 *
 * A copy says which build it holds; the relay answers whether there is a
 * successor under the key this device already pinned for the document. Three
 * facts go out — the document id in the route, the build, and the publisher key
 * — and nothing else.
 *
 * Everything here is allowed to come to nothing. An unreachable relay, an
 * answer that does not parse, a successor under another key: each ends with no
 * card and no sentence, because a check that finds nothing is not news. A copy
 * that never reaches a relay again keeps working exactly as it does now, which
 * is the property the whole format exists for, and an update mechanism that
 * quietly weakened it would be the wrong mechanism.
 */

/** How long a copy waits before asking again: once a day, per document. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** What the author published, once this copy has decided to believe it. */
export interface Successor {
  /** The build digest the author says is current. */
  version: string;
  /** The author's own name for it, shown on the card and never compared. */
  label: string;
  /** The author's sentence about what changed. Shown as theirs. */
  note: string;
  /** Where to fetch it, key and all. */
  address: string;
}

/** Whether enough time has passed for this document to ask again. */
export function checkIsDue(lastCheckedAt: string | undefined, now: number): boolean {
  if (!lastCheckedAt) return true;
  const last = Date.parse(lastCheckedAt);
  return !Number.isFinite(last) || now - last >= CHECK_EVERY_MS;
}

/**
 * Ask the relay, and say what to do about the answer.
 *
 * `trustedKey` is the publisher key this device pinned for the document, as
 * base64 SPKI. An answer announced under any other key is dropped here: the
 * successor would be refused at the door anyway (succession adopts only under
 * the pinned key), and fetching it first would be asking a stranger for bytes
 * on a stranger's say-so.
 */
export async function askForSuccessor(options: {
  relayBase: string;
  documentUuid: string;
  version: string;
  trustedKey?: string;
  fetcher?: typeof fetch;
}): Promise<Successor | null> {
  const { relayBase, documentUuid, version, trustedKey } = options;
  if (!relayBase || !version) return null;
  const call = options.fetcher ?? fetch;

  let answer: Record<string, unknown>;
  try {
    const response = await call(`${relayBase.replace(/\/$/, "")}/v/${encodeURIComponent(documentUuid)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The three facts, and the route carries the first.
      body: JSON.stringify({ version, publisher: trustedKey ?? "" }),
    });
    if (!response.ok) return null;
    answer = (await response.json()) as Record<string, unknown>;
  } catch {
    // Offline, blocked, or nobody home. Not news, and never said.
    return null;
  }

  const address = typeof answer.successor === "string" ? answer.successor : "";
  const current = typeof answer.current === "string" ? answer.current : "";
  if (!address || !current || current === version) return null;

  /*
   * Under the key this device already trusts, or not at all.
   *
   * The relay is a noticeboard: it cannot forge an announcement, and it can
   * serve one from anybody who holds some key. Which key matters is this
   * copy's question, and the answer is the one it pinned when it first opened
   * the document.
   */
  const announcedKey = typeof answer.publicKey === "string" ? answer.publicKey : "";
  if (!trustedKey || !announcedKey || announcedKey !== trustedKey) return null;

  return {
    version: current,
    label: typeof answer.label === "string" && answer.label ? answer.label : "A new version",
    note: typeof answer.note === "string" ? answer.note : "",
    address,
  };
}
