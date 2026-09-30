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
 * Signed authorship (docs/identity.md): every row names the signed batch it
 * left the device in, `_r_batch`, and the headers live in `_dai_batch`. A row
 * is written with `_r_batch` NULL, pending, and sealed once when it first
 * leaves (a save or a publish): NULL to a batch id, and never again. One place
 * a signature lives: the per-row `_r_sig` T1-D7 reserved is gone.
 */

import { SESSION_ID_FUNCTION } from "./session-id.js";

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

/** Who may close a session (T1-D32). `any` member, or only the `creator`. */
export type ClosePolicy = "any" | "creator";

export interface SessionProfile {
  maxParties: number;
  /** Who may author a close. Defaults to `any` when the profile omits it. */
  close: ClosePolicy;
}

/**
 * Who may author the rows of one replicated table in a session document (D15).
 *
 * The two roles the roster already has, and no others: the **creator** is the
 * replica that authored the session's seat rows, the **joiner** is a member who
 * authored none. The author of a row is its key, so neither can be claimed by a
 * copy that is not it — the same property `close=creator` rests on (T1-D32).
 *
 * Declared on the table's own marker line, `-- dai:replicated author=creator`,
 * because a role is a property of the table rather than of the link that
 * carries a document, and because the schema is inside the signed artifact and
 * inside what the build already reads — so a role is checked when the document
 * is built, not only when a row is written.
 */
export type AuthorRole = "creator" | "joiner";

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
    const trimmed = comment.trim();
    // `dai:profile session max_parties=N` with an optional ` close=any|creator`.
    const match = /^dai:profile\s+session\s+max_parties\s*=\s*(-?\d+)(\s+close\s*=\s*([a-z]+))?\s*$/i.exec(trimmed);
    if (!/^dai:profile\s+session\b/i.test(trimmed)) continue;
    if (!match) {
      throw new ReplicationError(
        `The session profile "${trimmed}" is malformed. Expected: ` +
          "dai:profile session max_parties=N [close=any|creator].",
      );
    }
    const maxParties = Number(match[1]);
    if (!Number.isInteger(maxParties) || maxParties < 1) {
      throw new ReplicationError(
        `The session profile declares max_parties=${match[1]}. A session holds at least ` +
          "one party; a bound below one is a session nobody can join.",
      );
    }
    const close = (match[3] ?? "any").toLowerCase();
    if (close !== "any" && close !== "creator") {
      throw new ReplicationError(
        `The session profile declares close=${match[3]}. Close is 'any' (any member may end the ` +
          "session) or 'creator' (only the creator may).",
      );
    }
    return { maxParties, close };
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
  /** Tables whose rows only one role may author, when any are declared (D15). */
  authors?: Record<string, AuthorRole>;
  /**
   * Tables whose rows each name the seat they act for, by column, when any are
   * declared (docs/identity.md, step 5): a row is admitted only when its author
   * holds that seat.
   */
  seats?: Record<string, string>;
}

/**
 * Walks SQL, reporting which characters are inside a literal or a comment.
 *
 * Everything here has to be quote-aware for the same reason `normaliseSchema`
 * is: `-- dai:replicated` inside a string is a string, and a `)` inside one
 * does not close anything. Getting this wrong would rewrite a table nobody
 * asked to replicate, or truncate one that is.
 */
function* scan(sql: string): Generator<{ index: number; char: string; code: boolean; comment?: boolean }> {
  let quote: string | null = null;
  let comment: "line" | "block" | null = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (comment === "line") {
      if (char === "\n") comment = null;
      yield { index, char, code: false, comment: char !== "\n" };
      continue;
    }
    if (comment === "block") {
      if (char === "*" && next === "/") {
        yield { index, char, code: false, comment: true };
        index += 1;
        yield { index, char: "/", code: false, comment: true };
        comment = null;
        continue;
      }
      yield { index, char, code: false, comment: true };
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
      yield { index, char, code: false, comment: true };
      continue;
    }
    if (char === "/" && next === "*") {
      comment = "block";
      yield { index, char, code: false, comment: true };
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
/** The text of the `--` comment directly above a table, or null when there is none. */
function markerLineAbove(sql: string, start: number): string | null {
  const before = sql.slice(0, start);
  // Only whitespace may separate the marker from the table it marks: a comment
  // three statements earlier is not a declaration, and treating it as one
  // would replicate a table by accident.
  const trimmed = before.replace(/[ \t\r\n]+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  if (!lastLine.startsWith("--")) return null;
  return lastLine.slice(2).trim();
}

/*
 * A marker's clauses: `author=creator|joiner` (D15) and `seat=<column>`
 * (identity step 5), each at most once, in any order, after
 * `dai:replicated`. Null when the line is not that shape.
 */
function markerClauses(marker: string): Record<string, string> | null {
  const match = /^dai:replicated((?:\s+[A-Za-z]+\s*=\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*$/i.exec(marker);
  if (!match) return null;
  const clauses: Record<string, string> = {};
  for (const clause of match[1]!.matchAll(/([A-Za-z]+)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const key = clause[1]!.toLowerCase();
    if (key !== "author" && key !== "seat") return null;
    if (key in clauses) return null;
    clauses[key] = clause[2]!;
  }
  return clauses;
}

function declaredAbove(sql: string, start: number): boolean {
  const marker = markerLineAbove(sql, start);
  if (marker === null) return false;
  if (marker.toLowerCase() === REPLICATED_MARKER) return true;
  if (!marker.toLowerCase().startsWith(REPLICATED_MARKER)) return false;
  if (markerClauses(marker)) return true;
  /*
   * A marker that begins as one and does not parse is a build failure (D15).
   *
   * It used to compare for exact equality, so `-- dai:replicated foo` simply
   * was not a marker, and its table was built as an ordinary local table:
   * nothing merged, nothing said so. The line names the table's contract, so
   * a line that almost names it is refused rather than quietly ignored.
   */
  throw new ReplicationError(
    `The marker "-- ${marker}" is not one this build understands. A replicated table is marked ` +
      '"-- dai:replicated", with "author=creator" / "author=joiner" to say which party in a session ' +
      'may write it, and "seat=<column>" to name the column holding the seat each row acts for.',
  );
}

/** The role a table's marker names, if it names one (D15). */
function authorAbove(sql: string, start: number): AuthorRole | undefined {
  const marker = markerLineAbove(sql, start);
  const declared = marker === null ? undefined : markerClauses(marker)?.["author"];
  if (!declared) return undefined;
  const role = declared.toLowerCase();
  if (role !== "creator" && role !== "joiner") {
    throw new ReplicationError(
      `A table's marker declares author=${declared}. The author of a table's rows is the session's ` +
        "'creator' (the party that started it) or its 'joiner' (the party that took the invite).",
    );
  }
  return role;
}

/** True when the last line of `text` ends in a `--` comment outside any quote. */
function endsInLineComment(text: string): boolean {
  const line = text.slice(text.lastIndexOf("\n") + 1);
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "-" && line[index + 1] === "-") return true;
  }
  return false;
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
  for (const { char, code, comment } of chars) {
    if (code && char === "(") depth += 1;
    else if (code && char === ")") depth -= 1;
    if (code && char === "," && depth === 0) {
      take(item);
      item = "";
      continue;
    }
    // A comment is blank space here. Kept as text, one written after a comma —
    // `game_id TEXT NOT NULL, -- note` — began the next item, the name was
    // looked for at the start of the comment, and the next column was dropped
    // from the immutability trigger without a sound. Tic-tac-toe shipped that
    // way: `marks.turn` and `marks.cell` could be edited in place, found only
    // when the build started holding the trigger against the engine.
    item += comment ? " " : char;
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
    "  _r_batch      BLOB    CHECK (_r_batch IS NULL OR length(_r_batch) = 16),",
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
 * Whether the session's rule permits the author of close row `close` (T1-D32).
 * A close is a seat action: who may end a session is the same question as who
 * may move. Under close=creator, only the session's creator; under close=any,
 * only a member, one holding a seat in the close's own session (D145). A
 * stranger's close, signed or not, ends nothing. Baked in at compile time, since
 * the rule is known then. Admission's late-row test and `_dai_closed` both read
 * it, so the host, the kit and the apps call a session closed exactly when its
 * rows are judged late.
 */
function closePermitted(close: string, closeCreator: boolean): string {
  return closeCreator
    ? `${close}._r_replica IN (SELECT c.replica FROM _dai_creator c WHERE c.session = ${close}._r_session)`
    : `EXISTS (SELECT 1 FROM _dai_member m WHERE m.session = ${close}._r_session AND m.replica = ${close}._r_replica)`;
}

/**
 * Whether raw `_dai_close` row `close` is a close that counts: written, not a
 * delete (a close cannot be revoked, D153), by an author the rule permits.
 */
function closedBy(close: string, closeCreator: boolean): string {
  return `${close}._r_deleted = 0 AND ${closePermitted(close, closeCreator)}`;
}

/**
 * Not a row id its author signed twice (D160): raw row `row` is at no id
 * `_dai_equivocated` names. Every read that decides what a row counts for
 * shares it, the heads and the seat, confirm and close views alike, so a row
 * signed twice neither shows, nor hides a row, nor seats or closes anyone. The
 * id is the author and the seq, whatever table either header lists it in
 * (batch format version 2, the step 6 review): one counter per author per
 * document, so a seq signed in two tables is signed twice.
 */
function unequivocal(row: string): string {
  // `_dai_equivocated` spelled out against the index, so it is a lookup per row.
  return (
    `NOT EXISTS (SELECT 1 FROM _dai_covers ea JOIN _dai_covers eb` +
    ` ON eb.author = ea.author AND eb.seq = ea.seq AND eb.digest <> ea.digest` +
    ` WHERE ea.author = ${row}._r_replica AND ea.seq = ${row}._r_seq)`
  );
}

/** The most earlier versions one row may name (D159): one head per writer who wrote concurrently, far below this. */
export const PARENTS_CAP = 256;

/**
 * A row's parents as SQL reads them: `text` itself when it is the one shape
 * (docs/format.md, `parents-shape`), and otherwise an empty array, so a copy's
 * own malformed row names nothing (`parents-own-malformed`). Every `json_each`
 * over `_r_parents` reads through this, since `json_each` walks what the shape
 * refuses (257 ids) and throws on what is not JSON or nests past depth 1000,
 * which stopped every read of the heads (the step 6 review, Pass 1). The same
 * test as `wellFormedParents`: JSON text, an array of at most `PARENTS_CAP`
 * strings, each 32 lowercase hex, a colon, and a seq from 1 to 2^53 - 1 with
 * no leading zero (sixteen digits at most, and a sixteen-digit seq compared as
 * text, which for equal lengths is numeric order). A CASE, so `json_each`
 * never sees text that is not valid JSON.
 */
export function parentsSql(text: string): string {
  const id =
    `pe.value GLOB '${"[0-9a-f]".repeat(32)}:[1-9]*' AND length(pe.value) <= 49` +
    ` AND substr(pe.value, 35) NOT GLOB '*[^0-9]*'` +
    ` AND (length(pe.value) < 49 OR substr(pe.value, 34) <= '9007199254740991')`;
  return (
    `(CASE WHEN typeof(${text}) = 'text' AND json_valid(${text}) THEN` +
    ` CASE WHEN json_type(${text}) = 'array' AND json_array_length(${text}) <= ${PARENTS_CAP}` +
    ` AND NOT EXISTS (SELECT 1 FROM json_each(${text}) pe WHERE pe.type <> 'text' OR NOT (${id}))` +
    ` THEN ${text} ELSE '[]' END ELSE '[]' END)`
  );
}

/**
 * Raw row `row` names an equivocated id as a parent (batch format version 2,
 * the step 6 review, X1). Which row that id is differs from copy to copy, so
 * nothing read through it can be the same everywhere: whether it is a version
 * of this row's entity, of its session or of its seat. Such a row is not
 * admitted and not reported, whatever its parents hold on this copy; it
 * neither shows nor hides.
 */
function namesEquivocated(row: string): string {
  return (
    `EXISTS (SELECT 1 FROM json_each(${parentsSql(`${row}._r_parents`)}) ep, _dai_equivocated eq` +
    ` WHERE ep.value = lower(hex(eq.author)) || ':' || eq.seq)`
  );
}

/**
 * The closed sessions, as lowercase hex, for a document whose schema predates
 * `_dai_closed` (D154): the view's own rule, so the host calls a session closed
 * exactly when admission does. Needs the seat views (24 September); a document
 * older than those is not supported (D155).
 */
export function closedSessionsSql(closeCreator: boolean): string {
  return `SELECT DISTINCT lower(hex(x._r_session)) AS s FROM _dai_close x WHERE ${closedBy("x", closeCreator)} ORDER BY 1`;
}

/**
 * The `_heads` view — heads are where admission is enforced (T1-D29).
 *
 * No view reads the stored `_r_superseded` flag (D140). It is a display cache,
 * kept at write (T1-D2), and a cache is decided by whichever rows arrived and in
 * what order: a row of another session naming a binding raised the flag on it
 * and took an ask out of the roster. So every head is computed from the rows,
 * within the row's own partition. A plain table's partition is its entity: a
 * head is a row no row of its entity names. A roster or close table's is its
 * entity, session and author: a seat, an ask, a confirmation or a close speaks
 * only for its author, so only its author's later row in the same session
 * replaces it, never somebody else's. `scripts/check-flag.mjs` fails any read
 * of the flag.
 *
 * A session author table goes further, because **membership is a function of the
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
 * **Cost, to measure before it ships at scale.** A plain table walks each row's
 * entity for a row naming it (the entity index bounds that walk); a session
 * table walks the parents DAG over the admitted subset on every read of
 * `_heads`. Chess is small enough that nobody notices; a tracker with thousands
 * of rows after two years is not. Measure it once at that size, and if it is
 * slow the answer is a materialized membership set recomputed on merge — not a
 * return to the stored flag, which cannot express a membership that changes.
 */
function headsView(
  q: string,
  session: boolean,
  admissionFiltered: boolean,
  closeCreator: boolean,
  author?: AuthorRole,
  seatColumn?: string,
): string {
  if (!admissionFiltered) {
    const ownAuthor = session ? " AND c._r_session = r._r_session AND c._r_replica = r._r_replica" : "";
    return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT r.* FROM ${q} r
   WHERE ${unequivocal("r")}
     AND NOT EXISTS (SELECT 1 FROM ${q} c, json_each(${parentsSql("c._r_parents")}) p
                      WHERE c._r_entity = r._r_entity${ownAuthor} AND ${unequivocal("c")}
                        AND p.value = lower(hex(r._r_replica)) || ':' || r._r_seq);`;
  }
  // A row is admitted when it is a member's row (T1-D29) AND not late relative to
  // its session's close (T1-D31). Both are facts about the current row set, and
  // both can flip as rows arrive, so both are recomputed here rather than stored.
  const member = (row: string): string =>
    `EXISTS (SELECT 1 FROM _dai_member m WHERE m.session = ${row}._r_session AND m.replica = ${row}._r_replica)`;
  // Not late: its author has written no close of this session, the session's
  // rule permitting, before this row (D151). A close binds only its author: it
  // makes the closer's own later rows late, ordered by the closer's own seq, so
  // no signed row removes another person's row. A close carries no frontier
  // (retired at batch format version 2). The raw rows, not `_dai_close_current`:
  // the author's first close is the one that counts (D152), and neither a later
  // version nor a delete of it moves or revokes it (D153). `closedBy`, which
  // `_dai_closed` shares.
  const notLate = (row: string): string =>
    `NOT EXISTS (SELECT 1 FROM _dai_close x WHERE ${closedBy("x", closeCreator)} AND ${unequivocal("x")}` +
    ` AND x._r_session = ${row}._r_session AND x._r_replica = ${row}._r_replica AND x._r_seq < ${row}._r_seq)`;
  /*
   * Who may author this table's rows, when its marker says (D15).
   *
   * The same test `close=creator` puts on a close, put on every row of the
   * table: the seat rows name the session's creator, and a row's author is its
   * key. This is the security property, not the write-surface refusal — it runs
   * over rows that arrived from somebody else's copy, whose consumer may have
   * enforced nothing. A row from the wrong party is simply not admitted, on
   * every copy that holds it, and a wrong-party row cannot supersede a right
   * one either, because `admitted` gates the superseding row too.
   */
  const seatAuthor = (row: string): string =>
    `${row}._r_replica IN (SELECT c.replica FROM _dai_creator c WHERE c.session = ${row}._r_session)`;
  const byRole = (row: string): string =>
    author === "creator" ? ` AND ${seatAuthor(row)}` : author === "joiner" ? ` AND NOT ${seatAuthor(row)}` : "";
  /*
   * A seated table (identity step 5): the row names the seat it acts for, and
   * is admitted only when its author holds that seat, as `_dai_holder` says:
   * the creator's seat is the creator's, and an open seat is held by whoever
   * the creator confirmed in it. No clock is read. A hold, once made, never
   * moves (reseat is refused on a confirmed seat), so "holds" and "held when
   * the row was written" are the same question, and a move written while its
   * author waited to be confirmed is admitted once they are. A row naming no
   * seat, or a seat nobody holds, is not admitted.
   */
  const holds = (row: string): string =>
    `EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = ${row}._r_session` +
    ` AND h.seat = ${row}."${seatColumn}" AND h.replica = ${row}._r_replica)`;
  /*
   * An entity belongs to the session it was written in (D131). A row that names
   * as an earlier version a row of its entity from another session is stored,
   * never admitted, and reported (ENTITY_OTHER_SESSION): nobody replaces or
   * removes a row of a game from a session of their own. Decided by the row set,
   * not by arrival, so every copy answers the same. An author holds a seat of
   * the same bytes in a session of their own for nothing: the seat is the pair.
   */
  const foreign = (row: string): string =>
    `EXISTS (SELECT 1 FROM ${q} fp, json_each(${parentsSql(`${row}._r_parents`)}) fj` +
    ` WHERE fp._r_entity = ${row}._r_entity AND fj.value = lower(hex(fp._r_replica)) || ':' || fp._r_seq` +
    ` AND fp._r_session <> ${row}._r_session)`;
  /*
   * In a seated table a row replaces only rows of its own seat (D132): a version
   * is admitted under the same check as a new row, and a row that names as an
   * earlier version a row of its entity acting for another seat of its session
   * is a row for a seat its author does not hold. Stored, never admitted, and
   * reported as SEAT_NOT_HELD. Without it the seated joiner, holding his own
   * seat honestly, deleted the creator's move by naming it as his row's parent.
   */
  const otherSeat = (row: string): string =>
    `EXISTS (SELECT 1 FROM ${q} sp, json_each(${parentsSql(`${row}._r_parents`)}) sj` +
    ` WHERE sp._r_entity = ${row}._r_entity AND sj.value = lower(hex(sp._r_replica)) || ':' || sp._r_seq` +
    ` AND sp._r_session = ${row}._r_session AND sp."${seatColumn}" IS NOT ${row}."${seatColumn}")`;
  const admitted = (row: string): string =>
    seatColumn
      ? `(${holds(row)}) AND NOT ${foreign(row)} AND NOT ${otherSeat(row)} AND ${notLate(row)}${byRole(row)} AND ${unequivocal(row)} AND NOT ${namesEquivocated(row)}`
      : `(${member(row)}) AND NOT ${foreign(row)} AND ${notLate(row)}${byRole(row)} AND ${unequivocal(row)} AND NOT ${namesEquivocated(row)}`;
  /*
   * Waiting on a confirmation (identity step 5, finding 6): the author asked for
   * an open seat nobody holds yet, in the row's session, and (in a seated table)
   * the row names that seat. Neither admitted nor refused; a fact about the row
   * set, the same on every copy, so an application shows its own waiting rows
   * from `_pending` and never from the table itself.
   */
  const waiting = (row: string): string =>
    `EXISTS (SELECT 1 FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat` +
    ` WHERE b._r_session = ${row}._r_session AND b._r_replica = ${row}._r_replica` +
    (seatColumn ? ` AND b.seat = ${row}."${seatColumn}"` : "") +
    ` AND NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat))`;
  const pendingRow = (row: string): string =>
    `${waiting(row)} AND NOT ${foreign(row)}${seatColumn ? ` AND NOT ${otherSeat(row)}` : ""} AND ${notLate(row)}${byRole(row)} AND ${unequivocal(row)} AND NOT ${namesEquivocated(row)}`;
  // Only a row of r's own entity can supersede it (T1-D35), only one of r's
  // own session (D131), and in a seated table only one of r's own seat (D132).
  const supersededBy = (row: string, gate: string): string =>
    `EXISTS (
       SELECT 1 FROM ${q} c, json_each(${parentsSql("c._r_parents")}) p
        WHERE c._r_entity = ${row}._r_entity AND c._r_session = ${row}._r_session${seatColumn ? ` AND c."${seatColumn}" = ${row}."${seatColumn}"` : ""}
          AND ${gate}
          AND p.value = lower(hex(${row}._r_replica)) || ':' || ${row}._r_seq
     )`;
  // A waiting row is superseded within its own partition, never by the stored
  // flag (D138), and only by an admitted row or a waiting row of its own
  // author (D142): another asker's row may never be admitted, so it neither
  // hides nor forks this one. `_waiting` keeps tombstones, as `_heads` does, so
  // a writer versions its own waiting delete (D143); `_pending` is what a screen
  // shows, as `_current` is. A row already admitted is not waiting (D148): a
  // member who also asks for a seat nobody holds sees each row once.
  return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT r.* FROM ${q} r
   WHERE ${admitted("r")}
     AND NOT ${supersededBy("r", admitted("c"))};

CREATE VIEW IF NOT EXISTS ${q}_waiting AS
  SELECT r.* FROM ${q} r
   WHERE ${pendingRow("r")} AND NOT (${admitted("r")})
     AND NOT ${supersededBy("r", `((${admitted("c")}) OR (c._r_replica = r._r_replica AND ${pendingRow("c")}))`)};

CREATE VIEW IF NOT EXISTS ${q}_pending AS
  SELECT * FROM ${q}_waiting WHERE _r_deleted = 0;

-- What a merge reports as ENTITY_OTHER_SESSION (D131): a row naming as an
-- earlier version a row of its entity from another session, with that parent.
-- Not a row naming an equivocated id, which is reported nowhere.
CREATE VIEW IF NOT EXISTS ${q}_foreign AS
  SELECT r._r_replica, r._r_seq, r._r_batch, fp._r_replica AS parent_replica, fp._r_seq AS parent_seq
    FROM ${q} r, ${q} fp, json_each(${parentsSql("r._r_parents")}) fj
   WHERE fp._r_entity = r._r_entity AND fj.value = lower(hex(fp._r_replica)) || ':' || fp._r_seq
     AND fp._r_session <> r._r_session AND NOT ${namesEquivocated("r")};` +
    (seatColumn
      ? `
-- What a merge reports as SEAT_NOT_HELD (identity step 5): a row that names no
-- seat, or a seat someone else holds, or that names as its earlier version a
-- row acting for another seat of its session (D132). A row for a seat nobody
-- holds yet is pending, waiting on the creator's confirmation, and is neither
-- admitted nor reported; nor is a row naming an equivocated id as a parent.
CREATE VIEW IF NOT EXISTS ${q}_unseated AS
  SELECT r._r_replica, r._r_seq, r._r_batch FROM ${q} r
   WHERE (typeof(r."${seatColumn}") <> 'blob' OR length(r."${seatColumn}") <> 16
      OR (EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = r._r_session AND h.seat = r."${seatColumn}")
          AND NOT (${holds("r")}))
      OR ${otherSeat("r")})
     AND NOT ${namesEquivocated("r")};

-- The same crossing with the row it names, so a merge reports it whichever of
-- the two arrived (D132).
CREATE VIEW IF NOT EXISTS ${q}_other_seat AS
  SELECT r._r_replica, r._r_seq, r._r_batch, sp._r_replica AS parent_replica, sp._r_seq AS parent_seq
    FROM ${q} r, ${q} sp, json_each(${parentsSql("r._r_parents")}) sj
   WHERE sp._r_entity = r._r_entity AND sj.value = lower(hex(sp._r_replica)) || ':' || sp._r_seq
     AND sp._r_session = r._r_session AND sp."${seatColumn}" IS NOT r."${seatColumn}"
     AND NOT ${namesEquivocated("r")};`
      : "");
}

function tableObjects(
  name: string,
  authored: string[],
  session: boolean,
  admissionFiltered: boolean,
  closeCreator = false,
  author?: AuthorRole,
  seatColumn?: string,
): string {
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
    // A row's session is fixed at write and never edited, like every other _r_
    // column, so the append-only trigger names it too (T1-D26).
    ...(session ? ["_r_session"] : []),
  ].join(", ");
  /*
   * What one row's versions are: its entity, and in an admission-filtered
   * session table its entity in its session (D131), and in a seated table in
   * its seat too (D132). A row of another session or seat that reuses an
   * entity's id is another entity there, so it neither hides nor displaces this
   * one's current version. A roster or close table's rows speak for their
   * author, so its versions are its entity in its session by its author
   * (D140). Plain tables keep the entity alone.
   */
  const keys = admissionFiltered
    ? ["_r_entity", "_r_session", ...(seatColumn ? [`"${seatColumn}"`] : [])]
    : session
      ? ["_r_entity", "_r_session", "_r_replica"]
      : ["_r_entity"];
  const partition = (alias: string): string => keys.map((k) => (alias ? `${alias}.${k}` : k)).join(", ");
  const samePart = (a: string, b: string): string => keys.map((k) => `${a}.${k} = ${b}.${k}`).join(" AND ");
  return `
CREATE INDEX IF NOT EXISTS ${q}__r_entity ON ${q}(_r_entity, _r_lc);

CREATE TRIGGER IF NOT EXISTS ${q}__no_update BEFORE UPDATE OF
    ${immutable} ON ${q}
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

-- A row is sealed once: _r_batch goes from NULL (pending) to the id of the
-- signed batch it left in, and is never changed after that.
CREATE TRIGGER IF NOT EXISTS ${q}__sealed_once BEFORE UPDATE OF _r_batch ON ${q}
  WHEN OLD._r_batch IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

-- And only to a batch whose signed header this copy holds, however the row got
-- here: a seal, a merge, or application SQL. A header is written before any row
-- names it (the seal, staging and the merge all do that), so a row naming one
-- that is absent is a row claiming a signature nobody gave.
CREATE TRIGGER IF NOT EXISTS ${q}__batch_known_insert BEFORE INSERT ON ${q}
  WHEN NEW._r_batch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _dai_batch WHERE id = NEW._r_batch)
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE: _r_batch names no header in _dai_batch'); END;
CREATE TRIGGER IF NOT EXISTS ${q}__batch_known_update BEFORE UPDATE OF _r_batch ON ${q}
  WHEN NEW._r_batch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM _dai_batch WHERE id = NEW._r_batch)
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE: _r_batch names no header in _dai_batch'); END;

-- Append-only, with one exception: a signed row outranks an unsigned row at
-- the same id. (author, seq) names one row whatever table it sits in, so an
-- unsigned row whose id a header this copy holds lists, in any table, is an
-- impostor at a signed id, and the merge removes it to take the signed one.
CREATE TRIGGER IF NOT EXISTS ${q}__no_delete BEFORE DELETE ON ${q}
  WHEN NOT (OLD._r_batch IS NULL AND EXISTS (
    SELECT 1 FROM _dai_batch b, json_each(b.covers) c
     WHERE b.author = OLD._r_replica AND json_extract(c.value, '$[1]') = OLD._r_seq))
  BEGIN SELECT RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE'); END;

-- Superseded exactly while some row of its own entity names it (T1-D2, T1-D35):
-- a flag that is a function of the row set. It goes back to 0 only when nothing
-- names the row any more, which happens only when an unsigned row that named it
-- gave way to a signed one.
CREATE TRIGGER IF NOT EXISTS ${q}__superseded_monotonic BEFORE UPDATE OF _r_superseded ON ${q}
  WHEN OLD._r_superseded = 1 AND NEW._r_superseded = 0 AND EXISTS (
    SELECT 1 FROM ${q} n, json_each(${parentsSql("n._r_parents")}) p
     WHERE n._r_entity = OLD._r_entity
       AND p.value = lower(hex(OLD._r_replica)) || ':' || OLD._r_seq)
  BEGIN SELECT RAISE(ABORT, 'ROW_REJECTED'); END;

${headsView(q, session, admissionFiltered, closeCreator, author, seatColumn)}

CREATE VIEW IF NOT EXISTS ${q}_conflicts AS
  SELECT _r_entity, count(*) AS heads,
         json_group_array(hex(_r_replica) || ':' || _r_seq) AS head_ids
  FROM ${q}_heads GROUP BY ${partition("")} HAVING count(*) > 1;

CREATE VIEW IF NOT EXISTS ${q}_current AS
  SELECT h.*,
         (SELECT count(*) FROM ${q}_heads x WHERE ${samePart("x", "h")}) > 1
           AS _r_conflicted
  FROM ${q}_heads h
  WHERE h._r_deleted = 0
    AND h._r_replica || ':' || h._r_seq = (
      SELECT y._r_replica || ':' || y._r_seq FROM ${q}_heads y
       WHERE ${samePart("y", "h")} AND y._r_deleted = 0
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
function documentTables(session: boolean, closeCreator = false): string {
  const base = `
CREATE TABLE IF NOT EXISTS _dai_replica (
  id    BLOB PRIMARY KEY CHECK (length(id) = 16),
  seq   INTEGER NOT NULL DEFAULT 0,
  lc    INTEGER NOT NULL DEFAULT 0,
  label TEXT
);

-- The signed batch headers (docs/identity.md): one row per batch any copy of
-- this document sealed. A row in a replicated table names its batch by id; the
-- signature covers [version, document, author, lc, digest, covers] and the
-- digest covers the rows. pub is the author's raw public key, which the author
-- id must fingerprint to; att is reserved for an authority's attestation and
-- is outside the signature, so vouching can arrive later without re-signing.
-- covers lists the rows the batch covers, as a JSON array of [table, seq]
-- (the author is the header's), signed since batch format 2 (D161): a merge
-- finds a batch's rows from it, never by trusting a row's _r_batch, which a
-- lost save can leave unset (docs/format.md).
CREATE TABLE IF NOT EXISTS _dai_batch (
  id      BLOB PRIMARY KEY CHECK (length(id) = 16),
  author  BLOB NOT NULL CHECK (length(author) = 16),
  lc      INTEGER NOT NULL,
  sig     BLOB NOT NULL,
  pub     BLOB NOT NULL,
  att     BLOB,
  version INTEGER NOT NULL,
  digest  BLOB NOT NULL CHECK (length(digest) = 32),
  covers  TEXT NOT NULL
);

-- Each header's listings, one row per (header, table, seq), so a row's headers
-- are an index lookup and not a walk of every header's JSON. LOCAL and derived:
-- a pure function of _dai_batch, kept by these triggers from the header alone,
-- so no arrival order can make it say anything the headers do not. Outside the
-- canonical dump, like every derived thing.
CREATE TABLE IF NOT EXISTS _dai_covers (
  tbl    TEXT NOT NULL,
  author BLOB NOT NULL,
  seq    INTEGER NOT NULL,
  id     BLOB NOT NULL,
  digest BLOB NOT NULL,
  PRIMARY KEY (tbl, author, seq, id)
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS _dai_batch__covers_insert AFTER INSERT ON _dai_batch
  BEGIN
    INSERT OR IGNORE INTO _dai_covers (tbl, author, seq, id, digest)
      SELECT json_extract(c.value, '$[0]'), NEW.author, json_extract(c.value, '$[1]'), NEW.id, NEW.digest
        FROM json_each(CASE WHEN json_valid(NEW.covers) THEN NEW.covers ELSE '[]' END) c;
  END;
CREATE TRIGGER IF NOT EXISTS _dai_batch__covers_update AFTER UPDATE ON _dai_batch
  BEGIN
    DELETE FROM _dai_covers WHERE id = OLD.id;
    INSERT OR IGNORE INTO _dai_covers (tbl, author, seq, id, digest)
      SELECT json_extract(c.value, '$[0]'), NEW.author, json_extract(c.value, '$[1]'), NEW.id, NEW.digest
        FROM json_each(CASE WHEN json_valid(NEW.covers) THEN NEW.covers ELSE '[]' END) c;
  END;
CREATE TRIGGER IF NOT EXISTS _dai_batch__covers_delete AFTER DELETE ON _dai_batch
  BEGIN DELETE FROM _dai_covers WHERE id = OLD.id; END;

-- The same listings by row id, for the reads that ask by author and seq alone.
CREATE INDEX IF NOT EXISTS _dai_covers_by_id ON _dai_covers (author, seq);

-- The row ids an author signed twice (D160): two headers of one author listing
-- one seq, in any tables, with different digests (batch format version 2: the
-- seq is one counter per author per document, so a seq signed in two tables is
-- signed twice). Neither row at such an id is admitted anywhere, on any copy
-- holding both headers, whichever arrived first; so the evidence is the
-- headers, which every copy keeps and passes on. One line per table a header
-- lists the id in.
CREATE VIEW IF NOT EXISTS _dai_equivocated AS
  SELECT DISTINCT a.author AS author, a.tbl AS tbl, a.seq AS seq
    FROM _dai_covers a JOIN _dai_covers b
      ON b.author = a.author AND b.seq = a.seq AND b.digest <> a.digest;

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
  const rosterTable = (name: string, extra = "", authored = ["seat"]): string =>
    `CREATE TABLE IF NOT EXISTS ${name} (\n  seat BLOB NOT NULL CHECK (length(seat) = 16),\n${extra}${replicationColumns(true)}\n) WITHOUT ROWID;\n` +
    tableObjects(name, authored, true, false);

  /*
   * The seat model (identity step 5, ruled 24 September). No clock decides
   * anything in it.
   *
   * - The session id commits to its creator's seat row: SHA-256(creator ‖
   *   seq), first 16 bytes, the seq being that row's own (D158). `_dai_creator`
   *   is that one row: a seat row whose own author and seq hash to its session
   *   (`dai_session_id`, src/session-id.ts). Only the creator can write it, and
   *   she can write it once; checked here, at read, over every row this copy
   *   holds however it arrived.
   * - The creator's seat is the seat on that row, and it is the creator's by
   *   definition. A binding to it means nothing.
   * - Every other seat the creator mints is open, and is held by whoever the
   *   creator confirms, in `_dai_confirm`, which only the creator's rows count
   *   in. A joiner's binding asks for a seat; it holds nothing until then. One
   *   confirm per seat per creator (D165): two of her confirms of one seat
   *   naming different copies void each other, whatever their seqs and
   *   whichever arrived first, and nobody holds the seat (`_dai_voided`). A
   *   confirmed seat is never reseated, so two confirms are two conflicting
   *   claims about one thing, as two rows at one id are (D160); the repair is
   *   a new session.
   *
   * Nothing here is ordered by a clock, so a backdated row gains nothing, and a
   * hold, once made, never moves: the repair (reseat) is refused on a seat
   * anyone has been confirmed in. A row's author is its key once its batch is
   * verified, and a merge refuses an unsigned row (BATCH_UNSIGNED): first in
   * these three tables and the close (D133, D147), and in every table from
   * batch format version 2.
   */
  const member = `
-- The creator's seat row is the one row the session id names, by its own
-- (author, seq) (D158): no other row of the creator's, and no later version of
-- that row, is it. One row, so one creator and one creator's seat.
CREATE VIEW IF NOT EXISTS _dai_creator AS
  SELECT DISTINCT s._r_session AS session, s._r_replica AS replica, s.seat AS seat, s._r_entity AS entity
    FROM _dai_seat s
   WHERE s._r_deleted = 0 AND ${unequivocal("s")}
     AND ${SESSION_ID_FUNCTION}(s._r_replica, s._r_seq) = s._r_session;

-- The open seats the creator minted, each at its current value among her own
-- versions in that session: a version another author wrote of her seat row is
-- not hers, and neither is one in another session (D136). Not the creator's
-- seat row, nor any version of its entity.
CREATE VIEW IF NOT EXISTS _dai_open_seat AS
  SELECT s._r_session AS session, s.seat AS seat, s._r_entity AS entity
    FROM _dai_seat s
    JOIN _dai_creator c ON c.session = s._r_session AND c.replica = s._r_replica
   WHERE s._r_entity <> c.entity AND s._r_deleted = 0 AND ${unequivocal("s")}
     AND s.seat NOT IN (SELECT k.seat FROM _dai_creator k WHERE k.session = s._r_session)
     AND NOT EXISTS (SELECT 1 FROM _dai_seat n, json_each(${parentsSql("n._r_parents")}) p
                      WHERE n._r_entity = s._r_entity AND n._r_replica = s._r_replica AND n._r_session = s._r_session
                        AND ${unequivocal("n")}
                        AND p.value = lower(hex(s._r_replica)) || ':' || s._r_seq);

-- The creator's confirms of an open seat: her rows in her session, not of her
-- own seat, not at an id she signed twice. Deleted or not, superseded or not
-- (D171): a confirm is her statement that she seated a copy, and a hold never
-- moves once made, so a later version or a delete of one is another confirm.
CREATE VIEW IF NOT EXISTS _dai_confirmed AS
  SELECT f._r_session AS session, f.seat AS seat, f.holder AS holder, f._r_seq AS seq, f._r_replica AS creator
    FROM _dai_confirm f
    JOIN _dai_creator c ON c.session = f._r_session AND c.replica = f._r_replica
   WHERE ${unequivocal("f")}
     AND f.seat NOT IN (SELECT k.seat FROM _dai_creator k WHERE k.session = f._r_session);

-- The seats the creator confirmed to two different copies (D165): void, held by
-- nobody, on every copy holding both confirms, whichever arrived first.
CREATE VIEW IF NOT EXISTS _dai_voided AS
  SELECT DISTINCT f.session AS session, f.seat AS seat, f.creator AS creator
    FROM _dai_confirmed f
   WHERE EXISTS (SELECT 1 FROM _dai_confirmed o WHERE o.session = f.session AND o.seat = f.seat AND o.holder <> f.holder);

CREATE VIEW IF NOT EXISTS _dai_holder AS
  SELECT c.session AS session, c.seat AS seat, c.replica AS replica, 0 AS since
    FROM _dai_creator c
  UNION
  SELECT f.session, f.seat, f.holder, min(f.seq)
    FROM _dai_confirmed f
   WHERE NOT EXISTS (SELECT 1 FROM _dai_voided v WHERE v.session = f.session AND v.seat = f.seat)
   GROUP BY f.session, f.seat, f.holder;

-- The seats nobody may be confirmed in until the creator repairs them: an open
-- seat nobody holds that two or more copies asked for (voided 0: reseat is the
-- repair), and a seat the creator confirmed twice (voided 1: a new session is).
-- Every reader of "contested" reads this: the kit, reseat and the apps.
CREATE VIEW IF NOT EXISTS _dai_contested AS
  SELECT s.session AS session, s.seat AS seat, 0 AS voided
    FROM _dai_open_seat s
   WHERE NOT EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = s.session AND h.seat = s.seat)
     AND NOT EXISTS (SELECT 1 FROM _dai_voided v WHERE v.session = s.session AND v.seat = s.seat)
     AND (SELECT count(DISTINCT b._r_replica) FROM _dai_binding_current b
           WHERE b._r_session = s.session AND b.seat = s.seat) > 1
  UNION
  SELECT session, seat, 1 FROM _dai_voided;

CREATE VIEW IF NOT EXISTS _dai_member AS
  SELECT DISTINCT session, replica FROM _dai_holder;

-- The closed sessions: a close the session's rule permits names them (D146).
-- Every reader of "is this session closed" (the host, the kit, the apps)
-- reads this, never _dai_close_current, so it agrees with admission, which
-- drops the closer's later rows by the same rule. A delete of a close does
-- not reopen the session (D153).
CREATE VIEW IF NOT EXISTS _dai_closed AS
  SELECT DISTINCT x._r_session AS session FROM _dai_close x
   WHERE ${closedBy("x", closeCreator)} AND ${unequivocal("x")};
`;

  /*
   * The session close (T1-D31, amended by D151). A session is closed when a
   * close its rule permits names it; the close binds only its author, whose
   * rows after their first close are late. A close is one row carrying its
   * session and nothing else. Its frontier (a `replica` and `seq` per author the
   * closer had seen) retired with batch format version 2: signing proved who
   * wrote a close and could not prove the list, so the list stopped mattering
   * (D151), and a column nothing reads is a column somebody will read. Like the
   * roster tables, its own heads are not admission-filtered.
   */
  const close =
    `CREATE TABLE IF NOT EXISTS _dai_close (\n${replicationColumns(true)}\n) WITHOUT ROWID;\n` +
    tableObjects("_dai_close", [], true, false);

  return (
    base +
    rosterTable("_dai_seat") +
    rosterTable("_dai_binding") +
    rosterTable("_dai_confirm", "  holder BLOB NOT NULL CHECK (length(holder) = 16),\n", ["seat", "holder"]) +
    close +
    member
  );
}

/**
 * The declared roles, as a view the frame's write surface can read (D15).
 *
 * The admission view already holds a role's rows back at merge. A write that
 * breaks a role should also be refused as it is made, by name, so the author
 * learns at once rather than watching a row vanish — and the frame can only do
 * that from what the document itself carries. This is schema, so it is signed
 * with the rest, and it is emitted only when a role is declared: a document
 * without one rewrites to exactly the text it always did.
 */
function authorRulesView(authors: Record<string, AuthorRole>): string {
  const entries = Object.entries(authors);
  if (entries.length === 0) return "";
  // Table names here matched an identifier pattern when they were parsed, so
  // they are safe inside single quotes.
  const rows = entries.map(([table, role]) => `SELECT '${table}' AS tbl, '${role}' AS author`).join("\n  UNION ALL ");
  return `
CREATE VIEW IF NOT EXISTS _dai_author_rules AS
  ${rows};
`;
}

/**
 * The seated tables and their seat columns, as a view the merge and the write
 * surface can read (identity step 5). Schema, so signed with the rest; emitted
 * only when a table names a seat column.
 */
function seatRulesView(seats: Record<string, string>): string {
  const entries = Object.entries(seats);
  if (entries.length === 0) return "";
  // Table and column names matched an identifier pattern when parsed.
  const rows = entries.map(([table, column]) => `SELECT '${table}' AS tbl, '${column}' AS col`).join("\n  UNION ALL ");
  return `
CREATE VIEW IF NOT EXISTS _dai_seat_rules AS
  ${rows};
`;
}

/**
 * The seat tables: who created a session, who asked for its open seat, and whom
 * the creator confirmed in it.
 */
export const SEAT_TABLES = ["_dai_seat", "_dai_binding", "_dai_confirm"] as const;

/**
 * The replicated system tables a session document carries beside its author
 * tables (T1-D29): the seat tables and the close. A merge refuses an unsigned
 * row in them (BATCH_UNSIGNED, D133, D147) as in every table, because an
 * unsigned row is a row under an id nobody proved; here it would decide a seat
 * or end a session, which is why the refusal began here.
 */
export const SESSION_SYSTEM_TABLES = [...SEAT_TABLES, "_dai_close"] as const;

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
  const named = found[1]!.split(",").map((name) => name.trim()).filter(Boolean);
  // _r_batch is guarded by a trigger of its own, which lets it change once,
  // from NULL (identity step 3). It counts as covered only when that trigger
  // is actually in the SQL, so a build without the guard is still refused.
  const sealedOnce = new RegExp(
    `CREATE TRIGGER (?:IF NOT EXISTS )?${table}__sealed_once BEFORE UPDATE OF _r_batch ON ${table}\\b[\\s\\S]*?WHEN OLD\\._r_batch IS NOT NULL`,
  ).test(sql);
  return sealedOnce ? [...named, "_r_batch"] : named;
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

  // Which role may author each table, from its own marker line (D15).
  const authors: Record<string, AuthorRole> = {};
  for (const span of declared) {
    const role = authorAbove(sql, span.start);
    if (role) authors[span.name] = role;
  }
  if (Object.keys(authors).length > 0 && !session) {
    // A role is a party in a session — the creator is whoever minted its seats —
    // so a role in a document with no session names nobody, and would admit
    // nothing. Refused at build rather than shipped as a table nobody can write.
    throw new ReplicationError(
      `${Object.keys(authors).join(", ")} declare${Object.keys(authors).length === 1 ? "s" : ""} an author ` +
        "role, but the document has no session profile. A role names a party in a session; add " +
        "-- dai:profile session max_parties=N, or drop the role.",
    );
  }

  // Which column names the seat each row acts for, from the same marker (step 5).
  const seats: Record<string, string> = {};
  for (const span of declared) {
    const marker = markerLineAbove(sql, span.start);
    const column = marker === null ? undefined : markerClauses(marker)?.["seat"];
    if (!column) continue;
    if (!authorColumns(sql.slice(span.open + 1, span.close)).includes(column)) {
      throw new ReplicationError(
        `${span.name} names seat=${column}, and has no column ${column}. The seat column holds the seat ` +
          "each row acts for; declare it in the table.",
      );
    }
    seats[span.name] = column;
  }
  if (Object.keys(seats).length > 0 && !session) {
    // A seat belongs to a session: with no session there are no seats, and a
    // seated table would admit nothing.
    throw new ReplicationError(
      `${Object.keys(seats).join(", ")} name${Object.keys(seats).length === 1 ? "s" : ""} a seat column, but the ` +
        "document has no session profile. Seats belong to a session; add -- dai:profile session " +
        "max_parties=N, or drop the seat clause.",
    );
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
    /*
     * On this table's own statement, not on the gap before it.
     *
     * This used to test and edit `sql.slice(cursor, span.open + 1)` — everything
     * since the previous replicated table. So an `IF NOT EXISTS` on any earlier
     * statement in that gap (a local table, an index) counted as this table's,
     * and when it was absent the keyword went onto the *first* CREATE TABLE in
     * the gap, which could be a local table rather than this one. Either way the
     * replicated table stayed a bare CREATE, and the schema, which runs on every
     * open, refused its second open. It never bit while replicated tables sat
     * where their gap held nothing else; appending two after chess's local tables
     * found it, and the build's load-it-twice check refused the document.
     * `span.start` is this statement's own CREATE, found in the quote-aware copy.
     */
    const own = sql.slice(span.start, span.open + 1);
    out += /\bIF\s+NOT\s+EXISTS\b/i.test(own)
      ? sql.slice(cursor, span.open + 1)
      : sql.slice(cursor, span.start) + own.replace(/\bCREATE\s+TABLE\s+/i, (kw) => `${kw}IF NOT EXISTS `);
    // A line comment on the author's last line would swallow a comma appended
    // after it, and the table would build and then refuse to open. The comma
    // goes on its own line in that case only, so every schema that already
    // worked rewrites to exactly the text it did before — and its digest with it.
    const separator = endsInLineComment(authorBody) ? "\n," : ",";
    out += `${authorBody}${separator}\n${replicationColumns(session !== null)}\n)${tail}`;
    // Author tables are admission-filtered in a session document: their heads
    // are recomputed over the members' rows (T1-D29), and the close policy is
    // baked into the late-row predicate (T1-D32). The roster tables that carry
    // the membership are not admission-filtered — emitted by documentTables.
    out += tableObjects(
      span.name,
      authorColumns(body),
      session !== null,
      session !== null,
      session?.close === "creator",
      authors[span.name],
      seats[span.name],
    );
    cursor = span.end;
  }
  out += sql.slice(cursor);

  return {
    sql: documentTables(session !== null, session?.close === "creator") + out + authorRulesView(authors) + seatRulesView(seats),
    // Author tables only — the manifest's `replication.tables` surface, and what
    // the sibling test reads. The roster tables (`SESSION_SYSTEM_TABLES`) are in
    // the schema and the digest but not this list; they are implicit in a session
    // document the way `_dai_replica` is, and the runtime appends them to the
    // replicated set for merge and export (T1-D29, spec §3 example).
    tables: declared.map((span) => span.name),
    ...(session ? { session } : {}),
    ...(Object.keys(authors).length > 0 ? { authors } : {}),
    ...(Object.keys(seats).length > 0 ? { seats } : {}),
  };
}
