/**
 * The seat tables are the kit's (docs/identity.md, step 5; IDENTITY-KIT-SEATS).
 *
 * An application starts a session, claims a seat and asks who holds one
 * through `window.daiKit`, and never writes `_dai_seat`, `_dai_binding` or
 * `_dai_confirm` itself: not with its own SQL, and not through the runtime's session writers,
 * which the kit wraps. What an application writes around the kit is what the
 * kit's reads and the document's admission were built not to trust, so it is
 * refused at build rather than discovered in a merge.
 *
 * One detector, two callers: the authoring lint (`src/lint.ts`, finding
 * `seat-table-write`), which reaches any application built on the format, and
 * `scripts/check-seats.mjs`, which holds this repository's own applications to
 * it. The kit itself (`src/kit.ts`) is the owner and is never scanned.
 */

export interface SeatWrite {
  /** Which kind of write: its own SQL, or a runtime writer the kit wraps. */
  kind: "sql" | "create" | "join" | "confirm" | "reseat";
  line: number;
  text: string;
}

const SQL_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["'`[]?_dai_(?:seat|binding|confirm)\b/i;
const RUNTIME_WRITER = /\.session\s*\.\s*(create|join|confirm|reseat)\s*\(/;

/** Every seat-table write in one source, by line. Comment lines are prose, not code. */
export function seatWritesIn(source: string): SeatWrite[] {
  const found: SeatWrite[] = [];
  source.split("\n").forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("--")) return;
    if (SQL_WRITE.test(text)) found.push({ kind: "sql", line: index + 1, text: trimmed });
    const writer = RUNTIME_WRITER.exec(text);
    if (writer) found.push({ kind: writer[1] as SeatWrite["kind"], line: index + 1, text: trimmed });
  });
  return found;
}

/**
 * Problems across files, with named exceptions keyed `"path: kind"` and a
 * reason each. An exception that excuses nothing is itself a problem, so a
 * list of excuses cannot outlive what it excused.
 */
export function seatWriteProblems(
  files: readonly { path: string; source: string }[],
  exceptions: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const { path, source } of files) {
    for (const write of seatWritesIn(source)) {
      const key = `${path}: ${write.kind}`;
      if (key in exceptions) {
        used.add(key);
        continue;
      }
      problems.push(
        `${path}:${write.line} writes a seat table around the kit (${write.kind === "sql" ? "its own SQL" : `session.${write.kind}`}): ${write.text}`,
      );
    }
  }
  for (const key of Object.keys(exceptions)) {
    if (!used.has(key)) problems.push(`the exception "${key}" excuses nothing; remove it`);
  }
  return problems;
}
