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

/**
 * The document-level marker that opts a document into sessions (T1-D26).
 *
 * Unlike `dai:replicated`, which sits above one table, this applies to the whole
 * document: every replicated table gains `_r_session`, because a session is a
 * property of the rows, not of a single table. `-- dai:profile session
 * max_parties=2`.
 */
export const SESSION_PROFILE_MARKER = "dai:profile session";

export interface SessionProfile {
  maxParties: number;
}

/**
 * The session profile a document declares, if any (T1-D26).
 *
 * A line comment anywhere in the schema, quote- and comment-aware for the same
 * reason the rest of this file is: the marker inside a string, or inside a block
 * comment, is not a declaration. A profile that names a non-integer or a bound
 * below one is refused rather than read as zero — a session nobody can join is
 * not what anyone meant.
 */
export function parseSessionProfile(sql: string): SessionProfile | null {
  let quote: string | null = null;
  let line: string | null = null;
  const comments: string[] = [];
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (line !== null) {
      if (char === "\n") {
        comments.push(line);
        line = null;
      } else {
        line += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "-" && next === "-") {
      line = "";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) index += 1;
      index += 1; // land on the '/', the loop's increment steps past it
      continue;
    }
  }
  if (line !== null) comments.push(line);

  for (const comment of comments) {
    const match = /^\s*dai:profile\s+session\s+max_parties\s*=\s*(-?\d+)\s*$/i.exec(comment.trim());
    if (!match) continue;
    const maxParties = Number(match[1]);
    if (!Number.isInteger(maxParties) || maxParties < 1) {
      throw new ReplicationError(
        `The session profile declares max_parties=${match[1]}. A session holds at least ` +
          "one party; a bound below one is a session nobody can join.",
      );
    }
    return { maxParties };
  }
  return null;
}

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
  /** The session profile, when the document declares one (T1-D26). */
  session?: SessionProfile;
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

/**
 * The columns, key and table options every replicated table gets.
 *
 * `_r_session` is added only when the document declares the session profile
 * (T1-D26). A document without it gets exactly the columns it got before this
 * existed, so its digest, signature and stored bytes are unchanged.
 */
function replicationColumns(session: boolean): string {
  return [
    "  _r_replica    BLOB    NOT NULL CHECK (length(_r_replica) = 16),",
    "  _r_seq        INTEGER NOT NULL CHECK (_r_seq > 0),",
    "  _r_lc         INTEGER NOT NULL,",
    "  _r_entity     BLOB    NOT NULL CHECK (length(_r_entity) = 16),",
    "  _r_parents    TEXT    NOT NULL DEFAULT '[]',",
    "  _r_deleted    INTEGER NOT NULL DEFAULT 0 CHECK (_r_deleted IN (0,1)),",
    "  _r_superseded INTEGER NOT NULL DEFAULT 0 CHECK (_r_superseded IN (0,1)),",
    "  _r_sig        BLOB,",
    ...(session ? ["  _r_session    BLOB    NOT NULL CHECK (length(_r_session) = 16),"] : []),
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
/**
 * The `_heads` view — heads are where admission is enforced (T1-D29).
 *
 * A plain replicated table trusts the stored `_r_superseded` flag: a head is a
 * row nothing supersedes, and the flag is maintained at write (T1-D2).
 *
 * A session author table cannot, because **membership is a function of the
 * current rows, not of when a row arrived.** A member becomes a non-member the
 * moment a second binding contests its seat, and its rows must vanish — and a
 * member's row that a *non-member* had superseded must re-emerge. The stored
 * flag was decided at insert and cannot express either. So a head here is
 * recomputed over the **admitted** subset: an admitted row (its author is a
 * member of its session, via `_dai_member`) that no *other admitted* row names
 * as a parent. A non-member's row neither shows nor hides anything, and a
 * contest that flips membership recomputes on the next read. It is the Draft 1
 * `json_each` walk again, gated to admitted rows, and it is the price of a
 * roster that changes.
 *
 * **Cost, to measure before it ships at scale.** A plain table reads a flag; a
 * session table walks the parents DAG over the admitted subset on every read of
 * `_heads`. Chess is small enough that nobody notices; a tracker with thousands
 * of rows after two years is not. Measure it once at that size, and if it is
 * slow the answer is a materialized membership set recomputed on merge — not a
 * return to the stored flag, which cannot express a membership that changes.
 */
function headsView(q: string, admissionFiltered: boolean): string {
  if (!admissionFiltered) {
    return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT * FROM ${q} WHERE _r_superseded = 0;`;
  }
  const admitted = (row: string): string =>
    `EXISTS (SELECT 1 FROM _dai_member m WHERE m.session = ${row}._r_session AND m.replica = ${row}._r_replica)`;
  return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT r.* FROM ${q} r
   WHERE ${admitted("r")}
     AND NOT EXISTS (
       SELECT 1 FROM ${q} c, json_each(c._r_parents) p
        WHERE ${admitted("c")}
          AND p.value = lower(hex(r._r_replica)) || ':' || r._r_seq
     );`;
}

function tableObjects(name: string, authored: string[], session: boolean, admissionFiltered: boolean): string {
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
    // A row's session is fixed at write and never edited, like every other _r_
    // column, so the append-only trigger names it too (T1-D26).
    ...(session ? ["_r_session"] : []),
  ].join(", ");
  return `
CREATE INDEX IF NOT EXISTS ${q}__r_entity ON ${q}(_r_entity, _r_lc);
CREATE INDEX IF NOT EXISTS ${q}__r_heads ON ${q}(_r_entity) WHERE _r_superseded = 0;

CREATE TRIGGER IF NOT EXISTS ${q}__no_update BEFORE UPDATE OF
    ${immutable} ON ${q}
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS ${q}__no_delete BEFORE DELETE ON ${q}
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS ${q}__superseded_monotonic BEFORE UPDATE OF _r_superseded ON ${q}
  WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0
  BEGIN SELECT RAISE(ABORT, 'ROW_REJECTED'); END;

${headsView(q, admissionFiltered)}

CREATE VIEW IF NOT EXISTS ${q}_conflicts AS
  SELECT _r_entity, count(*) AS heads,
         json_group_array(hex(_r_replica) || ':' || _r_seq) AS head_ids
  FROM ${q}_heads GROUP BY _r_entity HAVING count(*) > 1;

CREATE VIEW IF NOT EXISTS ${q}_current AS
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

/**
 * The two document-level tables, emitted once when anything is replicated.
 *
 * `IF NOT EXISTS` on every object this file emits, as on the indexes, triggers
 * and views above. The schema block is executed on *every* open, not only the
 * first — the kit runs each `<script type="application/sql">` before anything
 * draws — so a bare CREATE opens a fresh document once and refuses to open it
 * ever again. It was invisible in unit tests because each one builds a new
 * in-memory database and runs the schema exactly once; the first thing to hit
 * it was a second person opening a document that had been used.
 */
function documentTables(session: boolean): string {
  const base = `
CREATE TABLE IF NOT EXISTS _dai_replica (
  id    BLOB PRIMARY KEY CHECK (length(id) = 16),
  seq   INTEGER NOT NULL DEFAULT 0,
  lc    INTEGER NOT NULL DEFAULT 0,
  label TEXT
);

-- Every column but the id is LOCAL: true of this copy, not of the document.
-- They are deliberately outside the canonical dump (T1-D12), and a dump
-- generator that adds them will find two correct copies that never agree.
CREATE TABLE IF NOT EXISTS _dai_replicas (
  id         BLOB PRIMARY KEY CHECK (length(id) = 16),
  -- LOCAL. A name this copy gives a key, never a name the key carries: keys
  -- cannot be faked and names can, so a label that propagated would be the
  -- one thing the identity design refused.
  label      TEXT,
  -- LOCAL. When *this* copy first saw that replica. A and B each record the
  -- other at the merge that introduced them, so these disagree by design.
  first_seen INTEGER NOT NULL,
  rows_seen  INTEGER NOT NULL DEFAULT 0
);
`;
  if (!session) return base;

  /*
   * The roster tables and the membership view (T1-D29).
   *
   * Both are ordinary replicated tables — they merge, carry `_r_session`, and
   * are filtered into an invite like any other — but they are the roster
   * itself, so their own heads are NOT admission-filtered: a seat and a binding
   * are always visible for computing who is a member. `_dai_seat` carries the
   * seat the creator minted; `_dai_binding` carries the seat a joiner bound, and
   * the joiner is `_r_replica` — the author is the key, so nobody can bind a
   * seat to a replica that is not their own.
   *
   * `_dai_member` is the pure rule of `rosterOf` expressed in SQL: a replica is
   * a member of a session iff it binds a minted seat that exactly one replica
   * binds. A seat two replicas bind is contested and appears for neither.
   */
  const rosterTable = (name: string): string =>
    `CREATE TABLE IF NOT EXISTS ${name} (\n  seat BLOB NOT NULL CHECK (length(seat) = 16),\n${replicationColumns(true)}\n) WITHOUT ROWID;\n` +
    tableObjects(name, ["seat"], true, false);

  const member = `
CREATE VIEW IF NOT EXISTS _dai_member AS
  SELECT b._r_session AS session, b._r_replica AS replica
    FROM _dai_binding_current b
    JOIN _dai_seat_current s
      ON s._r_session = b._r_session AND s.seat = b.seat
   WHERE (SELECT count(DISTINCT hex(b2._r_replica))
            FROM _dai_binding_current b2
           WHERE b2._r_session = b._r_session AND b2.seat = b.seat) = 1;
`;
  return base + rosterTable("_dai_seat") + rosterTable("_dai_binding") + member;
}

/** The replicated system tables a session document carries beside its author tables (T1-D29). */
export const SESSION_SYSTEM_TABLES = ["_dai_seat", "_dai_binding"] as const;

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
  /*
   * `IF NOT EXISTS` is optional here because this reads back what the emitter
   * above wrote, and the emitter gained the clause after this was written.
   *
   * A regex that stops matching its own output does not report a mismatch — it
   * reports no trigger at all, and the coverage check then fails on every
   * column at once, which is how this was found.
   */
  const found = new RegExp(
    `CREATE TRIGGER (?:IF NOT EXISTS )?${table}__no_update BEFORE UPDATE OF\\s+([\\s\\S]*?)\\s+ON ${table}\\b`,
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
  const session = parseSessionProfile(sql);
  if (declared.length === 0) {
    // A session profile with nothing to scope is a declaration that does
    // nothing; refuse it rather than emit a manifest bound over no rows (T1-D26).
    if (session) {
      throw new ReplicationError(
        "The session profile declares a session, but no table is marked -- dai:replicated. " +
          "A session scopes replicated rows; declare a replicated table, or drop the profile.",
      );
    }
    return { sql, tables: [] };
  }

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

    /*
     * The compiler owns this statement — it adds seven columns, a composite
     * key and WITHOUT ROWID — so it also makes it idempotent. The schema block
     * runs on every open, and a bare CREATE opens a document once and refuses
     * it thereafter. An author who wrote IF NOT EXISTS already keeps theirs.
     */
    const header = sql.slice(cursor, span.open + 1);
    out += /\bIF\s+NOT\s+EXISTS\b/i.test(header)
      ? header
      : header.replace(/\bCREATE\s+TABLE\s+/i, (kw) => `${kw}IF NOT EXISTS `);
    out += `${authorBody},\n${replicationColumns(session !== null)}\n)${tail}`;
    // Author tables are admission-filtered in a session document: their heads
    // are recomputed over the members' rows (T1-D29). The roster tables that
    // carry the membership are not — they are emitted by documentTables.
    out += tableObjects(span.name, authorColumns(body), session !== null, session !== null);
    cursor = span.end;
  }
  out += sql.slice(cursor);

  return {
    sql: documentTables(session !== null) + out,
    // Author tables only — the manifest's `replication.tables` surface, and what
    // the sibling test reads. The roster tables (`SESSION_SYSTEM_TABLES`) are in
    // the schema and the digest but not this list; they are implicit in a session
    // document the way `_dai_replica` is, and the runtime appends them to the
    // replicated set for merge and export (T1-D29, spec §3 example).
    tables: declared.map((span) => span.name),
    ...(session ? { session } : {}),
  };
}
