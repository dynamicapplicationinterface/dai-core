/**
 * The changeset log's declaration (R-O; src/changesets.ts), apart from the
 * module that writes it, so the compiler can declare it without the runtime's
 * bundle taking the capture and projection code with it.
 */

/** The log table: one row per save, its payload the save's changeset. */
export const CHANGES_LOG = "_cs_log";

/** What the compiler appends to the schema of a document with no session policy. */
export const CHANGES_DECLARATION = `\n-- dai:replicated\nCREATE TABLE IF NOT EXISTS ${CHANGES_LOG} (payload BLOB NOT NULL);\n`;

/**
 * The key a table with no primary key is given (X1): an explicit column whose
 * default is drawn from the author's range, so the row has its key from the
 * moment it is inserted. A rowid moved into the range after the insert was
 * recorded by the session under the rowid it had first, and the row never
 * reached the log.
 */
export const HIDDEN_KEY = "_dai_id";

const sqlText = (s: string): string => `'${s.split("'").join("''")}'`;

/** The hidden key's column definition, as the first column of `table`. */
export function hiddenKeyColumn(table: string): string {
  return `${HIDDEN_KEY} INT NOT NULL ON CONFLICT REPLACE DEFAULT (dai_id(${sqlText(table)})) PRIMARY KEY`;
}

/** The SQL with comments and string literals blanked to spaces, so offsets still line up. */
function masked(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?/g, (m) => m.replace(/[^\n]/g, " "));
}

const NAME = String.raw`"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*`;
const CREATE = new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:${NAME})\s*\.\s*)?(${NAME})\s*\(`, "gi");

const unquoted = (name: string): string =>
  /^"/.test(name) ? name.slice(1, -1).split('""').join('"') : /^[\x60[]/.test(name) ? name.slice(1, -1) : name;

/**
 * Every CREATE TABLE in `sql` that declares no primary key, given the hidden
 * key as its first column (first, because table constraints must follow every
 * column). Anything else comes back byte for byte.
 */
export function withHiddenKeys(sql: string): string {
  const mask = masked(sql);
  const inserts: [number, string][] = [];
  for (const m of mask.matchAll(CREATE)) {
    const open = m.index! + m[0].length;
    let depth = 1;
    let at = open;
    while (at < mask.length && depth > 0) {
      if (mask[at] === "(") depth += 1;
      else if (mask[at] === ")") depth -= 1;
      at += 1;
    }
    if (depth > 0) continue;
    if (/\bPRIMARY\s+KEY\b/i.test(mask.slice(open, at - 1))) continue;
    inserts.push([open, `${hiddenKeyColumn(unquoted(m[1]!))}, `]);
  }
  let out = sql;
  for (const [at, text] of inserts.reverse()) out = out.slice(0, at) + text + out.slice(at);
  return out;
}
