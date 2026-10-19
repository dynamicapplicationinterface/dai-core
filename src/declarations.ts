/**
 * What an application declares about a table's columns (R-F amended), read
 * strictly (1b-H2).
 *
 * A declaration is a line comment inside the table's CREATE TABLE, where
 * SQLite keeps it in the stored schema, so every copy reads the same one:
 *   -- dai:coupled lat lng        changed together: one conflict, shown together
 *   -- dai:consequential amount   a pending value is left out of the kit's views
 *
 * `coupled` names two or more of the table's own columns, `consequential` one
 * or more, each spelled exactly as the column is declared, separated by
 * spaces, with nothing else on the line. A column is in at most one coupled
 * group. A runtime column (rowid, oid, _rowid_, the hidden key) is not the
 * application's to declare.
 *
 * A `-- dai:` line that does not read exactly is refused by the lint and the
 * compiler, with one message, and ignored by the runtime. Read loosely, a
 * line like `-- dai:coupled lat lng: the position` named a column that does
 * not exist and made every save of the group throw; read case-insensitively,
 * `LAT LNG` would have coupled on one copy what a stricter reader left apart.
 * The policy layer's markers (`-- dai:replicated`, `-- dai:profile`) are the
 * one-shape check's, not this one's.
 *
 * Shared by the runtime, the lint and the compiler, so it is pure text: the
 * runtime passes the table's columns as SQLite reports them, and the lint and
 * the compiler read them from the CREATE TABLE.
 */
import { HIDDEN_KEY } from "./changes-log.js";

export interface Declared {
  coupled: string[][];
  consequential: string[];
}

/** One `-- dai:` line, where it sits, and whether it reads exactly. */
export interface DeclarationLine {
  text: string;
  /** The table whose CREATE TABLE it sits in, or null. */
  table: string | null;
  kind: "coupled" | "consequential" | null;
  columns: string[];
  ok: boolean;
}

const RUNTIME_COLUMN = new RegExp(`^(?:rowid|oid|_rowid_|${HIDDEN_KEY})$`, "i");
const NAME = String.raw`"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*`;
const EXACT = new RegExp(String.raw`^[ \t]*dai:(coupled|consequential)((?:[ \t]+(?:${NAME}))+)[ \t]*\r?$`);
const ANY_NAME = String.raw`"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*`;
const CREATE = new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:${ANY_NAME})\s*\.\s*)?(${ANY_NAME})\s*\(`, "gi");

const unquoted = (name: string): string =>
  /^"/.test(name) ? name.slice(1, -1).split('""').join('"') : /^[\x60[]/.test(name) ? name.slice(1, -1) : name;

/** The SQL with string literals blanked (and comments too, when asked), offsets kept. */
function masked(sql: string, comments: boolean): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?/g, (m) => (!comments && m.startsWith("--") ? m : blank(m)));
}

/** The column names a CREATE TABLE body declares, read from its text. */
function columnsOfBody(body: string): string[] {
  const defs: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if ((c === "," && depth === 0) || i === body.length) {
      defs.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  return defs
    .filter((d) => d && !/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(d))
    .map((d) => unquoted(new RegExp(`^(?:${ANY_NAME}|\\S+)`).exec(d)![0]));
}

/**
 * Every `-- dai:` line in `sql` but the policy layer's markers. `columnsOf`
 * gives a table's columns when the caller knows them better than the text
 * does (the runtime, from SQLite).
 */
export function declarationLines(sql: string, columnsOf?: (table: string) => string[] | undefined): DeclarationLine[] {
  const all = masked(sql, true);
  const tables: { name: string; from: number; to: number; columns: string[] }[] = [];
  for (const m of all.matchAll(CREATE)) {
    const from = m.index! + m[0].length;
    let depth = 1;
    let to = from;
    while (to < all.length && depth > 0) {
      if (all[to] === "(") depth += 1;
      else if (all[to] === ")") depth -= 1;
      to += 1;
    }
    const name = unquoted(m[1]!);
    tables.push({ name, from, to: to - 1, columns: columnsOf?.(name) ?? columnsOfBody(all.slice(from, to - 1)) });
  }
  const lines: DeclarationLine[] = [];
  for (const m of masked(sql, false).matchAll(/--([^\n]*)/g)) {
    const text = sql.slice(m.index! + 2, m.index! + m[0].length);
    if (!/^[ \t]*dai:/i.test(text) || /^[ \t]*dai:(?:replicated|profile)\b/i.test(text)) continue;
    const home = tables.find((t) => m.index! >= t.from && m.index! < t.to) ?? null;
    const exact = EXACT.exec(text);
    const kind = exact ? (exact[1] as "coupled" | "consequential") : null;
    const columns = exact ? [...exact[2]!.matchAll(new RegExp(NAME, "g"))].map((n) => unquoted(n[0])) : [];
    const ok =
      home !== null &&
      kind !== null &&
      columns.length >= (kind === "coupled" ? 2 : 1) &&
      new Set(columns).size === columns.length &&
      columns.every((c) => home.columns.includes(c) && !RUNTIME_COLUMN.test(c));
    lines.push({ text: `--${text}`.replace(/\r$/, ""), table: home?.name ?? null, kind, columns, ok });
  }
  // A column in two coupled groups of one table: neither group reads as one change.
  for (const line of lines) {
    if (!line.ok || line.kind !== "coupled") continue;
    const others = lines.filter((o) => o !== line && o.kind === "coupled" && o.table === line.table && o.columns.length);
    if (others.some((o) => o.columns.some((c) => line.columns.includes(c)))) line.ok = false;
  }
  return lines;
}

/** What one CREATE TABLE declares, given its columns: only the lines that read exactly. */
export function declaredIn(createSql: string, columns: string[]): Declared {
  const out: Declared = { coupled: [], consequential: [] };
  for (const line of declarationLines(createSql, () => columns)) {
    if (!line.ok) continue;
    if (line.kind === "coupled") out.coupled.push(line.columns);
    else out.consequential.push(...line.columns);
  }
  return out;
}

/** The one message for a declaration that does not read exactly: the lint's finding and the compiler's refusal. */
export const DECLARATION = {
  id: "declaration",
  what: "A -- dai: line in its schema is not a declaration the runtime can read exactly.",
  why:
    "A declaration names columns of the table it sits in: -- dai:coupled and two or more of them, or " +
    "-- dai:consequential and one or more, each spelled exactly as the column is, separated by spaces, with " +
    "nothing else on the line, and no column in two coupled groups. A line the runtime cannot read exactly is " +
    "ignored, so columns meant to change together merge apart, and nothing on screen says so.",
  fix:
    "Write each declaration inside its CREATE TABLE as -- dai:coupled lat lng or -- dai:consequential amount, " +
    "naming that table's columns exactly as they are spelled, and put any explanation on a comment line of its own.",
};
