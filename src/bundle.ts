/**
 * One plain-text file holding an application's source.
 *
 * A model writing an application has to say where one file ends and the next
 * begins, and there is no agreed way to do it. Left alone it invents one per
 * answer: fenced blocks with a heading above, or a comment naming the file, or
 * a single enormous HTML document because splitting felt risky. Every variant
 * has to be understood by whatever receives it, and the ones that are not
 * understood become a person copying files out of a chat window by hand.
 *
 * So this is a format for exactly that: what a model emits, what a person
 * pastes, and what the compiler reads.
 *
 * ## The shape
 *
 *     dai bundle v1
 *     name: Reading list
 *
 *     --- file: index.html
 *     <!doctype html>
 *     …
 *
 *     --- file: app.js
 *     const db = await window.dai.openDatabase();
 *
 * Strict to write and forgiving to read. The canonical form above is small
 * enough to hold in one instruction and regular enough to constrain a decoder
 * with; the reader also accepts fenced markdown, because that is what a model
 * produces when it has not been told otherwise, and refusing it would throw
 * away a completion over punctuation.
 */

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export interface Bundle {
  /** Names the application. Absent when the bundle did not say. */
  name?: string;
  files: Record<string, string>;
  /**
   * What was accepted that the canonical form would not have written.
   *
   * Reported rather than silently tolerated: a bundle that parsed only because
   * the reader was generous is one whose author should be told, and an agent
   * correcting its own output needs to know which part was wrong.
   */
  warnings: string[];
}

const MAGIC = "dai bundle v1";
const FILE_MARKER = /^--- file:\s*(.+?)\s*$/;
/** An escaped marker inside content: a line the author had to protect. */
const ESCAPED_MARKER = /^\\(--- file:)/;
const FENCE = /^```+\s*([A-Za-z0-9+.#-]*)\s*$/;
/** A heading naming a file, which is how a model labels a fenced block. */
const HEADING = /^#{1,6}\s+`?([\w./-]+\.[A-Za-z0-9]+)`?\s*$/;
const BARE_PATH = /^`?([\w./-]+\.[A-Za-z0-9]+)`?:?\s*$/;

/**
 * Refuses a path that would write outside the application.
 *
 * A bundle is untrusted input — it arrives from a model, or through a paste box
 * — and the compiler turns entries into files. `../` in a name is the oldest
 * archive bug there is.
 */
function checkPath(path: string): string {
  const clean = path.trim().replace(/^\.\//, "");

  if (!clean) throw new BundleError("A file in this bundle has no name.");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
    throw new BundleError(`"${clean}" is an absolute path; names must be relative.`);
  }
  if (clean.split(/[\\/]/).some((part) => part === "..")) {
    throw new BundleError(`"${clean}" climbs out of the application.`);
  }
  return clean.split("\\").join("/");
}

/** The canonical form: explicit markers, no guessing. */
function parseMarkers(lines: string[], start: number): Bundle["files"] {
  const files: Record<string, string> = {};
  let current: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    // One trailing newline, however many the author left. Whitespace at the end
    // of a file is not information, and a diff full of it hides the change.
    files[current] = body.join("\n").replace(/\s+$/, "") + "\n";
  };

  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    const marker = FILE_MARKER.exec(line);

    if (marker) {
      flush();
      current = checkPath(marker[1] as string);
      body = [];
      continue;
    }

    if (current !== null) {
      const escaped = ESCAPED_MARKER.exec(line);
      body.push(escaped ? line.replace(/^\\/, "") : line);
    }
  }

  flush();
  return files;
}

/**
 * The tolerant path: fenced blocks with the filename above them.
 *
 * What a model writes when nobody has told it the format. Recognising it costs
 * a regex and saves a completion; the alternative is refusing work that is
 * entirely usable because its punctuation is conventional rather than ours.
 */
function parseFences(lines: string[]): { files: Record<string, string>; used: boolean } {
  const files: Record<string, string> = {};
  let pending: string | null = null;
  let fence: string | null = null;
  let body: string[] = [];
  let used = false;

  for (const line of lines) {
    if (fence !== null) {
      if (FENCE.test(line)) {
        if (pending) {
          files[checkPath(pending)] = body.join("\n").replace(/\s+$/, "") + "\n";
          used = true;
        }
        pending = null;
        fence = null;
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }

    const opening = FENCE.exec(line);
    if (opening) {
      fence = opening[1] ?? "";
      body = [];
      continue;
    }

    const named = HEADING.exec(line) ?? BARE_PATH.exec(line);
    if (named) pending = named[1] as string;
  }

  return { files, used };
}

/**
 * Reads a bundle, by whichever of the two shapes it turns out to be.
 *
 * Never guesses between them: the marker form wins whenever a marker is
 * present, because a bundle that contains both is one somebody wrote carefully
 * and then pasted a fenced block into.
 */
export function parseBundle(text: string): Bundle {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];

  let start = 0;
  let name: string | undefined;

  if ((lines[0] ?? "").trim() === MAGIC) {
    start = 1;
    for (; start < lines.length; start++) {
      const line = (lines[start] ?? "").trim();
      if (line === "") {
        start++;
        break;
      }
      const header = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (!header) break;
      if (header[1]?.toLowerCase() === "name") name = header[2]?.trim() || undefined;
    }
  } else {
    warnings.push(`This bundle does not begin with "${MAGIC}".`);
  }

  const hasMarkers = lines.some((line) => FILE_MARKER.test(line));
  let files: Record<string, string>;

  if (hasMarkers) {
    files = parseMarkers(lines, start);
  } else {
    const fenced = parseFences(lines);
    files = fenced.files;
    if (fenced.used) {
      warnings.push(
        "This bundle uses fenced code blocks rather than file markers. It was read, " +
          `but "--- file: name" is the form that cannot be misread.`,
      );
    }
  }

  if (Object.keys(files).length === 0) {
    throw new BundleError(
      "No files in this bundle. Each one starts with a line reading " +
        '"--- file: index.html".',
    );
  }

  if (!Object.keys(files).some((path) => path === "index.html")) {
    warnings.push("No index.html: a container built from this will open blank.");
  }

  return { name, files, warnings };
}

/** Writes the canonical form. The only shape this project produces. */
export function writeBundle(files: Record<string, string>, options: { name?: string } = {}): string {
  const out: string[] = [MAGIC];
  if (options.name) out.push(`name: ${options.name}`);
  out.push("");

  // index.html first, then the rest by name: a person reading a bundle wants
  // the entry point, and a stable order keeps two builds of one application
  // comparable.
  const paths = Object.keys(files).sort((a, b) => {
    if (a === "index.html") return -1;
    if (b === "index.html") return 1;
    return a.localeCompare(b);
  });

  for (const path of paths) {
    out.push(`--- file: ${path}`);
    // A content line that looks like a marker is escaped, so a bundle can carry
    // documentation about bundles without ending itself halfway through.
    const body = (files[path] ?? "").replace(/\s+$/, "");
    for (const line of body.split(/\r?\n/)) {
      out.push(FILE_MARKER.test(line) ? `\\${line}` : line);
    }
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "\n");
}
