/**
 * "Current" is derived from admission, never from a cache (D140).
 *
 * `_r_superseded` is a display cache kept at write. Which rows raise it depends
 * on what arrived and in what order, so a view, writer, gate or kit read that
 * decides "current" from it can be steered by a row nobody admits: a binding
 * of another session took an ask out of the roster, and the kit seated a rival.
 * Every such read derives from the compiled admission views instead, within the
 * row's own partition. The same holds for the seat and close tables: outside
 * `src/replicated.ts`, which defines admission from them, code reads their
 * `_current` and admission views, not the raw rows.
 *
 * One detector, two callers: `scripts/check-flag.mjs`, in the typecheck chain,
 * and the test that holds the check itself. The same family as check-names
 * and check-seats: a scan with named exceptions, each with its reason, where
 * an exception that excuses nothing fails.
 */

interface FlagRead {
  kind: "flag" | "raw-seat-table";
  line: number;
  text: string;
}

const FLAG = /_r_superseded/;
/** The cache's own upkeep: its column, its writes, and the trigger that keeps it monotonic. */
const UPKEEP = [
  /_r_superseded\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(_r_superseded\s+IN\s*\(0,\s*1\)\)/g,
  /\bSET\s+_r_superseded\s*=\s*[01]\b/gi,
  /\bUPDATE\s+OF\s+_r_superseded\b/gi,
  /\b(?:OLD|NEW)\._r_superseded\b/g,
];
const RAW_SEAT_TABLE = /\b(?:FROM|JOIN)\s+["'`[]?_dai_(?:seat|binding|confirm|close)\b(?!_)/i;

/** Every read of the cache, or of a raw seat or close table, in one source, by line. Comment lines are prose, not code. */
function flagReadsIn(source: string, options: { rawSeatTables: boolean }): FlagRead[] {
  const found: FlagRead[] = [];
  source.split("\n").forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("--")) return;
    let rest = text;
    for (const upkeep of UPKEEP) rest = rest.replace(upkeep, "");
    if (FLAG.test(rest)) found.push({ kind: "flag", line: index + 1, text: trimmed });
    if (options.rawSeatTables && RAW_SEAT_TABLE.test(text)) found.push({ kind: "raw-seat-table", line: index + 1, text: trimmed });
  });
  return found;
}

/**
 * Problems across files. An exception is keyed `"path: text"` and excuses a
 * read on a line of that file containing that text; one that excuses nothing
 * is itself a problem. `admissionOwner` is the file that defines admission from
 * the raw seat tables, and only it may read them.
 */
export function flagReadProblems(
  files: readonly { path: string; source: string }[],
  exceptions: Readonly<Record<string, string>>,
  admissionOwner = "src/replicated.ts",
): string[] {
  const problems: string[] = [];
  const used = new Set<string>();
  for (const { path, source } of files) {
    for (const read of flagReadsIn(source, { rawSeatTables: path !== admissionOwner })) {
      const key = Object.keys(exceptions).find((k) => k.startsWith(`${path}: `) && read.text.includes(k.slice(path.length + 2)));
      if (key) {
        used.add(key);
        continue;
      }
      problems.push(
        read.kind === "flag"
          ? `${path}:${read.line} reads the stored _r_superseded flag; derive "current" from the admission views: ${read.text}`
          : `${path}:${read.line} reads a raw seat or close table; read its _current or admission view: ${read.text}`,
      );
    }
  }
  for (const key of Object.keys(exceptions)) {
    if (!used.has(key)) problems.push(`the exception "${key}" excuses nothing; remove it`);
  }
  return problems;
}
