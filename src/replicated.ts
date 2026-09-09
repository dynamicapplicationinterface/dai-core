/**
 * The compiler's half of replicated tables (docs/replicated-tables.md §3, §4).
 *
 * An author writes a table and one comment above it. What SQLite is given is a
 * different table: the same columns plus the replication columns, a composite
 * primary key, indexes, triggers that make it append-only, and three views.
 * The author never sees `_r_*` and never writes it.
 *
 * The declaration is a comment, and `normaliseSchema` removes comments — so
 * this runs on the author's raw SQL, before normalisation, and the digest is
 * taken over what comes out. That ordering is deliberate: the digest then
 * covers the replication columns, which is what makes "the schema digests
 * match" mean "these two copies can merge" in the sibling test.
 *
 * Level 1. `_r_sig` is emitted and always NULL (T1-D7), so Level 2 is a change
 * of behaviour rather than a migration over every row ever written.
 */

/** The marker an author writes above a table they want replicated. */
export const REPLICATED_MARKER = "dai:replicated";

export class ReplicationError extends Error {
  readonly code = "REPLICATION_SCHEMA_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ReplicationError";
  }
}

export interface RewrittenSchema {
  /** The schema as SQLite will receive it. */
  sql: string;
  /** The tables declared replicated, in the order they appear. */
  tables: string[];
}

/**
 * Walks SQL, reporting which characters are inside a literal or a comment.
 *
 * Everything here has to be quote-aware for the same reason `normaliseSchema`
 * is: `-- dai:replicated` inside a string is a string, and a `)` inside one
 * does not close anything. Getting this wrong would rewrite a table nobody
 * asked to replicate, or truncate one that is.
 */
function* scan(sql: string): Generator<{ index: number; char: string; code: boolean }> {
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (comment === "line") {
      if (char === "\n") comment = null;
      yield { index, char, code: false };
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        yield { index, char, code: false };
        index += 1;
        yield { index, char: "/", code: false };
        comment = null;
        continue;
      }
      yield { index, char, code: false };
      continue;
    }
    if (quote) {
      // Doubling is how SQL escapes its own quote character.
      if (char === quote && next === quote) {
        yield { index, char, code: false };
        index += 1;
        yield { index, char: next, code: false };
        continue;
      }
      if (char === quote) quote = null;
      yield { index, char, code: false };
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      yield { index, char, code: false };
      continue;
    }
    if (char === "-" && next === "-") {
      comment = "line";
      yield { index, char, code: false };
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      yield { index, char, code: false };
      continue;
    }
    yield { index, char, code: true };
  }
}

/** Where each `CREATE TABLE` statement starts and ends, and what it is called. */
interface TableSpan {
  name: string;
  /** Index of the `C` in `CREATE`. */
  start: number;
  /** Index just past the statement's closing `)`. */
  end: number;
  /** Index of the `(` that opens the column list. */
  open: number;
  /** Index of the matching `)`. */
  close: number;
}

function tableSpans(sql: string): TableSpan[] {
  const code = [...scan(sql)];
  const isCode = new Set(code.filter((c) => c.code).map((c) => c.index));
  // A copy with every non-code character blanked, so a regex can find keywords
  // without ever matching inside a string or a comment.
  const bare = [...sql].map((char, index) => (isCode.has(index) ? char : " ")).join("");

  const spans: TableSpan[] = [];
  const create = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = create.exec(bare)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < bare.length; index += 1) {
      if (!isCode.has(index)) continue;
      if (bare[index] === "(") depth += 1;
      else if (bare[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1) throw new ReplicationError(`The table ${match[1]} has no closing bracket.`);
    // Past the closing bracket to the statement's semicolon, so table options
    // (WITHOUT ROWID, STRICT) are inside the span and not left dangling.
    let end = close + 1;
    while (end < bare.length && bare[end] !== ";") end += 1;
    spans.push({ name: match[1]!, start: match.index, end: Math.min(end + 1, bare.length), open, close });
  }
  return spans;
}

/** Whether the marker comment sits immediately above this statement. */
function declaredAbove(sql: string, start: number): boolean {
  const before = sql.slice(0, start);
  // Only whitespace may separate the marker from the table it marks: a comment
  // three statements earlier is not a declaration, and treating it as one
  // would replicate a table by accident.
  const trimmed = before.replace(/[ \t\r\n]+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  if (!lastLine.startsWith("--")) return false;
  return lastLine.slice(2).trim().toLowerCase() === REPLICATED_MARKER;
}

/** The three things §3 refuses, checked against the author's own column list. */
function checkAuthorColumns(name: string, body: string): void {
  const bare = [...scan(body)].map((c) => (c.code ? c.char : " ")).join("");
  if (/_r_/i.test(bare)) {
    throw new ReplicationError(
      `${name} uses the reserved prefix _r_. Those columns belong to replication; ` +
        "rename yours.",
    );
  }
  if (/\bPRIMARY\s+KEY\b/i.test(bare)) {
    throw new ReplicationError(
      `${name} declares its own PRIMARY KEY. A replicated table is keyed by ` +
        "(_r_replica, _r_seq); an identity of your own belongs in an ordinary column.",
    );
  }
  if (/\bAUTOINCREMENT\b/i.test(bare)) {
    throw new ReplicationError(
      `${name} declares AUTOINCREMENT. Row ids are minted per replica, and a counter ` +
        "that two copies both advance cannot be merged.",
    );
  }
}

/**
 * The author's own column names, in declared order.
 *
 * Needed because the update trigger has to name them. SQLite has no "update of
 * anything except" — the only way to leave one column writable is to list every
 * other one — and leaving the author's columns unnamed was a hole: a replicated
 * table is append-only, and an in-place edit of a title breaks that quietly. It
 * would also invalidate a Level 2 signature over a row that still looks intact.
 *
 * Only the leading identifier of each top-level item is taken, and table
 * constraints (CHECK, UNIQUE, FOREIGN KEY) are skipped: they are not columns
 * and naming them in a trigger is an error.
 */
function authorColumns(body: string): string[] {
  const chars = [...scan(body)];
  const names: string[] = [];
  let depth = 0;
  let item = "";
  const take = (text: string): void => {
    const word = /^\s*(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/.exec(text);
    const name = word?.[1] ?? word?.[2] ?? word?.[3] ?? word?.[4];
    if (!name) return;
    if (/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(name)) return;
    names.push(name);
  };
  for (const { char, code } of chars) {
    if (code && char === "(") depth += 1;
    else if (code && char === ")") depth -= 1;
    if (code && char === "," && depth === 0) {
      take(item);
      item = "";
      continue;
    }
    item += char;
  }
  take(item);
  return names;
}

/** The columns, key and table options every replicated table gets. */
function replicationColumns(): string {
  return [
    "  _r_replica    BLOB    NOT NULL CHECK (length(_r_replica) = 16),",
    "  _r_seq        INTEGER NOT NULL CHECK (_r_seq > 0),",
    "  _r_lc         INTEGER NOT NULL,",
    "  _r_entity     BLOB    NOT NULL CHECK (length(_r_entity) = 16),",
    "  _r_parents    TEXT    NOT NULL DEFAULT '[]',",
    "  _r_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (_r_deleted IN (0,1)),",
    "  _r_superseded INTEGER NOT NULL DEFAULT 0 CHECK (_r_superseded IN (0,1)),",
    "  _r_sig        BLOB,",
    "  PRIMARY KEY (_r_replica, _r_seq)",
  ].join("\n");
}

/**
 * The indexes, triggers and views for one table.
 *
 * The update trigger names the immutable columns rather than forbidding every
 * update (T1-D10): maintaining `_r_superseded` is itself an update, so a
 * blanket rule would make the flag impossible to keep. The flag rises only —
 * clearing it is refused, because two hosts with the same rows and different
 * flags never reconcile.
 */
function tableObjects(name: string, authored: string[]): string {
  const q = name;
  /*
   * Every column but `_r_superseded`, which is the one thing a write may
   * change. The author's own are here too: without them an in-place edit of a
   * row is permitted, and a replicated table that can be edited in place is not
   * append-only. A behavioural check caught that; the text of the trigger had
   * looked right.
   */
  const immutable = [
    ...authored,
    "_r_replica",
    "_r_seq",
    "_r_lc",
    "_r_entity",
    "_r_parents",
    "_r_deleted",
    "_r_sig",
  ].join(", ");
  return `
CREATE INDEX ${q}__r_entity ON ${q}(_r_entity, _r_lc);
CREATE INDEX ${q}__r_heads ON ${q}(_r_entity) WHERE _r_superseded = 0;

CREATE TRIGGER ${q}__no_update BEFORE UPDATE OF
    ${immutable} ON ${q}
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

CREATE TRIGGER ${q}__no_delete BEFORE DELETE ON ${q}
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

CREATE TRIGGER ${q}__superseded_monotonic BEFORE UPDATE OF _r_superseded ON ${q}
  WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0
  BEGIN SELECT RAISE(ABORT, 'ROW_REJECTED'); END;

CREATE VIEW ${q}_heads AS
  SELECT * FROM ${q} WHERE _r_superseded = 0;

CREATE VIEW ${q}_conflicts AS
  SELECT _r_entity, count(*) AS heads,
         json_group_array(hex(_r_replica) || ':' || _r_seq) AS head_ids
  FROM ${q}_heads GROUP BY _r_entity HAVING count(*) > 1;

CREATE VIEW ${q}_current AS
  SELECT h.*,
         (SELECT count(*) FROM ${q}_heads x WHERE x._r_entity = h._r_entity) > 1
           AS _r_conflicted
  FROM ${q}_heads h
  WHERE h._r_deleted = 0
    AND h._r_replica || ':' || h._r_seq = (
      SELECT y._r_replica || ':' || y._r_seq FROM ${q}_heads y
       WHERE y._r_entity = h._r_entity AND y._r_deleted = 0
       ORDER BY y._r_lc DESC, hex(y._r_replica) ASC, y._r_seq ASC
       LIMIT 1);
`;
}

/** The two document-level tables, emitted once when anything is replicated. */
function documentTables(): string {
  return `
CREATE TABLE _dai_replica (
  id    BLOB PRIMARY KEY CHECK (length(id) = 16),
  seq   INTEGER NOT NULL DEFAULT 0,
  lc    INTEGER NOT NULL DEFAULT 0,
  label TEXT
);

CREATE TABLE _dai_replicas (
  id         BLOB PRIMARY KEY CHECK (length(id) = 16),
  label      TEXT,
  first_seen INTEGER NOT NULL,
  rows_seen  INTEGER NOT NULL DEFAULT 0
);
`;
}

/**
 * What the immutability trigger must name, checked against the table itself.
 *
 * The trigger has to list every column but `_r_superseded`, because SQLite has
 * no "update of anything except". That list is produced by parsing the
 * author's column declarations, which makes the parser trust-relevant: a
 * column it fails to see is a column that can be edited in place, in a table
 * whose whole contract is that it cannot.
 *
 * So the parse is not trusted. The caller loads the rewritten schema into a
 * real engine and reads the columns back from it, and anything the trigger
 * does not name is a build failure. A parser bug becomes a refused build
 * rather than a document that quietly is not append-only.
 */
export function checkTriggerCoverage(
  table: string,
  columnsFromEngine: readonly string[],
  namedByTrigger: readonly string[],
): void {
  const named = new Set(namedByTrigger);
  const missing = columnsFromEngine.filter(
    (column) => column !== "_r_superseded" && !named.has(column),
  );
  if (missing.length === 0) return;
  throw new ReplicationError(
    `${table} would allow ${missing.join(", ")} to be edited in place: the immutability ` +
      "trigger does not name them. A replicated table is append-only, so this is a build " +
      "failure rather than something to notice later.",
  );
}

/** The columns a generated trigger names, read back out of the SQL. */
export function triggerColumns(sql: string, table: string): string[] {
  const found = new RegExp(
    `CREATE TRIGGER ${table}__no_update BEFORE UPDATE OF\\s+([\\s\\S]*?)\\s+ON ${table}\\b`,
  ).exec(sql);
  if (!found) return [];
  return found[1]!.split(",").map((name) => name.trim()).filter(Boolean);
}

/**
 * Rewrites an author's schema into the one SQLite is given.
 *
 * Returns the schema unchanged, and no tables, when nothing is declared — so
 * every existing document compiles through this untouched.
 */
export function rewriteReplicated(sql: string): RewrittenSchema {
  const spans = tableSpans(sql);
  const declared = spans.filter((span) => declaredAbove(sql, span.start));
  if (declared.length === 0) return { sql, tables: [] };

  let out = "";
  let cursor = 0;
  for (const span of declared) {
    checkAuthorColumns(span.name, sql.slice(span.open + 1, span.close));

    const body = sql.slice(span.open + 1, span.close);
    const authorBody = body.replace(/[\s,]+$/, "");
    const options = sql.slice(span.close + 1, span.end);
    // WITHOUT ROWID because the key is (_r_replica, _r_seq) and a rowid table
    // would carry a second identity nothing uses. An author's own options are
    // kept and this is appended, so STRICT and the rest survive.
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(options) ? "" : " WITHOUT ROWID";
    const tail = options.replace(/;\s*$/, "") + withoutRowid + ";";

    out += sql.slice(cursor, span.open + 1);
    out += `${authorBody},\n${replicationColumns()}\n)${tail}`;
    out += tableObjects(span.name, authorColumns(body));
    cursor = span.end;
  }
  out += sql.slice(cursor);

  return { sql: documentTables() + out, tables: declared.map((span) => span.name) };
}
