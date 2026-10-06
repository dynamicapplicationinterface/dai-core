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
 * Whether the session's rule permits the author of close row `close`, for a
 * document built before the creator's seat row declared the rule (R14): baked
 * in at compile time, as it was then. Under close=creator, only the session's
 * creator; under close=any, only a member (D145). `closedSessionsSql` is its
 * one reader.
 */
function closePermitted(close: string, closeCreator: boolean): string {
  return closeCreator
    ? `${close}._r_replica IN (SELECT c.replica FROM _dai_creator c WHERE c.session = ${close}._r_session)`
    : `EXISTS (SELECT 1 FROM _dai_member m WHERE m.session = ${close}._r_session AND m.replica = ${close}._r_replica)`;
}

/**
 * Not a row id its author signed twice (D160): raw row `row` is at no id
 * `_dai_equivocated` names. A plain document's heads read it, so a row signed
 * twice neither shows nor hides a row. The id is the author and the seq,
 * whatever table either header lists it in (batch format version 2, the step
 * 6 review): one counter per author per document, so a seq signed in two
 * tables is signed twice. In a session document every rule reads the author
 * instead (`notEquivocator`), which implies this.
 */
function unequivocal(row: string): string {
  // `_dai_equivocated` spelled out against the index, so it is a lookup per row.
  return (
    `NOT EXISTS (SELECT 1 FROM _dai_covers ea JOIN _dai_covers eb` +
    ` ON eb.author = ea.author AND eb.seq = ea.seq AND eb.digest <> ea.digest` +
    ` WHERE ea.author = ${row}._r_replica AND ea.seq = ${row}._r_seq)`
  );
}

/**
 * The author `author` (a column) signed no two headers listing one seq with different
 * digests anywhere in the document: the headers alone, before any close is
 * read. What the views that decide equivocation by a close (R18) start from,
 * so that decision never reads itself.
 */
function notHeaderEquivocator(author: string): string {
  return `${author} NOT IN (SELECT author FROM _dai_equivocated)`;
}

/**
 * Not an equivocator's row (R10, R17, R18): raw row `row`'s author is not in
 * `_dai_equivocator`, who signed two headers at one seq or wrote in a session
 * after a close of theirs there that counts. An equivocator's seat, binding,
 * confirm and close rows count for nothing, he holds no seat and none of his
 * rows is admitted or reported, so no second statement takes back one he made
 * and leaves the rest of his standing.
 */
function notEquivocator(row: string): string {
  // Uncorrelated, so the set is built once per statement, however many rows ask.
  return `${row}._r_replica NOT IN (SELECT author FROM _dai_equivocator)`;
}

/**
 * Raw row `row` is in a live session: one whose creator's seat row is held, not
 * deleted, valid and by no equivocator (`_dai_creator`). Only there is a row
 * admitted or reported; a void session, and one with no live creator's seat
 * row, admit and report nothing (R14, R20).
 */
function inLiveSession(row: string): string {
  return `${row}._r_session IN (SELECT session FROM _dai_creator)`;
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
 *
 * When `text` is a row's own column (`<alias>._r_parents`), a parent naming
 * that row's own author at a seq at or above the row's own is malformed too
 * (R19, `parent-forward`): an honest writer names only rows it already wrote.
 */
export function parentsSql(text: string): string {
  const id =
    `pe.value GLOB '${"[0-9a-f]".repeat(32)}:[1-9]*' AND length(pe.value) <= 49` +
    ` AND substr(pe.value, 35) NOT GLOB '*[^0-9]*'` +
    ` AND (length(pe.value) < 49 OR substr(pe.value, 34) <= '9007199254740991')`;
  const row = /^([A-Za-z_][A-Za-z0-9_]*)\._r_parents$/.exec(text)?.[1];
  const forward = row
    ? ` OR (substr(pe.value, 1, 32) = lower(hex(${row}._r_replica)) AND CAST(substr(pe.value, 34) AS INTEGER) >= ${row}._r_seq)`
    : "";
  return (
    `(CASE WHEN typeof(${text}) = 'text' AND json_valid(${text}) THEN` +
    ` CASE WHEN json_type(${text}) = 'array' AND json_array_length(${text}) <= ${PARENTS_CAP}` +
    ` AND NOT EXISTS (SELECT 1 FROM json_each(${text}) pe WHERE pe.type <> 'text' OR NOT (${id})${forward})` +
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
 * Raw row `row` names as a parent an id this copy holds no row at, in any
 * table (R21, D189): it waits on that parent. Which row the id is, and so
 * whether the row crosses a session or a seat through it, is not known until
 * the parent is held, so the row is neither admitted nor reported until then;
 * once it is held, the existing rules decide, once. `held` is every row id the
 * copy holds (`waitingParentView`).
 */
function awaitsParent(row: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${parentsSql(`${row}._r_parents`)}) wp WHERE wp.value NOT IN held)`;
}

/**
 * The rows of a session document's author tables waiting on a parent (R21),
 * by id: one view for the document, since its schema travels in every copy
 * and an inline link has a length cap. `held` is every row id it holds, in
 * every replicated table, spelled as `_r_parents` spells it: one id per
 * `(author, seq)` across tables for signed rows (row-one-id), so a parent held
 * in another table is held, and is no version of the row that names it. A row
 * at an id two tables hold is at an equivocated id, and admitted nowhere.
 */
function waitingParentView(tables: readonly string[], authorTables: readonly string[]): string {
  const held = tables.map((t) => `SELECT lower(hex(_r_replica))||':'||_r_seq FROM "${t}"`).join(" UNION ALL ");
  const rows = authorTables.map((t) => `SELECT r._r_replica, r._r_seq FROM "${t}" r WHERE ${awaitsParent("r")}`).join(" UNION ALL ");
  return `
CREATE VIEW IF NOT EXISTS _dai_waiting_parent AS WITH held(id) AS (${held}) ${rows};
`;
}

/**
 * The closed sessions, as lowercase hex, for a document whose schema predates
 * `_dai_closed` (D154): the view's own rule, so the host calls a session closed
 * exactly when admission does. Needs the seat views (24 September); a document
 * older than those is not supported (D155). Its `_dai_creator` has no seq, and
 * such a document predates R13, so the rule is the one it was built under.
 */
export function closedSessionsSql(closeCreator: boolean): string {
  return `SELECT DISTINCT lower(hex(x._r_session)) AS s FROM _dai_close x WHERE x._r_deleted = 0 AND ${closePermitted("x", closeCreator)} ORDER BY 1`;
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
  author?: AuthorRole,
  seatColumn?: string,
): string {
  if (!admissionFiltered) {
    /*
     * The roster and the close (session) and a plain document's tables. A
     * roster or close row by an equivocator counts for nothing (R10): no head,
     * and it hides nothing; a plain table's row, only at its own id. In
     * `_dai_seat` only the creator's seat rows count (R14): every other seat
     * row, a later version of one included, is no head and hides nothing, so
     * a creator's seat row is a head whatever names it.
     */
    if (q === "_dai_seat") {
      return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT r.* FROM ${q} r
   WHERE ${notEquivocator("r")}
     AND (r._r_replica, r._r_seq, r._r_session) IN (SELECT replica, seq, session FROM _dai_creator_row);`;
    }
    const ownAuthor = session ? " AND c._r_session = r._r_session AND c._r_replica = r._r_replica" : "";
    const counts = session ? notEquivocator : unequivocal;
    return `CREATE VIEW IF NOT EXISTS ${q}_heads AS
  SELECT r.* FROM ${q} r
   WHERE ${counts("r")}
     AND NOT EXISTS (SELECT 1 FROM ${q} c, json_each(${parentsSql("c._r_parents")}) p
                      WHERE c._r_entity = r._r_entity${ownAuthor} AND ${counts("c")}
                        AND p.value = lower(hex(r._r_replica)) || ':' || r._r_seq);`;
  }
  // A row is admitted when its author is a member of its session (T1-D29),
  // and in a seated table holds the seat it names. Both are facts about the
  // current row set, and both can flip as rows arrive, so both are recomputed
  // here rather than stored. Neither reads a clock or ranks two seqs of one
  // author: `late` retired with R18, which makes a row after its author's
  // close equivocation instead.
  // Each lookup below is an uncorrelated IN, so the roster views behind it run
  // once per statement, not once per row (the seat chain is several views deep).
  const member = (row: string): string =>
    `(${row}._r_session, ${row}._r_replica) IN (SELECT session, replica FROM _dai_member)`;
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
    `(${row}._r_session, ${row}._r_replica) IN (SELECT session, replica FROM _dai_creator)`;
  const byRole = (row: string): string =>
    author === "creator" ? ` AND ${seatAuthor(row)}` : author === "joiner" ? ` AND NOT ${seatAuthor(row)}` : "";
  /*
   * A seated table (identity step 5): the row names the seat it acts for, and
   * is admitted only when its author holds that seat, as `_dai_holder` says:
   * the creator's seat is the creator's, and an open seat her creator's seat
   * row declares is held by whoever she confirmed in it (R14). No clock is
   * read. A hold, once made, never moves (no seat is reseated), so "holds" and
   * "held when the row was written" are the same question, and a move written
   * while its author waited to be confirmed is admitted once they are. A row
   * naming no seat, or a seat nobody holds, is not admitted. A holder is never
   * an equivocator (R17), so nor is the author of an admitted row.
   */
  const holds = (row: string): string =>
    `(${row}._r_session, ${row}."${seatColumn}", ${row}._r_replica) IN (SELECT session, seat, replica FROM _dai_holder)`;
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
  // A row waiting on a parent this copy does not hold (R21) is not admitted,
  // whatever else it meets: what its parent is decides whether it crosses.
  // Read from `_dai_waiting_parent` by id, an uncorrelated IN computed once per
  // statement, and short: the schema travels in every document, inline links
  // included.
  const waitsOnParent = (row: string): string => `(${row}._r_replica, ${row}._r_seq) IN _dai_waiting_parent`;
  const admitted = (row: string): string =>
    seatColumn
      ? `(${holds(row)}) AND NOT ${foreign(row)} AND NOT ${otherSeat(row)}${byRole(row)} AND NOT ${namesEquivocated(row)} AND NOT ${waitsOnParent(row)}`
      : `(${member(row)}) AND NOT ${foreign(row)}${byRole(row)} AND NOT ${namesEquivocated(row)} AND NOT ${waitsOnParent(row)}`;
  /*
   * Waiting on a confirmation (identity step 5, finding 6): the author asked for
   * an open seat nobody holds yet and that is not void, in the row's session,
   * and (in a seated table) the row names that seat. Neither admitted nor
   * refused; a fact about the row set, the same on every copy, so an
   * application shows its own waiting rows from `_pending` and never from the
   * table itself.
   */
  const asks =
    `SELECT b._r_session, b._r_replica, b.seat FROM _dai_binding_current b JOIN _dai_open_seat s ON s.session = b._r_session AND s.seat = b.seat` +
    ` WHERE (s.session, s.seat) NOT IN (SELECT session, seat FROM _dai_holder)` +
    ` AND (s.session, s.seat) NOT IN (SELECT session, seat FROM _dai_voided)`;
  const waiting = (row: string): string =>
    seatColumn
      ? `(${row}._r_session, ${row}._r_replica, ${row}."${seatColumn}") IN (${asks})`
      : `(${row}._r_session, ${row}._r_replica) IN (SELECT _r_session, _r_replica FROM (${asks}))`;
  const pendingRow = (row: string): string =>
    `${waiting(row)} AND NOT ${foreign(row)}${seatColumn ? ` AND NOT ${otherSeat(row)}` : ""}${byRole(row)} AND ${notEquivocator(row)} AND NOT ${namesEquivocated(row)}`;
  // Only a row of r's own entity can supersede it (T1-D35), only one of r's
  // own session (D131), and in a seated table only one of r's own seat (D132).
  const supersededBy = (row: string, gate: string): string =>
    `EXISTS (
       SELECT 1 FROM ${q} c, json_each(${parentsSql("c._r_parents")}) p
        WHERE c._r_entity = ${row}._r_entity AND c._r_session = ${row}._r_session${seatColumn ? ` AND c."${seatColumn}" = ${row}."${seatColumn}"` : ""}
          AND ${gate}
          AND p.value = lower(hex(${row}._r_replica)) || ':' || ${row}._r_seq
     )`;
  // What a merge may report about a row: one in a live session, by no
  // equivocator, naming no equivocated id as a parent. A row of a void
  // session, or of one with no live creator's seat row, is reported nowhere
  // (R14, R20), nor is an equivocator's (R17), whose signing twice is the one
  // thing reported of him, nor a row naming an equivocated id (X1). Nor a row
  // waiting on a parent this copy does not hold (R21), which the merge, the
  // one reader of these views, leaves out by `_dai_waiting_parent`: the schema
  // travels in every document, so the test is stated once.
  const reportable = (row: string): string =>
    `${inLiveSession(row)} AND ${notEquivocator(row)} AND NOT ${namesEquivocated(row)}`;
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
-- Only of a reportable row: in a live session (R14, R20), by no equivocator
-- (R17), naming no equivocated id (X1).
CREATE VIEW IF NOT EXISTS ${q}_foreign AS
  SELECT r._r_replica, r._r_seq, r._r_batch, fp._r_replica AS parent_replica, fp._r_seq AS parent_seq
    FROM ${q} r, ${q} fp, json_each(${parentsSql("r._r_parents")}) fj
   WHERE fp._r_entity = r._r_entity AND fj.value = lower(hex(fp._r_replica)) || ':' || fp._r_seq
     AND fp._r_session <> r._r_session AND ${reportable("r")};` +
    (seatColumn
      ? `
-- What a merge reports as SEAT_NOT_HELD (identity step 5, A03, A09): a
-- reportable row that names no seat (a seat column that is not 16 bytes), or
-- a seat it does not hold that is no seat it waits in or a void one (a seat
-- someone else holds, or a value no counting confirm names), or that names as
-- its earlier version a row acting for another seat of its session (D132). A
-- row waiting on a confirmation is neither admitted nor reported, nor is a row
-- for a void seat.
CREATE VIEW IF NOT EXISTS ${q}_unseated AS
  SELECT r._r_replica, r._r_seq, r._r_batch FROM ${q} r
   WHERE (typeof(r."${seatColumn}") <> 'blob' OR length(r."${seatColumn}") <> 16
      OR (NOT (${holds("r")}) AND NOT ${waiting("r")}
          AND (r._r_session, r."${seatColumn}") NOT IN (SELECT session, seat FROM _dai_voided))
      OR ${otherSeat("r")})
     AND ${reportable("r")};

-- The same crossing with the row it names, so a merge reports it whichever of
-- the two arrived (D132), and like it only of a reportable row.
CREATE VIEW IF NOT EXISTS ${q}_other_seat AS
  SELECT r._r_replica, r._r_seq, r._r_batch, sp._r_replica AS parent_replica, sp._r_seq AS parent_seq
    FROM ${q} r, ${q} sp, json_each(${parentsSql("r._r_parents")}) sj
   WHERE sp._r_entity = r._r_entity AND sj.value = lower(hex(sp._r_replica)) || ':' || sp._r_seq
     AND sp._r_session = r._r_session AND sp."${seatColumn}" IS NOT r."${seatColumn}"
     AND ${reportable("r")};`
      : "");
}

function tableObjects(
  name: string,
  authored: string[],
  session: boolean,
  admissionFiltered: boolean,
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
  /*
   * What `_current` reads its heads from. In a session document the heads read
   * the roster, and `_current` reads them three times, so it reads them once,
   * materialized: compiling the roster is most of what a read costs. A plain
   * document's `_current` is the text it always was.
   */
  const heads = session ? "heads" : `${q}_heads`;
  // In a session document the comments below are read here and not stored, as
  // the roster's are (D186): its schema is longer, and an inline link has a
  // length cap. A plain document's schema is the text it always was.
  const emitted = (sql: string): string => (session ? `\n${stripSqlComments(sql)}\n` : sql);
  return emitted(`
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

${headsView(q, session, admissionFiltered, author, seatColumn)}

CREATE VIEW IF NOT EXISTS ${q}_conflicts AS
  SELECT _r_entity, count(*) AS heads,
         json_group_array(hex(_r_replica) || ':' || _r_seq) AS head_ids
  FROM ${q}_heads GROUP BY ${partition("")} HAVING count(*) > 1;

CREATE VIEW IF NOT EXISTS ${q}_current AS${heads === `${q}_heads` ? "" : `\n  WITH ${heads} AS MATERIALIZED (SELECT * FROM ${q}_heads)`}
  SELECT h.*,
         (SELECT count(*) FROM ${heads} x WHERE ${samePart("x", "h")}) > 1
           AS _r_conflicted
  FROM ${heads} h
  WHERE h._r_deleted = 0
    AND h._r_replica || ':' || h._r_seq = (
      SELECT y._r_replica || ':' || y._r_seq FROM ${heads} y
       WHERE ${samePart("y", "h")} AND y._r_deleted = 0
       ORDER BY y._r_lc DESC, hex(y._r_replica) ASC, y._r_seq ASC
       LIMIT 1);
`);
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
/** SQL without its whole-line `--` comments and blank lines. */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"))
    .join("\n");
}

function documentTables(session: boolean, maxParties = 0, authorTables: readonly string[] = []): string {
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
    `CREATE TABLE IF NOT EXISTS ${name} (\n  seat BLOB,\n${extra}${replicationColumns(true)}\n) WITHOUT ROWID;\n` +
    tableObjects(name, authored, true, false);

  /*
   * The seat model (identity step 5, ruled 24 September; the declared roster,
   * R14 to R20, 3 October). No clock decides anything in it, and no rule ranks
   * two seqs of one author against each other but R18's, which only ever
   * accuses that author.
   *
   * - The roster is declared. The creator's seat row is the one `_dai_seat`
   *   row whose own author, seq and roster hash to its session (R15,
   *   `dai_session_id`, src/session-id.ts): it carries `seat` (hers), `seats`
   *   (the open seats, 16-byte values one after another) and `close` (the close
   *   rule). Only the creator can write it, and she can write it once; checked
   *   here, at read, over every row this copy holds however it arrived. It is
   *   immutable: a later version of it counts for nothing, and no other
   *   `_dai_seat` row counts for anything. A row whose roster is not valid
   *   (values not 16 bytes, repeated, hers among them, more than the bound) is
   *   a void session.
   * - The creator's seat is hers by definition. Every value `seats` lists is an
   *   open seat, held by whoever the creator confirms in it, in `_dai_confirm`,
   *   which only her rows count in. A joiner's binding asks for a seat; it holds
   *   nothing until then. Two of her confirms of one seat naming different
   *   copies void it (D165), whatever their seqs and whichever arrived first,
   *   and nobody holds it. A seat is never reseated, so two confirms are two
   *   conflicting claims about one thing, as two rows at one id are (D160);
   *   the repair is a new session.
   * - An equivocator (two headers at one seq, R10, or a row in a session after
   *   a close of his there that counts, R18) holds no seat, and the seat he was
   *   confirmed in is void (R17). A session whose creator is one is void.
   *
   * The views that decide equivocation by a close read a first pass of the
   * roster that knows only the headers' equivocators (`_dai_creator0`,
   * `_dai_holder0`), so no view reads itself; every other reader reads the
   * views after it.
   */
  const bound = Math.max(maxParties - 1, 0);
  // Every row of every replicated table, by author, session and seq: what R18
  // looks for after a close.
  const tablesOfSession = [...authorTables, "_dai_seat", "_dai_binding", "_dai_confirm", "_dai_close"];
  const writesAfter = (close: string): string =>
    tablesOfSession
      .map(
        (t) =>
          `EXISTS (SELECT 1 FROM "${t}" w WHERE w._r_replica = ${close}.replica AND w._r_session = ${close}.session AND w._r_seq > ${close}.seq)`,
      )
      .join(" OR ");
  // The roster's chain (R14, R17, R18, R20), every step a common table
  // expression. Each roster view below is one step of it, with the steps that
  // step reads (rosterFor). The comments are read here and not stored, and the
  // whitespace is collapsed: sixteen views each hold part of the chain, and a
  // document carries its views (an inline link has a length cap).
  const roster = stripSqlComments(`
  WITH RECURSIVE
  place(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM place WHERE i + 1 < ${bound}),
  creator_row AS MATERIALIZED (SELECT * FROM _dai_creator_row),
  equivocated AS MATERIALIZED (SELECT DISTINCT author FROM _dai_equivocated),

  -- The open seats a creator's seat row lists (R14): its seats column read as
  -- 16-byte values, in the order written, at most max_parties - 1 of them
  -- (${bound} here). Read whatever the row holds. Whether the roster is valid
  -- is roster_invalid's question.
  roster_value AS MATERIALIZED (
    SELECT r.session AS session, place.i AS place, substr(r.seats, 16 * place.i + 1, 16) AS seat, r.seat AS own
      FROM creator_row r, place
     WHERE typeof(r.seats) = 'blob' AND 16 * place.i < length(r.seats)),

  -- The sessions whose creator's seat row declares no valid roster (R14): its
  -- seat not 16 bytes, its seats not a run of 16-byte values, more of them than
  -- max_parties - 1, one hers or one repeated, or a close rule that is neither
  -- any nor creator. Such a session is void.
  roster_invalid AS MATERIALIZED (
    SELECT r.session AS session FROM creator_row r
     WHERE NOT (typeof(r.seat) = 'blob' AND length(r.seat) = 16
                AND typeof(r.seats) = 'blob' AND length(r.seats) % 16 = 0 AND length(r.seats) / 16 <= ${bound}
                AND typeof(r.close) = 'text' AND r.close IN ('any', 'creator'))
    UNION
    SELECT session FROM roster_value WHERE seat = own
    UNION
    SELECT session FROM roster_value GROUP BY session, seat HAVING count(*) > 1),

  -- The first pass: the live sessions as the headers alone leave them, before
  -- any close is read (R18 reads these, so no step reads itself). A creator's
  -- seat row not deleted, valid, by an author who signed no two headers at one
  -- seq. The confirms of hers that count, of a value her row lists, naming a
  -- holder that is an author id (16 bytes; any other value names nobody, and
  -- the confirm counts for nothing). And who holds what, a seat whose confirms
  -- name two holders, or a holder who signed twice, holding nobody.
  creator0 AS MATERIALIZED (
    SELECT r.session AS session, r.replica AS replica, r.seat AS seat, r.entity AS entity, r.seq AS seq, r.close AS close
      FROM creator_row r
     WHERE r.deleted = 0 AND r.session NOT IN (SELECT session FROM roster_invalid)
       AND r.replica NOT IN (SELECT author FROM equivocated)),
  confirmed0 AS MATERIALIZED (
    SELECT f._r_session AS session, f.seat AS seat, f.holder AS holder, f._r_seq AS seq, f._r_replica AS creator
      FROM _dai_confirm f
      JOIN creator0 c ON c.session = f._r_session AND c.replica = f._r_replica
       AND typeof(f.holder) = 'blob' AND length(f.holder) = 16
     WHERE (f._r_session, f.seat) IN (SELECT session, seat FROM roster_value)),
  holder0 AS MATERIALIZED (
    SELECT session, seat, replica FROM creator0
    UNION
    SELECT f.session, f.seat, min(f.holder)
      FROM confirmed0 f
     GROUP BY f.session, f.seat
    HAVING count(DISTINCT f.holder) = 1 AND min(f.holder) NOT IN (SELECT author FROM equivocated)),

  -- The closes that count before R18 is read: not deleted (a close cannot be
  -- revoked, D153), in a live session of the first pass, by an author its
  -- creator's seat row's close rule permits (under creator, the creator. Under
  -- any, a holder of a seat in it, D145).
  close0 AS MATERIALIZED (
    SELECT x._r_session AS session, x._r_replica AS replica, x._r_seq AS seq
      FROM _dai_close x
      JOIN creator0 c ON c.session = x._r_session
     WHERE x._r_deleted = 0
       AND (x._r_replica = c.replica
            OR (c.close = 'any' AND (x._r_session, x._r_replica) IN (SELECT session, replica FROM holder0)))),

  -- Close is monotone (R18): a close that counts and any row by its author in
  -- that session at a higher seq are the author signing twice, his close saying
  -- he wrote no more there and the row saying he did. Equivocation, as two
  -- headers at one seq are: it accuses only him, and it is never undone.
  close_equivocated AS MATERIALIZED (
    SELECT DISTINCT k.session AS session, k.replica AS replica
      FROM close0 k
     WHERE ${writesAfter("k")}),

  -- The equivocators (R10, R18): an author with two authentic headers at one
  -- seq anywhere in the document, or a row in a session after a close of his
  -- there that counts. Every seat, binding, confirm and close row of his counts
  -- for nothing, he holds no seat, and none of his rows is admitted (R17).
  equivocator AS MATERIALIZED (
    SELECT author FROM equivocated
    UNION
    SELECT replica FROM close_equivocated),

  -- The void sessions (R10, R14, R20): those whose creator's seat row, deleted
  -- or not, declares no valid roster or is by an equivocator. A creator's seat
  -- row at an equivocated id is by one, whichever row this copy holds at that
  -- id. No row in one is admitted, nobody holds a seat in it, nothing closes it,
  -- and nothing in it is reported but its creator signing twice. Equivocation
  -- is never undone (both headers are kept and passed on), so a void session
  -- stays void. The repair is a new session.
  void_session AS MATERIALIZED (
    SELECT DISTINCT r.session AS session, r.replica AS creator
      FROM creator_row r
     WHERE r.session IN (SELECT session FROM roster_invalid)
        OR r.replica IN (SELECT author FROM equivocator)),

  -- The live sessions and their creators: a creator's seat row not deleted,
  -- valid, by no equivocator. A session with no such row (none held yet, a
  -- tombstone at its id, or void) admits and reports nothing.
  creator AS MATERIALIZED (
    SELECT session, replica, seat, entity, seq, close FROM creator0
     WHERE replica NOT IN (SELECT author FROM equivocator)),

  -- The open seats of the live sessions, as their creator's seat row lists them.
  open_seat AS MATERIALIZED (
    SELECT v.session AS session, v.seat AS seat FROM roster_value v
     WHERE v.session IN (SELECT session FROM creator)),

  -- The creator's confirms that count: her rows in her live session, naming a
  -- value her creator's seat row lists (R14). Deleted or not, superseded or not
  -- (D171): a confirm is her statement that she seated a copy, and a hold never
  -- moves once made, so a later version or a delete of one is another confirm.
  confirmed AS MATERIALIZED (
    SELECT f.session, f.seat, f.holder, f.seq, f.creator FROM confirmed0 f
     WHERE f.session IN (SELECT session FROM creator)),

  -- The void seats: confirmed to two different copies (D165), or to an
  -- equivocator (R17). Held by nobody, on every copy holding the rows that make
  -- them void, whichever arrived first. holders is how many copies the counting
  -- confirms name: two or more is the creator signing twice.
  voided AS MATERIALIZED (
    SELECT f.session AS session, f.seat AS seat, min(f.creator) AS creator, count(DISTINCT f.holder) AS holders
      FROM confirmed f
     GROUP BY f.session, f.seat
    HAVING count(DISTINCT f.holder) > 1 OR min(f.holder) IN (SELECT author FROM equivocator)),

  -- Who holds each seat: the creator her own, and the one copy the counting
  -- confirms of an open seat name, unless it is void. One holder may hold
  -- several seats (a creator who confirms herself in an open seat plays both).
  holder AS MATERIALIZED (
    SELECT c.session AS session, c.seat AS seat, c.replica AS replica, 0 AS since
      FROM creator c
    UNION
    -- An open seat not void: its counting confirms name one copy, no equivocator.
    SELECT f.session, f.seat, min(f.holder), min(f.seq)
      FROM confirmed f
     GROUP BY f.session, f.seat
    HAVING count(DISTINCT f.holder) = 1 AND min(f.holder) NOT IN (SELECT author FROM equivocator)),

  -- The closed sessions: a close that counts, in a live session, by an author
  -- who is no equivocator (D146, R18).
  closed AS MATERIALIZED (
    SELECT DISTINCT k.session AS session FROM close0 k
     WHERE k.session IN (SELECT session FROM creator)
       AND k.replica NOT IN (SELECT author FROM equivocator))
 `);
  // The steps, by name, in order: a step reads only steps before it.
  const steps = roster
    .replace(/^\s*WITH RECURSIVE\n/, "")
    .split(/\n(?= {2}\w+(?:\(i\))? AS )/)
    .map((step) => step.trim().replace(/,$/, ""))
    .map((step) => ({ name: /^\w+/.exec(step)![0], sql: step.replace(/\s+/g, " ") }));
  const reads = (step: { name: string; sql: string }, other: string): boolean =>
    new RegExp(`(?:FROM|JOIN|,) ${other}\\b`).test(step.sql.slice(step.name.length));
  const rosterFor = (target: string): string => {
    const need = new Set([target]);
    for (let i = steps.length - 1; i >= 0; i--) {
      if (!need.has(steps[i]!.name)) continue;
      for (const other of steps.slice(0, i)) if (reads(steps[i]!, other.name)) need.add(other.name);
    }
    return `WITH RECURSIVE ${steps.filter((step) => need.has(step.name)).map((step) => step.sql).join(", ")}`;
  };
  const member = `
-- The creator's seat row (R15): every _dai_seat row whose own author, seq and
-- roster (seat, seats, close, as the row holds them) hash to its session,
-- deleted or not. The id names one row and the roster it declares, so a
-- session has at most one, and no other row, nor a later version of it, is it.
CREATE VIEW IF NOT EXISTS _dai_creator_row AS
  SELECT s._r_session AS session, s._r_replica AS replica, s._r_seq AS seq, s._r_entity AS entity,
         s.seat AS seat, s.seats AS seats, s.close AS close, s._r_deleted AS deleted
    FROM _dai_seat s
   WHERE ${SESSION_ID_FUNCTION}(s._r_replica, s._r_seq, s.seat, s.seats, s.close) = s._r_session;


-- The roster's steps that something reads, by the name each is read under.
-- Each view is one step and the steps it reads: SQLite compiles a step only
-- where a statement reads it, and a step read twice in one view (the creator
-- under the confirms and the holders) is computed once there. The views do not
-- read one another, so a statement reading several of them compiles each chain
-- once, not once for each place one step reads another (the chain is several
-- steps deep, and the heads of every seat-aware table read it). The first
-- steps (the roster's values, an invalid roster, and the first pass) have no
-- view: nothing reads them but later steps. The closes that count before R18
-- is read (_dai_close0) and the closes that make an equivocator are for the
-- merge's reports. Every reader of "is this session closed" (the host, the
-- kit, the apps) reads _dai_closed, never _dai_close_current: a delete of a
-- close does not reopen the session (D153).
CREATE VIEW IF NOT EXISTS _dai_close0 AS ${rosterFor("close0")} SELECT session, replica, seq FROM close0;
CREATE VIEW IF NOT EXISTS _dai_close_equivocated AS ${rosterFor("close_equivocated")} SELECT session, replica FROM close_equivocated;
CREATE VIEW IF NOT EXISTS _dai_equivocator AS ${rosterFor("equivocator")} SELECT author FROM equivocator;
CREATE VIEW IF NOT EXISTS _dai_void_session AS ${rosterFor("void_session")} SELECT session, creator FROM void_session;
CREATE VIEW IF NOT EXISTS _dai_creator AS ${rosterFor("creator")} SELECT session, replica, seat, entity, seq, close FROM creator;
CREATE VIEW IF NOT EXISTS _dai_open_seat AS ${rosterFor("open_seat")} SELECT session, seat FROM open_seat;
CREATE VIEW IF NOT EXISTS _dai_confirmed AS ${rosterFor("confirmed")} SELECT session, seat, holder, seq, creator FROM confirmed;
CREATE VIEW IF NOT EXISTS _dai_voided AS ${rosterFor("voided")} SELECT session, seat, creator, holders FROM voided;
CREATE VIEW IF NOT EXISTS _dai_holder AS ${rosterFor("holder")} SELECT session, seat, replica, since FROM holder;
CREATE VIEW IF NOT EXISTS _dai_member AS ${rosterFor("holder")} SELECT DISTINCT session, replica FROM holder;
CREATE VIEW IF NOT EXISTS _dai_closed AS ${rosterFor("closed")} SELECT session FROM closed;

-- The seats nobody may be confirmed in: an open seat nobody holds that two or
-- more copies asked for (voided 0), and a void seat (voided 1). The repair of
-- either is a new session (R14): no seat is reseated. Every reader of
-- "contested" reads this: the kit and the apps. Not a step of the chain, since
-- it reads the asks, whose heads read the roster.
CREATE VIEW IF NOT EXISTS _dai_contested AS
  SELECT s.session AS session, s.seat AS seat, 0 AS voided
    FROM _dai_open_seat s
   WHERE (s.session, s.seat) NOT IN (SELECT session, seat FROM _dai_holder)
     AND (s.session, s.seat) NOT IN (SELECT session, seat FROM _dai_voided)
     AND (SELECT count(DISTINCT b._r_replica) FROM _dai_binding_current b
           WHERE b._r_session = s.session AND b.seat = s.seat) > 1
  UNION
  SELECT session, seat, 1 FROM _dai_voided;

-- The session profile the document declares, for the frame's writers: the
-- bound the creator's seat row's roster is held to, and the close rule the kit
-- writes on it (R14). A declaration, like _dai_seat_rules.
CREATE VIEW IF NOT EXISTS _dai_session_rules AS
  SELECT ${maxParties} AS max_parties;
`;

  /*
   * The session close (T1-D31, amended by D151 and R18). A session is closed
   * when a close its rule permits names it. It binds only its author: a row of
   * his in that session at a higher seq is equivocation (R18), so a close is
   * monotone, and nobody else's row is touched. A close is one row carrying its
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
    // The creator's seat row declares the roster (R14): her seat, the open
    // seats (16-byte values, one after another) and the close rule. No CHECK
    // on any roster value, `seat` and `holder` included: a signed row is taken
    // whatever it holds, a value that is not 16 bytes names no seat and no
    // holder, and a roster that is not valid makes its session void rather
    // than its row refused (seat-value-shape: a length CHECK threw inside the
    // merge and took the rest of the batch with it, branch review pass A, H1).
    rosterTable("_dai_seat", "  seats BLOB,\n  close TEXT,\n", ["seat", "seats", "close"]) +
    rosterTable("_dai_binding") +
    rosterTable("_dai_confirm", "  holder BLOB,\n", ["seat", "holder"]) +
    close +
    // The roster block's comments are for this file; every document carries
    // its schema, and an inline link has a length cap.
    `\n${stripSqlComments(member)}\n`
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
    // are recomputed over the members' rows (T1-D29). The roster tables that
    // carry the membership are not admission-filtered — emitted by
    // documentTables.
    out += tableObjects(
      span.name,
      authorColumns(body),
      session !== null,
      session !== null,
      authors[span.name],
      seats[span.name],
    );
    cursor = span.end;
  }
  out += sql.slice(cursor);

  return {
    sql:
      documentTables(session !== null, session?.maxParties ?? 0, declared.map((span) => span.name)) +
      out +
      authorRulesView(authors) +
      seatRulesView(seats) +
      (session ? waitingParentView([...SESSION_SYSTEM_TABLES, ...declared.map((span) => span.name)], declared.map((span) => span.name)) : ""),
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
