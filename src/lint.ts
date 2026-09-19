/**
 * What breaks inside a container, and how to say so.
 *
 * Every check here is something that works perfectly on a web page and fails
 * silently under `connect-src 'none'`: a CDN script, a hosted font, an API
 * call. The failure surfaces as a blank or half-drawn app in front of whoever
 * opened the file, a long way from the line that caused it, so catching it at
 * build time is worth a great deal.
 *
 * One definition, shared by everything that can see source before it is sealed:
 * the paste page on the website, the command line, and the MCP server. Three
 * copies of this list would disagree within a month, and the disagreement would
 * be a model told its code was fine by one tool and not by another.
 *
 * Messages are written for somebody who did not write the code and may not read
 * it. `fix` is phrased as something to ask an assistant for, because that is
 * what the reader will actually do next.
 */

import { FRAME_PUBLIC } from "./frame.js";
import { rewriteReplicated } from "./replicated.js";

export interface Finding {
  /** Stable identifier, for callers that want to filter or count. */
  id: string;
  what: string;
  why: string;
  fix: string;
  /**
   * Absent for something that will not work once sealed. `warning` for
   * something that works and is worth fixing — today, only a DOM sink that
   * Trusted Types would refuse (spec §4.2), which an app with JavaScript of
   * its own is allowed to keep until it is clean.
   */
  severity?: "warning";
}

interface Check {
  id: string;
  pattern: RegExp;
  what: string;
  why: string;
  fix: string;
  severity?: "warning";
}

/** The findings that stop a build: everything that is not a warning. */
export function breaking<T extends Finding>(findings: T[]): T[] {
  return findings.filter((finding) => finding.severity !== "warning");
}

/** The findings worth fixing that do not stop a build. */
export function advisory<T extends Finding>(findings: T[]): T[] {
  return findings.filter((finding) => finding.severity === "warning");
}

const CHECKS: Check[] = [
  {
    id: "cdn-script",
    pattern: /<script[^>]+src\s*=\s*["']https?:/i,
    what: "It loads a script from the internet.",
    why: "A container has no network access, so that script never arrives and the app does nothing.",
    fix: "Inline the library instead of loading it from a CDN, or rewrite the code without it.",
  },
  {
    id: "remote-stylesheet",
    pattern: /<link[^>]+href\s*=\s*["']https?:/i,
    what: "It loads a stylesheet or font from the internet.",
    why: "That request cannot be made from inside a container, so the app opens unstyled.",
    fix: "Write the CSS inline and use system fonts instead of hosted ones.",
  },
  {
    id: "network-call",
    pattern: /\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+WebSocket|EventSource/,
    what: "It tries to talk to a server.",
    why: "Containers cannot open connections at all, so the call fails and may stop everything after it.",
    fix: "Store the data in the SQLite database through window.dai instead of calling an API.",
  },
  {
    id: "remote-image",
    pattern: /<img[^>]+src\s*=\s*["']https?:/i,
    what: "It shows an image hosted somewhere else.",
    why: "The image will not load, leaving a broken picture.",
    fix: "Use an inline SVG, a data: URI, or an emoji instead of a hosted image.",
  },
  {
    /*
     * The channels `connect-src` does not govern.
     *
     * A container declares no permitted connections and the browser enforces
     * that for requests, sockets and beacons. It does not enforce it for a
     * speculative fetch the browser makes on the page's behalf: `preconnect`
     * and `dns-prefetch` reach a name server before any policy is consulted,
     * and `prefetch` and `prerender` fetch the document itself. None of them
     * carry data on purpose, and all of them tell somebody the file was opened,
     * which is the one thing a container promises it cannot do.
     *
     * A native host can switch these off at the webview layer. A browser cannot,
     * so the compiler refuses to seal them in the first place.
     *
     * `preload` is deliberately absent. A container preloading its own font or
     * stylesheet is doing something legitimate and useful, and these rules only
     * earn their interruptions by firing on things that cannot work here. A
     * rule that also catches correct code teaches people to ignore the rules.
     */
    id: "speculative-fetch",
    pattern: /<link[^>]+rel\s*=\s*["']?(?:dns-prefetch|preconnect|prerender|prefetch)\b/i,
    what: "It asks the browser to reach a server before the page needs it.",
    why:
      "Preconnect and prefetch are not covered by the container's connection policy, so they " +
      "would leave a record that the file was opened — the one thing a container promises it " +
      "cannot do.",
    fix: "Remove the link tag. Everything a container needs is already inside it.",
  },
  {
    /*
     * A meta refresh is a navigation, and navigation is not a connection: no
     * CSP directive governs where it goes. The sandbox stops it leaving the
     * frame, so what remains is an application that reloads itself into
     * nothing — but sealing one is never intentional.
     */
    id: "meta-refresh",
    pattern: /<meta[^>]+http-equiv\s*=\s*["']?refresh\b/i,
    what: "It redirects the page on a timer.",
    why: "A container cannot navigate anywhere, so the redirect either does nothing or blanks the app.",
    fix: "Remove the meta refresh and change what is on screen with script instead.",
  },
  {
    /*
     * `window.open` carries a URL, a URL carries data, and no CSP directive
     * governs it. The sandbox withholds `allow-popups`, so this fails quietly
     * — a link the person clicks and nothing happens.
     */
    id: "new-window",
    pattern: /<a[^>]+target\s*=\s*["']?_blank\b|window\.open\s*\(/i,
    what: "It tries to open a new window or tab.",
    why: "A container is not allowed to open windows, so the link does nothing when clicked.",
    fix: "Show the content in the page, or leave the address as text the person can copy.",
  },
  {
    // Deliberately precise about which attribute names count, so that `a < b`
    // followed by an assignment somewhere in a script block cannot be mistaken
    // for markup.
    id: "inline-event-handler",
    pattern:
      /<[a-z][a-z0-9-]*[^>]*\son(?:click|dblclick|change|input|submit|reset|focus|blur|keydown|keyup|keypress|mouseover|mouseout|mouseenter|mouseleave|mousedown|mouseup|load|error|scroll|touchstart|touchend|drop|dragover)\s*=/i,
    what: "It handles events with an attribute, like onclick.",
    why:
      "A container does not allow inline script, so the attribute never runs and the " +
      "control does nothing at all when it is used — with no error to explain why.",
    fix:
      "Give the element an id and attach the handler in script instead: " +
      "document.getElementById(\"save\").addEventListener(\"click\", …).",
  },
  {
    id: "trusted-types-sink",
    severity: "warning",
    pattern: /\.(?:innerHTML|outerHTML|srcdoc)\s*=|document\.write(?:ln)?\s*\(|insertAdjacentHTML\s*\(|createContextualFragment\s*\(/,
    what: "It writes a string into the page as markup.",
    why:
      "A value stored in the database can come back through that sink and run as script or markup. " +
      "Apps built from the kit alone are sealed with Trusted Types on, which makes those sinks refuse strings; " +
      "an app with JavaScript of its own is left unprotected until it stops using them.",
    fix: "Use textContent, replaceChildren, or the kit's data-text and dai-rows, which render text and never markup.",
  },
  {
    id: "browser-storage",
    pattern: /localStorage|sessionStorage|indexedDB/i,
    what: "It saves data in browser storage.",
    why:
      "That storage belongs to the browser, not to the file, so the data does not travel with it — " +
      "send the file to somebody and it arrives empty.",
    fix: "Store the data with window.dai.openDatabase() so it lives inside the file.",
  },
];

/**
 * Top-level `await` in a classic script is a syntax error, and the app dies
 * before drawing anything.
 *
 * Checked apart from the patterns above because it needs to look inside script
 * tags rather than at the whole document, and because it is the one mistake
 * this project has already shipped to users once.
 */
function usesAwaitInClassicScript(source: string): boolean {
  const classic = /<script(?![^>]*type\s*=\s*["']module["'])[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = classic.exec(source)) !== null) {
    if (/^[^\n]*\bawait\b/m.test(match[1] ?? "")) return true;
  }
  return false;
}

/** Everything in this source that will not work once it is sealed. */
export function lintSource(source: string): Finding[] {
  if (!source.trim()) return [];

  const findings: Finding[] = CHECKS.filter((check) => check.pattern.test(source)).map(
    ({ id, what, why, fix, severity }) => ({ id, what, why, fix, ...(severity ? { severity } : {}) }),
  );

  if (usesAwaitInClassicScript(source)) {
    findings.unshift({
      id: "await-in-classic-script",
      what: "It uses await in a plain script tag.",
      why: "That is a syntax error, so the app opens completely blank.",
      fix: 'Add type="module" to the script tag.',
    });
  }

  return findings;
}

/** The same, across a set of files, keeping track of which file each came from. */
export function lintFiles(files: Record<string, string>): (Finding & { file: string })[] {
  const code = Object.entries(files).filter(([name]) => /\.(?:html?|m?js|ts)$/i.test(name));
  return [
    ...code.flatMap(([name, source]) =>
      lintSource(source).map((finding) => ({ ...finding, file: name })),
    ),
    ...lintShared(files),
  ];
}

/*
 * The shared-table checks.
 *
 * These need to know which tables are replicated, which only schema.sql says,
 * so they look across the files rather than at one. Each finding names the
 * constraint in src/rules.ts it enforces, so a person or a model reading the
 * finding can find the reason — and a constraint that says "enforced by the
 * lint" is held to it by tests/rules.spec.ts.
 *
 * Deliberately textual, like the checks above. They look for the statement as
 * written, so SQL assembled from pieces at run time is not seen; the runtime
 * still refuses those writes, and the text is what a model writes.
 */
const SHARED_CHECKS = {
  "shared-raw-write": {
    what: "It writes to a shared table with its own INSERT, UPDATE or DELETE.",
    why:
      "A replicated table is append-only and is written only through window.dai.replicated. An UPDATE or " +
      "DELETE is refused with REPLICATED_TABLE_IMMUTABLE; an INSERT fails for want of the replication " +
      "columns. A kit data-run or dai-form control runs its SQL directly, so it fails the same way, and " +
      "nothing on screen says so. See SHARED-WRITE-SURFACE and SHARED-KIT-READS.",
    fix:
      "Write the row with window.dai.replicated.insert, .change or .remove in JavaScript, and keep kit " +
      "write controls for local tables.",
  },
  "shared-base-read": {
    what: "It reads a shared table directly instead of through its _current view.",
    why:
      "The table itself holds every version of every row — superseded edits, deleted rows, and in a " +
      "session rows from non-members — so reading it shows them all at once. See SHARED-READ-CURRENT.",
    fix: "Read the table's _current view: SELECT … FROM moves_current rather than FROM moves.",
  },
  "shared-no-merge-listener": {
    what: "It has shared tables and never listens for dai:merged.",
    why:
      "Nothing else tells the application that the other copy's rows arrived, so it never redraws when " +
      "they do and looks broken in exactly the case it exists for. See SHARED-REDRAW-ON-MERGE.",
    fix: 'Add window.addEventListener("dai:merged", () => redraw()) — and call window.daiKit.refresh() in it if the page uses the kit.',
  },
  "shared-conflicts-unshown": {
    what: "It changes or removes shared rows and never shows a conflict.",
    why:
      "When the same row is edited on two copies, _current shows one version with _r_conflicted set and " +
      "the other version waits in _heads. An application that never reads either silently shows one of " +
      "two edits. See SHARED-SURFACE-CONFLICTS.",
    fix: "Read _r_conflicted from the _current view, show the competing versions from _heads, and let the person choose.",
  },
  "shared-table-constraint": {
    what: "A shared table declares UNIQUE or CHECK.",
    why:
      "A UNIQUE refuses exactly the rows a merge exists to surface as a conflict, and a CHECK that differs " +
      "between two versions of the application rejects the other copy's honest rows. See SHARED-NO-UNIQUE-CHECK.",
    fix: "Remove the UNIQUE and CHECK constraints from the -- dai:replicated table; keep them on local tables if you want them.",
  },
} as const;

type SharedCheck = keyof typeof SHARED_CHECKS;

function sharedFinding(id: SharedCheck, file: string): Finding & { file: string } {
  return { id, ...SHARED_CHECKS[id], file };
}

/**
 * Source with its comments blanked: HTML, block and line comments.
 *
 * Only for the shared checks, which read SQL out of code and would otherwise
 * find it in prose. A `//` inside a string survives (the lookbehind skips a
 * colon or a quote before it), which is the case that matters: a URL.
 */
function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** The body of `CREATE TABLE <name> ( … );` as written, or null. */
function tableBody(schema: string, name: string): string | null {
  const start = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${name}["\`]?\\s*\\(`, "i").exec(schema);
  if (!start) return null;
  let depth = 1;
  let index = start.index + start[0].length;
  const begin = index;
  while (index < schema.length && depth > 0) {
    const char = schema[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    index += 1;
  }
  return schema.slice(begin, index - 1);
}

function lintShared(files: Record<string, string>): (Finding & { file: string })[] {
  const schemaName = Object.keys(files).find((name) => name === "schema.sql" || name.endsWith("/schema.sql"));
  if (!schemaName) return [];
  const schema = files[schemaName] ?? "";
  let tables: string[];
  try {
    tables = rewriteReplicated(schema).tables;
  } catch {
    // A schema the rewrite refuses is the compiler's to report, with its reason.
    return [];
  }
  if (tables.length === 0) return [];

  const findings: (Finding & { file: string })[] = [];
  const bodyWithoutComments = (body: string): string => body.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (
    tables.some((table) => {
      const body = tableBody(schema, table);
      return body !== null && /\b(?:UNIQUE|CHECK)\b/i.test(bodyWithoutComments(body));
    })
  ) {
    findings.push(sharedFinding("shared-table-constraint", schemaName));
  }

  const code = Object.entries(files).filter(([name]) => /\.(?:html?|m?js|ts)$/i.test(name));
  const names = tables.map((table) => table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const quote = "[\"'`]?";
  const rawWrite = new RegExp(
    `\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM|REPLACE\\s+INTO)\\s+${quote}(?:${names})${quote}(?![\\w])`,
    "i",
  );
  // A read is a FROM or JOIN inside a SELECT, with no statement boundary
  // between: "derived from marks" in a comment or a sentence is not a query.
  const baseRead = new RegExp(`\\bSELECT\\b[^;]{0,800}?\\b(?:FROM|JOIN)\\s+${quote}(?:${names})${quote}(?![\\w])`, "i");

  for (const [name, raw] of code) {
    const source = withoutComments(raw);
    if (rawWrite.test(source)) findings.push(sharedFinding("shared-raw-write", name));
    if (baseRead.test(source)) findings.push(sharedFinding("shared-base-read", name));
  }

  const everything = code.map(([, source]) => source).join("\n");
  const entry = code.find(([name]) => /(?:^|\/)index\.html?$/i.test(name))?.[0] ?? code[0]?.[0] ?? schemaName;
  // The event an app listens for, spelled by its owner (D78): a rename there is a rename here.
  const quoted = ['"', "'", "`"].some((open) =>
    ['"', "'", "`"].some((close) => everything.includes(`${open}${FRAME_PUBLIC.MERGED}${close}`)),
  );
  if (!quoted) findings.push(sharedFinding("shared-no-merge-listener", entry));
  if (/\.(?:change|remove)\s*\(/.test(everything) && !/_r_conflicted|_conflicts\b/.test(everything)) {
    findings.push(sharedFinding("shared-conflicts-unshown", entry));
  }
  return findings;
}

/** True when the source stores data in a way that survives being sent to someone. */
export function storesDataInFile(source: string): boolean {
  // The kit stores through window.dai on the application's behalf, so an
  // application written entirely as HTML and SQL never names it. The first
  // such application — made by a model from the public recipe — was told its
  // data would not travel, which was false and is the one warning here that
  // would frighten exactly the person it is meant to help.
  return /window\.dai|dai\.openDatabase|dai-kit\.js|type\s*=\s*["']application\/sql["']|<dai-(?:rows|form|save|value)\b/.test(
    source,
  );
}
