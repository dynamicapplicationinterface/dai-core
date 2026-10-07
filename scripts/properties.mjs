/**
 * The property pass: P0, P1 and P2 (docs/format-design.md, "The properties
 * the seat rules are derived from"), checked over every merge vector by the
 * runtime, here, and by the Python reader (scripts/properties.py), over the
 * same scenarios, which this script writes.
 *
 *     node scripts/properties.mjs                    # every vector
 *     node scripts/properties.mjs --only <name>,<name>
 *     node scripts/properties.mjs --all              # list every violation, filed ones too
 *     python scripts/properties.py                   # then the Python reader, over what this wrote
 *
 * A vector's headers and rows are its items: one per header either copy holds,
 * with the rows that header covers as the copy holding it signed them (a
 * header no copy holds complete, or one refused, arrives alone). An observer,
 * a copy of the document's schema that writes nothing, takes items one merge
 * at a time, each verified first, as every merge is.
 *
 * - P0. Every arrival order of a vector's items (all orders up to six items;
 *   beyond that, fifty orders drawn from a generator seeded by the vector's
 *   name) gives the same admitted state, holders, voided seats, equivocated
 *   ids and closed sessions. Not the same reports: a report says what one
 *   merge made true, and the same row arriving in another merge may be
 *   reported differently (D190, docs/format.md#report-made-true). Each
 *   order's reports are kept in the scenario all the same, and the Python
 *   reader must make the same ones. And in a session document the admitted
 *   state is a function of signed rows and headers alone (D194,
 *   docs/format.md#uncovered-row): each mutation's rows, written into each
 *   base below under their author's id with no header covering them, leave
 *   what the base admits as it was.
 * - P1. Over three bases (copy A as it stands, copy B, and both), every
 *   addition from the mutation library leaves the admitted rows and the holds
 *   a superset of what they were, unless the merge that takes it reports
 *   AUTHOR_EQUIVOCATED. The library is the sealer's facilities
 *   (scripts/sealer.mjs), applied for each author: a row of every roster kind
 *   and of the author tables at a seq the author left unused (a gap, below his
 *   creator's seat row), at a seq he has used (a second header), and at his
 *   next; a close at a seq he skipped; a parent naming an id not yet written;
 *   a header without its rows; a tombstone of each of his rows; a seat value of
 *   every type; and each of the vector's own headers held back and released
 *   after everything else.
 * - P2. For each author who signs two headers with different digests over one
 *   seq, his standing (the seats he holds, his admitted rows, the closed
 *   sessions) is the same for every set of his conflicting headers a copy can
 *   hold that shows him signing twice: he cannot choose by withholding.
 *
 * A violation is a finding. One filed in scripts/properties-known.json (with
 * its backlog entry) is reported and does not fail the run; an unfiled one
 * does, and so does a filed one that no longer occurs, so the list stays true.
 *
 * `--suite` and the dist/ beside this script can be another build's: the
 * teeth of the pass are a runtime from before R14 flagged on A01, A02, A05
 * and A10 (docs/handoff-2026-10-04.md).
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeFrom, mergeTablesOf, verifyBatches } from "../dist/dai-merge.js";
import {
  ADA,
  BO,
  CY,
  DOC,
  PEOPLE,
  SEAT_VALUES,
  admittedDump,
  badSeatValueAt,
  carryHeaderOnly,
  closeAt,
  columnsOf,
  forwardParentAt,
  rawAt,
  rowIdOf,
  seal,
  sessionIdOf,
  tombstoneAt,
} from "./sealer.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const suite = resolve(flag("--suite") ?? join(repo, "conformance", "merge"));
const out = resolve(flag("--out") ?? join(repo, "node_modules", ".cache", "properties"));
const knownPath = resolve(flag("--known") ?? join(repo, "scripts", "properties-known.json"));
const only = flag("--only") ? new Set(flag("--only").split(",")) : null;
const listAll = process.argv.includes("--all");
/** Every mutation from every held set as well (slow; not what CI runs). */
const deep = process.argv.includes("--deep");
const deepSiblings = [];

/** Every order up to this many items; beyond it, SAMPLES orders. */
const EXHAUSTIVE = 6;
const SAMPLES = 50;
/** Every set of a vector's headers held back, up to this many headers; beyond it, HELD_SAMPLES sets. */
const HELD_EXHAUSTIVE = 8;
const HELD_SAMPLES = 64;
/** At most this many of an equivocator's conflicting headers are taken in every subset (2^n). */
const SUBSET_LIMIT = 6;

const hexOf = (bytes) => Buffer.from(bytes).toString("hex");
const b64Of = (bytes) => Buffer.from(bytes).toString("base64url");
const nameOf = (author) => PEOPLE.find((p) => hexOf(p.author) === hexOf(author))?.name ?? hexOf(author).slice(0, 8);
ADA.name = "Ada";
BO.name = "Bo";
CY.name = "Cy";
const shownName = Object.fromEntries(PEOPLE.map((p) => [b64Of(p.author), p.name]));
/** The observer's replica id: no author's. */
const OBSERVER = new Uint8Array(16).fill(0xd0);

/** A connection behind the interface the runtime's merge asks for, each statement prepared once. */
function wrap(db) {
  const kept = new Map();
  const prepared = (sql) => {
    let statement = kept.get(sql);
    if (!statement) kept.set(sql, (statement = db.prepare(sql)));
    return statement;
  };
  const rows = {
    db,
    all: (sql, params = []) => prepared(sql).all(...params),
    run: (sql, params = []) => void prepared(sql).run(...params),
    close: () => db.close(),
  };
  rows.tables = mergeTablesOf(rows);
  return rows;
}
const connection = () => {
  const db = new DatabaseSync(":memory:");
  db.function("dai_session_id", { deterministic: true }, sessionIdOf);
  return db;
};
/*
 * A copy as bytes and back. In memory where node:sqlite can (serialize and
 * deserialize); otherwise through a file in the scratch directory, which is
 * slower and the same.
 */
const inMemory = typeof DatabaseSync.prototype.serialize === "function" && !process.argv.includes("--files");
let files = 0;
/** A copy from bytes (a serialized database). */
function fromBytes(bytes) {
  if (inMemory) {
    const db = connection();
    db.deserialize(bytes);
    return wrap(db);
  }
  const path = join(out, `scratch-${(files += 1)}.db`);
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  db.function("dai_session_id", { deterministic: true }, sessionIdOf);
  const copy = wrap(db);
  copy.close = () => {
    db.close();
    rmSync(path, { force: true });
  };
  return copy;
}
function bytesOf(copy) {
  if (inMemory) return copy.db.serialize();
  const path = join(out, `scratch-${(files += 1)}.db`);
  copy.run(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  const bytes = readFileSync(path);
  rmSync(path);
  return bytes;
}

/** The schema statements of a copy, in the order they were made. */
const schemaOf = (copy) => copy.all("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").map((r) => r.sql);
/** An empty copy of a schema, as bytes. */
function emptyOf(statements) {
  const db = connection();
  for (const sql of statements) db.exec(sql);
  const bytes = bytesOf({ db, run: (sql) => db.exec(sql) });
  db.close();
  return bytes;
}
function asReplica(copy, replica) {
  copy.run("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", [replica]);
  copy.run("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [replica]);
}

/** A value as the scenario file spells it, for the Python reader: bytes tagged, the rest as JSON has it. */
const encode = (value) => (value instanceof Uint8Array ? { b: hexOf(value) } : typeof value === "bigint" ? Number(value) : value);
const encodeRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, encode(v)]));
const verdictText = (v) => (v.ok ? (v.complete ? "ok" : "incomplete") : v.reason);

/** A sibling copy holding one header and the rows given, verified: what an item or a mutation is. */
async function siblingOf(empty, header, rows) {
  const copy = fromBytes(empty);
  const names = Object.keys(header);
  copy.run(`INSERT INTO _dai_batch (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`, names.map((n) => header[n]));
  copy.run("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", [header.author]);
  for (const { table, row } of rows) {
    const columns = Object.keys(row);
    copy.run(`INSERT INTO "${table}" (${columns.map((n) => `"${n}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, columns.map((n) => row[n]));
  }
  const verdicts = await verifyBatches(copy, copy.tables, DOC);
  const lists = {};
  for (const [hid, v] of verdicts) if (v.ok && JSON.stringify(v.covers) !== header.covers) lists[hid] = JSON.stringify(v.covers);
  return { copy, verdicts, lists };
}

/**
 * The items of the copies given: one per header any of them holds, from the
 * copy that holds it complete if one does. A complete header comes with the
 * rows it covers; any other comes alone. Rows no header covers are pending
 * rows, which never cross a merge (BATCH_UNSIGNED), and are not items.
 */
async function itemsOf(copies, empty) {
  const chosen = new Map();
  for (const { copy, view } of copies) {
    const verdicts = await verifyBatches(copy, copy.tables, DOC);
    for (const header of copy.all("SELECT * FROM _dai_batch")) {
      const hid = hexOf(header.id);
      const verdict = verdicts.get(hid);
      const rank = !verdict?.ok ? 0 : verdict.complete ? 2 : 1;
      if ((chosen.get(hid)?.rank ?? -1) >= rank) continue;
      const rows = [];
      if (rank === 2) {
        for (const [table, seq] of verdict.covers) {
          const [row] = copy.all(`SELECT * FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [header.author, seq]);
          rows.push({ table, row: { ...row, _r_batch: header.id } });
        }
      }
      chosen.set(hid, { rank, header, rows, view });
    }
  }
  const items = [];
  for (const [hid, { header, rows, view }] of [...chosen].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const { copy, verdicts, lists } = await siblingOf(empty, header, rows);
    items.push({
      id: hid,
      author: header.author,
      copy,
      verdicts,
      view,
      json: {
        id: hid,
        author: hexOf(header.author),
        view,
        header: encodeRow(header),
        rows: rows.map(({ table, row }) => ({ table, row: encodeRow(row) })),
        verdicts: Object.fromEntries([...verdicts].map(([k, v]) => [k, verdictText(v)])),
        lists,
      },
    });
  }
  return items;
}

/** One merge into `local`, verified first; its reports as "<author> <code>". */
function arrive(local, item, view) {
  const result = mergeFrom(local, item.copy, local.tables, undefined, item.verdicts, { views: { local: view, sibling: item.view } });
  const reports = result.refusedBatches.map((r) => `${shownName[r.author] ?? r.author} ${r.reason}`);
  if (result.refused) reports.push(`refused ${result.refused}`);
  return reports;
}

/** What a copy admits and reports, as one text: the admitted dump, then the reports made reaching it, sorted. */
const signature = (copy, reports) => `${admittedDump(copy)}# reports\n${[...new Set(reports)].sort().join("\n")}\n`;

/** The `# name` sections of an admitted dump. */
function sections(dump) {
  const found = {};
  let current = null;
  for (const line of dump.split("\n")) {
    if (line.startsWith("# ")) found[(current = line.slice(2))] = [];
    else if (line && current) found[current].push(line);
  }
  return found;
}
const ROSTER_SECTIONS = new Set(["holders", "voided", "equivocated", "closed", "reports"]);
/** The admitted rows (every table's section) and the holds of a dump, as lines. */
function admittedAndHeld(dump) {
  const found = sections(dump);
  const lines = [];
  for (const [name, rows] of Object.entries(found)) {
    if (name === "holders") lines.push(...rows.map((r) => `hold ${r}`));
    else if (!ROSTER_SECTIONS.has(name)) lines.push(...rows.map((r) => `${name} ${r}`));
  }
  return lines;
}

/** A small seeded generator, so a sampled order is the same on every run. */
function seeded(name) {
  let state = createHash("sha256").update(name).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function* permutations(n) {
  const order = [...Array(n).keys()];
  function* go(k) {
    if (k === n) {
      yield [...order];
      return;
    }
    for (let i = k; i < n; i += 1) {
      [order[k], order[i]] = [order[i], order[k]];
      yield* go(k + 1);
      [order[k], order[i]] = [order[i], order[k]];
    }
  }
  yield* go(0);
}
function ordersFor(name, n) {
  if (n <= EXHAUSTIVE) return [...permutations(n)];
  const random = seeded(name);
  const orders = [[...Array(n).keys()]];
  while (orders.length < SAMPLES) {
    const order = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    orders.push(order);
  }
  return orders;
}

/*
 * One observer connection per base, its statements prepared once, and every
 * trial inside a savepoint rolled back after: compiling the roster's views is
 * nearly all of a merge's cost, and a fresh copy compiles them again.
 */
let savepoints = 0;
/** Runs `trial` on `copy` and puts the copy back as it was. */
function trying(copy, trial) {
  const name = `trial${(savepoints += 1)}`;
  copy.run(`SAVEPOINT ${name}`);
  try {
    return trial();
  } finally {
    copy.run(`ROLLBACK TO ${name}`);
    copy.run(`RELEASE ${name}`);
  }
}
/** `items` taken into `local` in the order given; the reports. */
function replay(local, items, view) {
  const reports = [];
  for (const item of items) reports.push(...arrive(local, item, view));
  counted.merges += items.length;
  return reports;
}

/**
 * Whether the row `rid` of `table` is admitted in `copy`, though no head: a
 * head is a row nothing of its partition names, so a row a later version names
 * is admitted and hidden. Asked with every row of its entity that names it,
 * directly or through another, taken out (in a trial): if it is admitted, it is
 * a head then. Only a version hides a row, and a row of another entity taken
 * out could be one this row names, leaving it waiting on a parent (R21).
 */
function admittedThough(copy, table, rid) {
  const [author, seq] = rid.split(":");
  const rows = copy.all(
    `SELECT lower(hex(_r_replica)) || ':' || _r_seq AS id, _r_parents AS p FROM "${table}" WHERE _r_entity = (SELECT _r_entity FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?)`,
    [Buffer.from(author, "hex"), Number(seq)],
  );
  const named = new Set([rid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (named.has(r.id)) continue;
      let parents = [];
      try {
        parents = JSON.parse(r.p);
      } catch {}
      if (Array.isArray(parents) && parents.some((p) => named.has(p))) {
        named.add(r.id);
        grew = true;
      }
    }
  }
  named.delete(rid);
  if (named.size === 0) return false;
  return trying(copy, () => {
    for (const { name } of copy.all("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?", [table])) copy.run(`DROP TRIGGER "${name}"`);
    for (const id of named) {
      const [author, seq] = id.split(":");
      copy.run(`DELETE FROM "${table}" WHERE _r_replica = ? AND _r_seq = ?`, [Buffer.from(author, "hex"), Number(seq)]);
    }
    return copy.all(`SELECT 1 FROM "${table}_heads" WHERE lower(hex(_r_replica)) || ':' || _r_seq = ?`, [rid]).length > 0;
  });
}

/** The first line that differs between two texts, for a finding. */
function firstDifference(x, y) {
  const a = x.split("\n");
  const b = y.split("\n");
  const missing = a.filter((line) => !b.includes(line));
  const extra = b.filter((line) => !a.includes(line));
  return { only_first: missing.slice(0, 6), only_second: extra.slice(0, 6) };
}

/*
 * The mutation library: what each author can add to a vector with the
 * sealer's facilities. Each is written into an empty copy of the author's,
 * at a seq chosen against everything the vector holds, and sealed there.
 */
const FRESH_SEAT = new Uint8Array(16).fill(0xe7);
const MUTANT = (n) => new Uint8Array(16).fill(0xe0 + n);
function seatValuesIn(copy, session) {
  const values = new Map();
  const add = (v) => v instanceof Uint8Array && v.length === 16 && values.set(hexOf(v), v);
  const tables = new Set(copy.tables);
  const seatTables = [...tables].filter((t) => copy.all(`SELECT name FROM pragma_table_info('${t}') WHERE name = 'seat'`).length > 0);
  for (const t of seatTables) for (const r of copy.all(`SELECT seat FROM "${t}" WHERE _r_session = ?`, [session])) add(r.seat);
  if (tables.has("_dai_seat") && copy.all("SELECT name FROM pragma_table_info('_dai_seat') WHERE name = 'seats'").length > 0) {
    for (const r of copy.all("SELECT seats FROM _dai_seat WHERE _r_session = ?", [session])) {
      if (r.seats instanceof Uint8Array) for (let i = 0; i + 16 <= r.seats.length; i += 16) add(r.seats.subarray(i, i + 16));
    }
  }
  return [...values.values()];
}

/** The seqs to sign at, for an author: each he left unused, his next, and the lowest and highest he used. */
function seqsFor(copies, author) {
  const used = new Set();
  for (const copy of copies) {
    for (const h of copy.all("SELECT covers FROM _dai_batch WHERE author = ?", [author])) {
      try {
        for (const [, seq] of JSON.parse(h.covers)) used.add(Number(seq));
      } catch {}
    }
    for (const t of copy.tables) for (const r of copy.all(`SELECT _r_seq AS s FROM "${t}" WHERE _r_replica = ?`, [author])) used.add(Number(r.s));
  }
  const top = used.size ? Math.max(...used) : 0;
  const gaps = [];
  for (let s = 1; s <= top; s += 1) if (!used.has(s)) gaps.push(s);
  const sorted = [...used].sort((x, y) => x - y);
  return { gaps, next: top + 1, reused: [...new Set([sorted[0], sorted[sorted.length - 1]].filter((s) => s !== undefined))], top };
}

/** Every mutation for a vector: `{ name, author, write(scratch) }`, `headerOnly` for a header sent without its rows. */
function mutationsFor(union) {
  const mutations = [];
  const isSession = union.tables.includes("_dai_seat");
  const authorTables = union.tables.filter((t) => !t.startsWith("_dai_"));
  const authors = PEOPLE;
  const seqs = Object.fromEntries(authors.map((p) => [p.name, seqsFor([union], p.author)]));
  const add = (person, where, seq, label, write, extra = {}) =>
    mutations.push({ name: `${where}:${person.name}:${label}:${seq}`, author: person, seq, write, ...extra });
  for (const person of authors) {
    const { gaps, next, reused, top } = seqs[person.name];
    const places = [...gaps.map((s) => ["gap", s]), ["next", next], ...reused.map((s) => ["reused", s])];
    const others = authors.filter((p) => p !== person);
    const ownRows = (session) =>
      union.tables.flatMap((t) =>
        union
          .all(`SELECT * FROM "${t}" WHERE _r_replica = ?${session === undefined ? "" : " AND _r_session IS ?"} ORDER BY _r_seq`, session === undefined ? [person.author] : [person.author, session])
          .map((row) => ({ table: t, row })),
      );
    /** A row of `table` to copy the author columns of, any author's. */
    const templateOf = (table, session) =>
      union.all(`SELECT * FROM "${table}"${session === undefined ? "" : " WHERE _r_session IS ?"} ORDER BY _r_replica, _r_seq LIMIT 1`, session === undefined ? [] : [session])[0];
    const sessions = isSession ? union.all("SELECT DISTINCT _r_session AS s FROM _dai_seat WHERE _r_session IS NOT NULL").map((r) => r.s) : [undefined];
    for (const session of sessions) {
      const values = isSession ? seatValuesIn(union, session) : [];
      const tag = session ? hexOf(session).slice(0, 6) : "doc";
      for (const [where, seq] of places) {
        const at = (label, write, extra) => add(person, where, seq, `${tag}:${label}`, write, extra);
        if (isSession) {
          at("seat-row", (c) => rawAt(c, seq, "_dai_seat", MUTANT(0), { seat: FRESH_SEAT }, session));
          for (const { table, row } of ownRows(session).filter((r) => r.table === "_dai_seat")) {
            for (const v of values.filter((v) => hexOf(v) !== hexOf(row.seat)))
              at(`seat-version-${hexOf(v).slice(0, 4)}`, (c) => rawAt(c, seq, table, row._r_entity, { ...columnsOf(row), seat: v }, session, JSON.stringify([rowIdOf(row._r_replica, row._r_seq)])));
          }
          for (const v of [...values, FRESH_SEAT]) {
            const s = hexOf(v).slice(0, 4);
            at(`binding-${s}`, (c) => rawAt(c, seq, "_dai_binding", MUTANT(2), { seat: v }, session));
            for (const holder of authors) at(`confirm-${s}-${holder.name}`, (c) => rawAt(c, seq, "_dai_confirm", MUTANT(3), { seat: v, holder: holder.author }, session));
            for (const table of authorTables) {
              const template = templateOf(table, session);
              if (template && "seat" in template) at(`${table}-${s}`, (c) => rawAt(c, seq, table, MUTANT(5), { ...columnsOf(template), seat: v }, session));
            }
          }
          at("close", (c) => closeAt(c, seq, MUTANT(4), session));
        } else {
          for (const table of authorTables) {
            const template = templateOf(table);
            if (template) at(`${table}-new`, (c) => rawAt(c, seq, table, MUTANT(5), columnsOf(template), null));
          }
        }
        // His own rows: a version of each, a tombstone of each.
        for (const { table, row } of ownRows(session)) {
          const id = rowIdOf(row._r_replica, row._r_seq);
          if (!table.startsWith("_dai_") || isSession) {
            at(`version-${table}-${row._r_seq}`, (c) => rawAt(c, seq, table, row._r_entity, columnsOf(row), row._r_session ?? null, JSON.stringify([id])));
          }
          at(`tombstone-${table}-${row._r_seq}`, (c) => tombstoneAt(c, seq, table, row));
        }
        // A parent that does not exist yet: his own, ahead of the row, and each other author's next.
        const [last] = ownRows(session).slice(-1);
        if (last) {
          const { table, row } = last;
          at(`forward-own-${table}`, (c) => forwardParentAt(c, seq, table, row._r_entity, columnsOf(row), row._r_session ?? null, { author: person.author, seq: Math.max(seq, top) + 2 }));
          for (const other of others) {
            at(`forward-${other.name}-${table}`, (c) =>
              forwardParentAt(c, seq, table, row._r_entity, columnsOf(row), row._r_session ?? null, { author: other.author, seq: seqs[other.name].next }));
          }
        }
        if (where === "reused") {
          // The second header alone, without its row, as a forwarder carries it.
          at("seat-row-header-only", (c) => (isSession ? rawAt(c, seq, "_dai_seat", MUTANT(0), { seat: FRESH_SEAT }, session) : rawAt(c, seq, authorTables[0], MUTANT(5), columnsOf(templateOf(authorTables[0]) ?? {}), null)), { headerOnly: true });
        }
        // A seat value of every type, at his next seq and his first gap.
        if (isSession && (where === "next" || seq === gaps[0])) {
          for (const [kind, v] of Object.entries(SEAT_VALUES)) {
            at(`binding-${kind}`, (c) => rawAt(c, seq, "_dai_binding", MUTANT(2), { seat: v }, session));
            at(`confirm-${kind}`, (c) => rawAt(c, seq, "_dai_confirm", MUTANT(3), { seat: v, holder: others[0].author }, session));
            for (const table of authorTables) {
              const template = templateOf(table, session);
              if (template && "seat" in template) at(`${table}-${kind}`, (c) => rawAt(c, seq, table, MUTANT(5), { ...columnsOf(template), seat: v }, session));
            }
          }
        }
        // A bad seat value, as a confirm's seat and as its holder, signed in one
        // batch beside a row of an author table: it costs nothing but its own
        // row, and a merge that throws on it is a violation (H1).
        if (isSession && where === "next") {
          const table = authorTables.find((t) => templateOf(t, session));
          for (const [kind, v] of Object.entries(SEAT_VALUES).filter(([kind]) => kind !== "bytes")) {
            if (!table) break;
            const beside = { table, entity: MUTANT(6), columns: columnsOf(templateOf(table, session)) };
            at(`bad-seat-${kind}`, (c) => badSeatValueAt(c, seq, session, { seat: v, holder: others[0].author }, beside));
            at(`bad-holder-${kind}`, (c) => badSeatValueAt(c, seq, session, { seat: values[0] ?? FRESH_SEAT, holder: v }, beside));
          }
        }
      }
    }
  }
  return mutations;
}

/** Builds a mutation's sibling: written and sealed in an empty copy of its author's. */
async function mutantOf(empty, mutation) {
  const scratch = fromBytes(empty);
  asReplica(scratch, mutation.author.author);
  try {
    mutation.write(scratch);
  } catch (error) {
    scratch.close();
    return { unwritable: String(error.message ?? error).split("\n")[0] };
  }
  // The same rows as no header covers them: what P0's uncovered row holds.
  const pending = scratch.tables.flatMap((table) => scratch.all(`SELECT * FROM "${table}"`).map((row) => ({ table, row })));
  const ids = await seal(scratch, mutation.author);
  if (ids.length !== 1) throw new Error(`${mutation.name}: sealed ${ids.length} headers`);
  let copy = scratch;
  if (mutation.headerOnly) {
    copy = fromBytes(empty);
    carryHeaderOnly(copy, scratch, ids[0]);
    scratch.close();
  }
  const verdicts = await verifyBatches(copy, copy.tables, DOC);
  const [header] = copy.all("SELECT * FROM _dai_batch");
  const rows = copy.tables.flatMap((table) => copy.all(`SELECT * FROM "${table}"`).map((row) => ({ table, row: encodeRow(row) })));
  return {
    copy,
    verdicts,
    pending,
    json: {
      id: ids[0],
      header: encodeRow(header),
      rows,
      verdicts: Object.fromEntries([...verdicts].map(([k, v]) => [k, verdictText(v)])),
      lists: {},
      pending: pending.map(({ table, row }) => ({ table, row: encodeRow(row) })),
    },
  };
}

/** Pairs of an author's headers over one seq with different digests: his equivocation, as the headers show it. */
function conflictsOf(items) {
  const byAuthor = new Map();
  for (const item of items) {
    const verdict = item.verdicts.get(item.id);
    if (!verdict?.ok) continue;
    const key = hexOf(item.author);
    const header = item.copy.all("SELECT digest, covers FROM _dai_batch")[0];
    const seqs = new Set(JSON.parse(header.covers).map(([, s]) => Number(s)));
    (byAuthor.get(key) ?? byAuthor.set(key, []).get(key)).push({ item, digest: hexOf(header.digest), seqs });
  }
  const found = [];
  for (const [author, headers] of byAuthor) {
    const pairs = [];
    for (let i = 0; i < headers.length; i += 1)
      for (let j = i + 1; j < headers.length; j += 1)
        if (headers[i].digest !== headers[j].digest && [...headers[i].seqs].some((s) => headers[j].seqs.has(s))) pairs.push([headers[i].item.id, headers[j].item.id]);
    if (pairs.length) {
      const ids = [...new Set(pairs.flat())].sort();
      found.push({ author, ids, pairs });
    }
  }
  return found;
}
/** An author's standing in a dump: his holds, his admitted rows, and the sessions closed. */
function standingOf(dump, authorHex) {
  const found = sections(dump);
  const lines = [];
  for (const [name, rows] of Object.entries(found)) {
    if (name === "holders") lines.push(...rows.filter((r) => r.endsWith(`\t${authorHex}`)).map((r) => `hold ${r}`));
    else if (name === "closed") lines.push(...rows.map((r) => `closed ${r}`));
    else if (!ROSTER_SECTIONS.has(name)) lines.push(...rows.filter((r) => r.startsWith(`${authorHex}:`)).map((r) => `${name} ${r}`));
  }
  return lines.sort().join("\n");
}

/**
 * An author's holds and admitted rows in `copy` (whose admitted dump is
 * `dump`), as "hold <session> <seat> <author>" and "<table> <row id>": a row
 * a later version hides is admitted all the same.
 */
function admittedOf(copy, dump, authorHex) {
  const lines = [];
  for (const [name, rows] of Object.entries(sections(dump))) {
    if (name === "holders") lines.push(...rows.filter((r) => r.endsWith(`\t${authorHex}`)).map((r) => `hold ${r}`));
  }
  for (const table of copy.tables) {
    const heads = new Set((sections(dump)[table] ?? []).map((r) => r.split("\t")[0]));
    for (const { id } of copy.all(`SELECT lower(hex(_r_replica)) || ':' || _r_seq AS id FROM "${table}" WHERE lower(hex(_r_replica)) = ?`, [authorHex])) {
      if (heads.has(id) || admittedThough(copy, table, id)) lines.push(`${table} ${id}`);
    }
  }
  return lines.sort();
}

/**
 * What showing his signing twice gains an author: for a set of his headers
 * that shows it and a smaller set that does not, the holds and admitted rows
 * the first gives him and the second does not, leaving out rows that only the
 * headers the first adds list. The first such pair, or nothing.
 */
function gainsOf(subsets, listed) {
  for (const shown of subsets.filter((s) => s.revealing)) {
    for (const short of subsets.filter((s) => !s.revealing && s.subset.every((h) => shown.subset.includes(h)))) {
      const added = new Set(shown.subset.filter((h) => !short.subset.includes(h)).flatMap((h) => listed[h]));
      const had = new Set(short.admitted);
      const gained = shown.admitted.filter((line) => !had.has(line) && (line.startsWith("hold ") || !added.has(line.split(" ")[1])));
      if (gained.length) return { shown: shown.subset.map((h) => h.slice(0, 8)), short: short.subset.map((h) => h.slice(0, 8)), gained };
    }
  }
  return null;
}

const known = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, "utf8")) : {};
const violations = [];
const violation = (v) => {
  v.key = `${v.property} ${v.vector} ${v.at}`;
  violations.push(v);
};

const names = readdirSync(suite, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(suite, d.name, "a.db")))
  .map((d) => d.name)
  .filter((n) => !only || only.has(n))
  .sort();
if (only && names.length !== only.size) {
  console.error(`--only names a vector the suite does not have: ${[...only].filter((n) => !names.includes(n)).join(", ")}`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let counted = { orders: 0, uncovered: 0, mutations: 0, unwritable: 0, merges: 0, subsets: 0 };
const started = Date.now();
for (const name of names) {
  const dir = join(suite, name);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const sources = {};
  for (const label of ["a", "b"]) sources[label] = fromBytes(readFileSync(join(dir, `${label}.db`)));
  const schema = schemaOf(sources.a);
  const empty = emptyOf(schema);
  const view = manifest.a.view;
  const bound = manifest.a.session?.max_parties ?? 2;
  const observerCopy = fromBytes(empty);
  asReplica(observerCopy, OBSERVER);
  const observer = bytesOf(observerCopy);
  observerCopy.close();

  const sets = {
    union: await itemsOf([{ copy: sources.a, view: manifest.a.view }, { copy: sources.b, view: manifest.b.view }], empty),
    a: await itemsOf([{ copy: sources.a, view: manifest.a.view }], empty),
    b: await itemsOf([{ copy: sources.b, view: manifest.b.view }], empty),
  };
  const items = sets.union;
  const scenario = {
    name,
    schema,
    view,
    max_parties: bound,
    observer: hexOf(OBSERVER),
    people: shownName,
    items: Object.fromEntries(Object.entries(sets).map(([k, list]) => [k, list.map((i) => i.json)])),
    p0: { orders: [], states: {} },
    p1: [],
    p2: [],
  };

  // P0: every order (or the sample), each prefix taken once, in a savepoint the orders sharing it roll back to.
  {
    const orders = ordersFor(name, items.length);
    // Every distinct state and its reports, for the Python reader; and every distinct admitted state, for P0.
    const seen = new Map();
    const admitted = new Map();
    const local = fromBytes(observer);
    const finish = (order, reports) => {
      const text = signature(local, reports);
      if (!seen.has(text)) seen.set(text, order);
      const state = text.split("# reports\n")[0];
      if (!admitted.has(state)) admitted.set(state, order);
      counted.orders += 1;
    };
    if (items.length <= EXHAUSTIVE) {
      const go = (path, reports) => {
        if (path.length === items.length) return finish(path, reports);
        for (let i = 0; i < items.length; i += 1) {
          if (path.includes(i)) continue;
          trying(local, () => go([...path, i], [...reports, ...replay(local, [items[i]], view)]));
        }
      };
      go([], []);
    } else {
      for (const order of orders) trying(local, () => finish(order, replay(local, order.map((i) => items[i]), view)));
    }
    local.close();
    scenario.p0.orders = items.length <= EXHAUSTIVE ? "all" : orders;
    scenario.p0.states = [...seen.keys()];
    if (admitted.size > 1) {
      const [[first, o1], [second, o2]] = [...admitted];
      violation({ property: "P0", vector: name, at: "state", states: admitted.size, orders: [o1.map((i) => items[i].id.slice(0, 8)), o2.map((i) => items[i].id.slice(0, 8))], difference: firstDifference(first, second) });
    }
  }

  // P1: each base, before and after each addition.
  {
    /** The addition taken into `local` (in a trial): what it removed, and a violation if nothing excuses it. */
    const check = (local, before, label, mutationName, sibling, author) =>
      trying(local, () => {
        let reports;
        try {
          reports = arrive(local, sibling, view);
        } catch (error) {
          // A merge that throws takes nothing, the rows that count beside the bad one included.
          const threw = String(error?.message ?? error).split("\n")[0];
          violation({ property: "P1", vector: name, at: `${label} ${mutationName}`, author, removed: [`the merge threw: ${threw}`], reports: [] });
          return { after: before, reports: [], removed: [], threw };
        }
        counted.merges += 1;
        const after = admittedDump(local);
        const now = new Set(admittedAndHeld(after));
        const removed = admittedAndHeld(before).filter((line) => {
          if (now.has(line)) return false;
          if (line.startsWith("hold ")) return true;
          // A head no longer one: removed only if it is no longer admitted.
          const [table, rest] = line.split(" ");
          return !admittedThough(local, table, rest.split("\t")[0]);
        });
        if (removed.length > 0 && !reports.some((r) => r.endsWith(" AUTHOR_EQUIVOCATED"))) {
          violation({ property: "P1", vector: name, at: `${label} ${mutationName}`, author, removed, reports });
        }
        return { after, reports, removed };
      });
    const bases = {};
    for (const [label, list] of Object.entries(sets)) {
      const local = fromBytes(observer);
      replay(local, list, view);
      bases[label] = { local, dump: admittedDump(local) };
    }
    /*
     * P0's uncovered row (D194): the mutation's rows written into the base as
     * they stand before any seal, under their author's id, no header covering
     * them and no merge taking them. The base is the observer, whose own id is
     * no author's, so each is a row under another author's id; what the base
     * admits must not move. A row at an id the base holds in that table is not
     * written (a second row at one id is the merge's question).
     */
    const isSession = bases.union.local.tables.includes("_dai_seat");
    const uncovered = (local, before, label, mutationName, pending) =>
      trying(local, () => {
        let written = 0;
        for (const { table, row } of pending) {
          const columns = Object.keys(row);
          try {
            local.run(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, columns.map((c) => row[c]));
            written += 1;
          } catch {}
        }
        if (written === 0) return { written };
        counted.uncovered += 1;
        const after = admittedDump(local);
        if (after !== before) violation({ property: "P0", vector: name, at: `uncovered ${label} ${mutationName}`, difference: firstDifference(before, after) });
        return { written, after };
      });
    for (const mutation of mutationsFor(bases.union.local)) {
      const built = await mutantOf(empty, mutation);
      if (built.unwritable) {
        counted.unwritable += 1;
        continue;
      }
      counted.mutations += 1;
      const sibling = { copy: built.copy, verdicts: built.verdicts, view };
      const record = { name: mutation.name, ...built.json, results: {} };
      for (const [label, base] of Object.entries(bases)) record.results[label] = check(base.local, base.dump, label, mutation.name, sibling, mutation.author.name);
      if (isSession && !mutation.headerOnly) {
        record.uncovered = {};
        for (const [label, base] of Object.entries(bases)) record.uncovered[label] = uncovered(base.local, base.dump, label, mutation.name, built.pending);
      } else delete record.pending;
      if (deep) deepSiblings.push({ mutation, sibling });
      else built.copy.close();
      scenario.p1.push(record);
    }
    // --deep: every mutation from every set of the vector's headers a copy can hold, not from A, B and both only.
    if (deep) {
      const local = fromBytes(observer);
      const found = new Set();
      const go = (index, mask) => {
        if (index === items.length) {
          const before = admittedDump(local);
          for (const { mutation, sibling } of deepSiblings) {
            if (found.has(mutation.name)) continue;
            const count = violations.length;
            check(local, before, `holding ${mask.toString(2)}`, mutation.name, sibling, mutation.author.name);
            if (violations.length > count) found.add(mutation.name);
          }
          return;
        }
        go(index + 1, mask);
        trying(local, () => (replay(local, [items[index]], view), go(index + 1, mask | (1 << index))));
      };
      if (items.length <= HELD_EXHAUSTIVE) go(0, 0);
      local.close();
      for (const { sibling } of deepSiblings.splice(0)) sibling.copy.close();
    }
    for (const base of Object.values(bases)) base.local.close();
    /*
     * The vector's own headers, held back and released later: from every set
     * of them a copy can hold (every set up to HELD_EXHAUSTIVE items, beyond
     * that HELD_SAMPLES sets drawn from the vector's seed), each header the set
     * lacks, released alone. One violation per header released, with the first
     * set it was found from.
     */
    const local = fromBytes(observer);
    const holding = [];
    if (items.length <= HELD_EXHAUSTIVE) for (let mask = 0; mask < 1 << items.length; mask += 1) holding.push(mask);
    else {
      const random = seeded(`${name} held`);
      holding.push(0);
      while (holding.length < HELD_SAMPLES) holding.push([...items.keys()].reduce((mask, i) => (random() < 0.5 ? mask : mask | (1 << i)), 0));
    }
    const found = new Set();
    const go = (index, mask, wanted) => {
      if (index === items.length) {
        const before = admittedDump(local);
        for (const [i, item] of items.entries()) {
          if (mask & (1 << i)) continue;
          const label = `held:${nameOf(item.author)}:${item.id.slice(0, 8)}`;
          const count = violations.length;
          const result = check(local, before, "union", label, item, nameOf(item.author));
          if (violations.length > count) {
            if (found.has(label)) violations.pop();
            else {
              found.add(label);
              violations[violations.length - 1].holding = items.filter((_, j) => mask & (1 << j)).map((x) => x.id.slice(0, 8));
            }
          }
          scenario.p1.push({ name: label, held: i, holding: mask, results: { union: result } });
        }
        return;
      }
      const bit = 1 << index;
      if (wanted.some((m) => !(m & bit))) go(index + 1, mask, wanted.filter((m) => !(m & bit)));
      const taking = wanted.filter((m) => m & bit);
      if (taking.length) trying(local, () => (replay(local, [items[index]], view), go(index + 1, mask | bit, taking)));
    };
    go(0, 0, holding);
    local.close();
  }

  /*
   * P2: each author signing twice. His standing over every set of his
   * conflicting headers a copy can hold (taken after everything else): the same
   * for every set that shows him signing twice, so he cannot choose by
   * withholding; and no set that shows it gives him a hold or an admitted row
   * that a set of the same headers short of showing it does not, so he cannot
   * gain by releasing (rows only the released headers list aside).
   */
  for (const { author, ids, pairs } of conflictsOf(items)) {
    const taken = ids.slice(0, SUBSET_LIMIT);
    const listed = Object.fromEntries(
      taken.map((hid) => [hid, JSON.parse(items.find((i) => i.id === hid).copy.all("SELECT covers FROM _dai_batch")[0].covers).map(([, seq]) => `${author}:${seq}`)]),
    );
    const local = fromBytes(observer);
    replay(local, items.filter((i) => !ids.includes(i.id)), view);
    const standings = new Map();
    const subsets = [];
    for (let mask = 1; mask < 1 << taken.length; mask += 1) {
      const subset = taken.filter((_, i) => mask & (1 << i));
      const revealing = pairs.some(([x, y]) => subset.includes(x) && subset.includes(y));
      const { standing, admitted } = trying(local, () => {
        replay(local, subset.map((hid) => items.find((i) => i.id === hid)), view);
        const dump = admittedDump(local);
        return { standing: standingOf(dump, author), admitted: admittedOf(local, dump, author) };
      });
      counted.subsets += 1;
      subsets.push({ subset, revealing, standing, admitted });
      if (revealing && !standings.has(standing)) standings.set(standing, subset);
    }
    local.close();
    scenario.p2.push({ author, ids: taken, all: ids, pairs, subsets });
    const who = nameOf(Buffer.from(author, "hex"));
    if (standings.size > 1) {
      const [[s1, x], [s2, y]] = [...standings];
      violation({ property: "P2", vector: name, at: `${who} chooses`, standings: standings.size, subsets: [x.map((h) => h.slice(0, 8)), y.map((h) => h.slice(0, 8))], difference: firstDifference(s1, s2) });
    }
    const gained = gainsOf(subsets, listed);
    if (gained) violation({ property: "P2", vector: name, at: `${who} gains`, ...gained });
  }

  writeFileSync(join(out, `${name}.json`), JSON.stringify(scenario));
  for (const list of Object.values(sets)) for (const item of list) item.copy.close();
  sources.a.close();
  sources.b.close();
  process.stdout.write(`${name}: ${items.length} items\n`);
}

const filed = [];
const unfiled = [];
for (const v of violations) (known[v.key] ? filed : unfiled).push(v);
const gone = only ? [] : Object.keys(known).filter((key) => key.startsWith("P") && !violations.some((v) => v.key === key));
const show = (v) => `  ${v.key}${known[v.key] ? ` (filed: ${known[v.key]})` : ""}\n    ${JSON.stringify({ ...v, key: undefined, property: undefined, vector: undefined, at: undefined })}`;
for (const v of listAll ? violations : unfiled) console.log(show(v));
if (!listAll && filed.length) console.log(`${filed.length} filed violation(s) occurred, as scripts/properties-known.json says.`);
for (const key of gone) console.log(`  filed and no longer occurring: ${key}`);
console.log(
  `\n${names.length} vectors: P0 ${counted.orders} orders and ${counted.uncovered} uncovered rows, P1 ${counted.mutations} mutations (${counted.unwritable} not writable), P2 ${counted.subsets} subsets, ${counted.merges} merges, ${((Date.now() - started) / 1000).toFixed(1)} s. ` +
    `${violations.length} violation(s), ${unfiled.length} unfiled. Scenarios for the Python reader in ${out}.`,
);
process.exit(unfiled.length > 0 || gone.length > 0 ? 1 : 0);
