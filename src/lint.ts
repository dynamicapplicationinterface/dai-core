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

export interface Finding {
  /** Stable identifier, for callers that want to filter or count. */
  id: string;
  what: string;
  why: string;
  fix: string;
}

interface Check {
  id: string;
  pattern: RegExp;
  what: string;
  why: string;
  fix: string;
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
    ({ id, what, why, fix }) => ({ id, what, why, fix }),
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
  return Object.entries(files)
    .filter(([name]) => /\.(?:html?|m?js|ts)$/i.test(name))
    .flatMap(([name, source]) =>
      lintSource(source).map((finding) => ({ ...finding, file: name })),
    );
}

/** True when the source stores data in a way that survives being sent to someone. */
export function storesDataInFile(source: string): boolean {
  return /window\.dai|dai\.openDatabase/.test(source);
}
