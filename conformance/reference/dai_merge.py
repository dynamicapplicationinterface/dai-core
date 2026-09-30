"""The Level 1 union merge, implemented from docs/replicated-tables.md.

    python conformance/reference/dai_merge.py            # every fixture
    python conformance/reference/dai_merge.py <name>     # one of them

Reads the checked-in fixtures, performs its own merge in both directions, and
diffs its own canonical dump against the expected text beside them. It never
reads the TypeScript generator's output at run time: the point of a second
implementation is that it agrees about the answer, and a gate where one side
produces what the other checks is a gate against nothing.

Written from the specification rather than translated from the other reader.
That is the whole exercise — the parts of a spec that are unclear are exactly
the parts two implementations get differently, and translating would hide them.
The independence is real but limited while one person writes both; the fixtures
are checked in so a third implementation can be held to the same text.

Level 1: no signatures, no keys. A replica id is a claim.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import sqlite3
import sys
from pathlib import Path

SUITE = Path(__file__).resolve().parents[1] / "merge"

# The roster tables a session document carries beside its author tables: who
# created a session, who asked for its open seat, whom the creator confirmed,
# and the close (docs/identity.md, step 5). Named by the spec, so listed here.
ROSTER = ("_dai_binding", "_dai_close", "_dai_confirm", "_dai_seat")

# The one shape a row's parents take (D159): a JSON array of at most 256 row
# ids, each 32 lowercase hex digits, a colon and a seq from 1, a safe integer.
PARENTS_CAP = 256
PARENT_ID = re.compile(r"[0-9a-f]{32}:[1-9][0-9]{0,15}")
SAFE_INTEGER = 2**53 - 1


# ----------------------------------------------------------------- the dump


def encode(value: object) -> str:
    """One value, in the encoding T1-D9 fixes.

    The rows are the easy part. Two languages agree on which rows are present
    and disagree on how to print a float, and then the merge takes the blame —
    which is why the four special cases below are spelled out rather than left
    to `repr`.
    """
    if value is None:
        return "nil"
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    if isinstance(value, bool):  # before int: bool is an int in Python
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if value == math.inf:
            return "inf"
        if value == -math.inf:
            return "-inf"
        if value == 0.0 and math.copysign(1.0, value) < 0:
            return "-0.0"
        # repr gives the shortest string that round-trips, which is what the
        # spec asks for; it may omit the point on a whole number, and a REAL
        # that prints as an INTEGER is a difference nobody can see in a diff.
        text = repr(value)
        return text if ("." in text or "e" in text or "E" in text) else text + ".0"
    text = str(value)
    return text.replace("\\", "\\\\").replace("\t", "\\t").replace("\n", "\\n")


def replicated_tables(db: sqlite3.Connection) -> list[str]:
    """Every table carrying the replication columns.

    Discovered rather than configured: the fixtures are databases, not a
    manifest, and a reader that had to be told which tables to merge could be
    told wrongly.
    """
    names = []
    for (name,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_dai\\_%' ESCAPE '\\'"
    ):
        columns = [row[1] for row in db.execute(f'PRAGMA table_info("{name}")')]
        if "_r_replica" in columns and "_r_seq" in columns:
            names.append(name)
    # And the roster tables, where the document has them: they are signed rows
    # like any other and merge by the same rules.
    present = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    names.extend(name for name in ROSTER if name in present)
    return sorted(names)


def columns_of(db: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in db.execute(f'PRAGMA table_info("{table}")')]


def canonical_dump(db: sqlite3.Connection, tables: list[str]) -> str:
    lines: list[str] = []
    for table in sorted(tables):
        names = columns_of(db, table)
        lines.append(f"# {table}")
        rows = db.execute(
            f'SELECT * FROM "{table}" ORDER BY hex(_r_replica) ASC, _r_seq ASC'
        ).fetchall()
        for row in rows:
            lines.append("\t".join(encode(value) for value in row))
    # Ids only: first_seen and rows_seen are this copy's own history and cannot
    # converge, and a label at Level 1 is a claim nothing propagates (T1-D12).
    lines.append("# _dai_replicas")
    for (rid,) in db.execute("SELECT id FROM _dai_replicas ORDER BY hex(id) ASC"):
        lines.append(encode(rid))
    # The signed batch headers, every column: the same bytes on every copy that
    # holds one, so two copies that merged agree on the set (docs/identity.md).
    if db.execute("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'").fetchone():
        lines.append("# _dai_batch")
        for header in db.execute(
            "SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch ORDER BY hex(id) ASC"
        ):
            lines.append("\t".join(encode(value) for value in header))
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- the merge


def replicated_schema_of(db: sqlite3.Connection) -> str:
    """The replicated schema, canonicalised (T1-D21).

    Over the author's columns, recovered from the table, and never over the
    CREATE TABLE text SQLite stores: that text is the compiler's output, and
    two conforming compilers could emit it differently while both being right.
    Comparing it would refuse a merge between two copies of one document built
    by different tools — a disagreement about whether a merge may happen, which
    no row-level fixture can catch because the rows never get compared.
    """
    lines: list[str] = []
    # The author's tables: the roster tables are the format's, the same in
    # every session document, and not the author's to declare.
    for table in sorted(t for t in replicated_tables(db) if t not in ROSTER):
        for _cid, name, decl, notnull, default, _pk in db.execute(
            f'PRAGMA table_info("{table}")'
        ):
            if name.startswith("_r_"):
                continue
            lines.append(
                "\t".join(
                    [
                        table,
                        name,
                        # Case-folded, whitespace collapsed. SQLite treats
                        # `text` and `TEXT` alike, and `VARCHAR( 20 )` and
                        # `VARCHAR(20)` alike; two tools spell both ways and
                        # neither is a difference of schema.
                        " ".join((decl or "").split()).upper(),
                        "NOT NULL" if notnull else "",
                        # Verbatim: normalising a literal is how two readers
                        # begin disagreeing about what a default means.
                        "" if default is None else str(default),
                    ]
                )
            )
    return "\n".join(lines) + "\n"


def row_id(replica: bytes, seq: int) -> str:
    return f"{bytes(replica).hex()}:{seq}"


def parents_of(text: str) -> list[str]:
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def well_formed_parents(text: object) -> bool:
    """Whether a row's parents are the one shape (D159)."""
    if not isinstance(text, str):
        return False
    try:
        value = json.loads(text)
    except ValueError:
        return False
    if not isinstance(value, list) or len(value) > PARENTS_CAP:
        return False
    return all(
        isinstance(item, str) and PARENT_ID.fullmatch(item) is not None and int(item[33:]) <= SAFE_INTEGER
        for item in value
    )


def rid_of(row: dict) -> str:
    return row_id(row["_r_replica"], row["_r_seq"])


def session_id(author: object, seq: object) -> bytes | None:
    """SHA-256 of the author id and the seq as eight bytes big-endian, first 16 bytes (D158)."""
    if not isinstance(author, (bytes, bytearray)) or len(author) != 16:
        return None
    if not isinstance(seq, int) or seq < 0 or seq >= 2**64:
        return None
    return hashlib.sha256(bytes(author) + seq.to_bytes(8, "big")).digest()[:16]


def equivocated_ids(db: sqlite3.Connection) -> set[tuple[bytes, str, int]]:
    """Equivocation (D160; docs/format.md#equivocation): one author's two
    headers listing one seq, in any tables, with different digests. Returned as
    every (author, table, seq) a header lists at such an id, one per table; the
    id itself is (author, seq). From the headers' own lists."""
    digests: dict[tuple[bytes, int], set[bytes]] = {}
    listings: set[tuple[bytes, str, int]] = set()
    has_batch = db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_dai_batch'").fetchone()
    for author, digest, covers in db.execute("SELECT author, digest, covers FROM _dai_batch") if has_batch else []:
        try:
            listed = json.loads(covers)
        except (ValueError, TypeError):
            listed = []
        for entry in listed if isinstance(listed, list) else []:
            if isinstance(entry, list) and len(entry) == 2:
                digests.setdefault((bytes(author), entry[1]), set()).add(bytes(digest))
                listings.add((bytes(author), entry[0], entry[1]))
    return {(author, table, seq) for author, table, seq in listings if len(digests[(author, seq)]) > 1}


def ids_of(listings: set[tuple[bytes, str, int]]) -> set[tuple[bytes, int]]:
    """The equivocated ids, (author, seq), whatever tables list them."""
    return {(author, seq) for author, _table, seq in listings}


# ------------------------------------------------------------- admission


class Admission:
    """What a session document admits, computed from its tables (backlog D171).

    Written from the rules in docs/identity.md and docs/format.md, over the
    stored rows and headers, never the document's own views: a reader that read
    the runtime's views would be the runtime agreeing with itself. The two
    views it reads are declarations the schema carries, not computations: which
    table is seated and by which column, and which tables have an author role.
    The close rule is `any` in every vector (D171).
    """

    def __init__(self, db: sqlite3.Connection, tables: list[str]):
        self.tables = tables
        self.rows: dict[str, list[dict]] = {}
        self.sessioned: set[str] = set()
        for table in tables:
            names = columns_of(db, table)
            if "_r_session" in names:
                self.sessioned.add(table)
            self.rows[table] = [dict(zip(names, raw)) for raw in db.execute(f'SELECT * FROM "{table}"')]
        views = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'view'")}
        self.seated = dict(db.execute("SELECT tbl, col FROM _dai_seat_rules")) if "_dai_seat_rules" in views else {}
        self.roles = dict(db.execute("SELECT tbl, author FROM _dai_author_rules")) if "_dai_author_rules" in views else {}

        self.equivocated = equivocated_ids(db)
        self.equivocated_at = ids_of(self.equivocated)
        self.equivocated_text = {f"{author.hex()}:{seq}" for author, seq in self.equivocated_at}

        # The creator's seat row: the one row whose own (author, seq) hashes to
        # its session (D158).
        self.creators: set[tuple[bytes, bytes, bytes, bytes]] = set()
        for s in self.rows.get("_dai_seat", []):
            if s["_r_deleted"] == 0 and self.unequivocal(s) and session_id(s["_r_replica"], s["_r_seq"]) == bytes(s["_r_session"]):
                self.creators.add((bytes(s["_r_session"]), bytes(s["_r_replica"]), bytes(s["seat"]), bytes(s["_r_entity"])))
        creator_seats: dict[bytes, set[bytes]] = {}
        for session, _replica, seat, _entity in self.creators:
            creator_seats.setdefault(session, set()).add(seat)
        self.creator_of = {(session, replica) for session, replica, _seat, _entity in self.creators}

        # Her confirms of an open seat; one per seat, or the seat is void (D165).
        # Deleted or not, superseded or not: a hold never moves once made, so a
        # delete of a confirm is another confirm (D171).
        confirmed = []
        for f in self.rows.get("_dai_confirm", []):
            session = bytes(f["_r_session"])
            if (
                self.unequivocal(f)
                and (session, bytes(f["_r_replica"])) in self.creator_of
                and bytes(f["seat"]) not in creator_seats.get(session, set())
            ):
                confirmed.append((session, bytes(f["seat"]), bytes(f["holder"]), bytes(f["_r_replica"])))
        self.voided = {
            (session, seat, creator)
            for session, seat, holder, creator in confirmed
            if any(o[0] == session and o[1] == seat and o[2] != holder for o in confirmed)
        }
        void_seats = {(session, seat) for session, seat, _creator in self.voided}
        self.holders = {(session, seat, replica) for session, replica, seat, _entity in self.creators}
        self.holders |= {(session, seat, holder) for session, seat, holder, _c in confirmed if (session, seat) not in void_seats}
        self.members = {(session, replica) for session, _seat, replica in self.holders}

        # A close counts when a member wrote it and it is not a delete (the
        # rule `any`, D146, D153); it binds only its author (D151).
        self.closes = [
            x
            for x in self.rows.get("_dai_close", [])
            if x["_r_deleted"] == 0
            and (bytes(x["_r_session"]), bytes(x["_r_replica"])) in self.members
            and self.unequivocal(x)
        ]
        self.closed = {bytes(x["_r_session"]) for x in self.closes}

    def unequivocal(self, row: dict) -> bool:
        return (bytes(row["_r_replica"]), row["_r_seq"]) not in self.equivocated_at

    def names_equivocated(self, row: dict) -> bool:
        """It names an equivocated id as a parent (docs/format.md#admitted-parent-equivocated):
        not admitted and not reported, whatever that id holds here."""
        return any(parent in self.equivocated_text for parent in parents_of(row["_r_parents"]))

    def filtered(self, table: str) -> bool:
        """An author table of a session document: its heads are over admitted rows (T1-D29)."""
        return table not in ROSTER and table in self.sessioned

    def not_late(self, row: dict) -> bool:
        return not any(
            bytes(x["_r_session"]) == bytes(row["_r_session"])
            and bytes(x["_r_replica"]) == bytes(row["_r_replica"])
            and x["_r_seq"] < row["_r_seq"]
            for x in self.closes
        )

    def named(self, table: str, row: dict) -> list[dict]:
        """The rows of its own entity that this row names as earlier versions."""
        wanted = set(parents_of(row["_r_parents"]))
        return [p for p in self.rows[table] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]

    def foreign(self, table: str, row: dict) -> bool:
        return any(bytes(p["_r_session"]) != bytes(row["_r_session"]) for p in self.named(table, row))

    def other_seat(self, table: str, row: dict) -> bool:
        column = self.seated[table]
        return any(
            bytes(p["_r_session"]) == bytes(row["_r_session"]) and p[column] != row[column] for p in self.named(table, row)
        )

    def holds(self, table: str, row: dict) -> bool:
        seat = row[self.seated[table]]
        return isinstance(seat, bytes) and (bytes(row["_r_session"]), seat, bytes(row["_r_replica"])) in self.holders

    def admitted(self, table: str, row: dict) -> bool:
        session, replica = bytes(row["_r_session"]), bytes(row["_r_replica"])
        role = self.roles.get(table)
        if role == "creator" and (session, replica) not in self.creator_of:
            return False
        if role == "joiner" and (session, replica) in self.creator_of:
            return False
        if table in self.seated:
            if not self.holds(table, row) or self.other_seat(table, row):
                return False
        elif (session, replica) not in self.members:
            return False
        return (
            not self.foreign(table, row)
            and self.not_late(row)
            and self.unequivocal(row)
            and not self.names_equivocated(row)
        )

    def heads(self, table: str) -> list[dict]:
        rows = self.rows[table]
        session = table in self.sessioned
        found = []
        for r in rows:
            me = rid_of(r)
            if self.filtered(table):
                if not self.admitted(table, r):
                    continue
                column = self.seated.get(table)
                hidden = any(
                    bytes(c["_r_entity"]) == bytes(r["_r_entity"])
                    and bytes(c["_r_session"]) == bytes(r["_r_session"])
                    and (column is None or (c[column] is not None and c[column] == r[column]))
                    and self.admitted(table, c)
                    and me in parents_of(c["_r_parents"])
                    for c in rows
                )
            else:
                if not self.unequivocal(r):
                    continue
                hidden = any(
                    bytes(c["_r_entity"]) == bytes(r["_r_entity"])
                    and (not session or (bytes(c["_r_session"]) == bytes(r["_r_session"]) and bytes(c["_r_replica"]) == bytes(r["_r_replica"])))
                    and self.unequivocal(c)
                    and me in parents_of(c["_r_parents"])
                    for c in rows
                )
            if not hidden:
                found.append(r)
        return sorted(found, key=lambda r: (bytes(r["_r_replica"]).hex(), r["_r_seq"]))

    def unseated(self, table: str, row: dict) -> bool:
        """What a merge reports as SEAT_NOT_HELD: no seat, a seat someone else holds, or another seat's row named.

        Never a row naming an equivocated id, nor a row at one: that is
        reported only as its author signing twice (R9)."""
        if self.names_equivocated(row) or not self.unequivocal(row):
            return False
        seat = row[self.seated[table]]
        if not isinstance(seat, bytes) or len(seat) != 16:
            return True
        held = any(h[0] == bytes(row["_r_session"]) and h[1] == seat for h in self.holders)
        return (held and not self.holds(table, row)) or self.other_seat(table, row)

    def crossings(self, table: str) -> list[tuple[str, dict, dict]]:
        """(reason, row, the row it names) for every row naming another session's or another seat's version."""
        found = []
        for r in self.rows[table]:
            if self.names_equivocated(r) or not self.unequivocal(r):
                continue
            for p in self.named(table, r):
                if bytes(p["_r_session"]) != bytes(r["_r_session"]):
                    found.append(("ENTITY_OTHER_SESSION", r, p))
                if table in self.seated:
                    column = self.seated[table]
                    if bytes(p["_r_session"]) == bytes(r["_r_session"]) and p[column] != r[column]:
                        found.append(("SEAT_NOT_HELD", r, p))
        return found


def is_session(db: sqlite3.Connection) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_dai_seat'").fetchone() is not None


def admitted_dump(db: sqlite3.Connection) -> str:
    """The admitted state in the text expected-admitted-*.txt holds (backlog D171)."""
    tables = replicated_tables(db)
    admission = Admission(db, tables)
    lines: list[str] = []
    for table in tables:
        lines.append(f"# {table}")
        lines.extend(f"{rid_of(r)}\t{r['_r_deleted']}" for r in admission.heads(table))
    lines.append("# holders")
    lines.extend("\t".join(part.hex() for part in h) for h in sorted(admission.holders, key=lambda h: tuple(p.hex() for p in h)))
    lines.append("# voided")
    lines.extend("\t".join(part.hex() for part in v) for v in sorted(admission.voided, key=lambda v: tuple(p.hex() for p in v)))
    lines.append("# equivocated")
    for author, table, seq in sorted(admission.equivocated, key=lambda e: (e[0].hex(), e[1], e[2])):
        lines.append(f"{author.hex()}\t{table}\t{seq}")
    lines.append("# closed")
    lines.extend(session.hex() for session in sorted(admission.closed, key=bytes.hex))
    return "\n".join(lines) + "\n"


def apply_row(db: sqlite3.Connection, table: str, row: dict) -> str:
    """One row in, with the supersession flag kept true of the row set (T1-D2)."""
    authored = [name for name in columns_of(db, table) if not name.startswith("_r_")]
    rid = row_id(row["_r_replica"], row["_r_seq"])

    held = db.execute(
        f'SELECT * FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?',
        (row["_r_replica"], row["_r_seq"]),
    ).fetchone()

    if held is not None:
        names = columns_of(db, table)
        existing = dict(zip(names, held))
        # _r_superseded is excluded: it is derived local state, and the
        # sender's copy says what they have seen (T1-D11).
        same = (
            existing["_r_lc"] == row["_r_lc"]
            and bytes(existing["_r_entity"]) == bytes(row["_r_entity"])
            and existing["_r_parents"] == row["_r_parents"]
            and existing["_r_deleted"] == row["_r_deleted"]
            and ("_r_session" not in existing or existing["_r_session"] == row.get("_r_session"))
            and all(existing[name] == row["columns"].get(name) for name in authored)
        )
        if same:
            # The same row, sealed where this copy still holds it pending: it
            # takes the seal, once, from NULL (docs/identity.md, step 3).
            if existing.get("_r_batch") is None and row.get("_r_batch") is not None:
                db.execute(
                    f'UPDATE "{table}" SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ?',
                    (row["_r_batch"], row["_r_replica"], row["_r_seq"]),
                )
            return "duplicate"
        raise ValueError(f"ROW_REJECTED: a different row already exists as {rid}")

    # Superseded on arrival when something of its own entity present already
    # names this row. A merge delivers children before parents, so this is not a
    # rare case. Another entity's row naming it hides nothing (T1-D35).
    named = db.execute(
        f'SELECT 1 FROM "{table}", json_each("{table}"._r_parents)'
        f' WHERE json_each.value = ? AND "{table}"._r_entity = ? LIMIT 1',
        (rid, row["_r_entity"]),
    ).fetchone()

    names = authored + [
        "_r_replica", "_r_seq", "_r_lc", "_r_entity",
        "_r_parents", "_r_deleted", "_r_superseded", "_r_batch",
    ]
    values = [row["columns"].get(name) for name in authored] + [
        row["_r_replica"], row["_r_seq"], row["_r_lc"], row["_r_entity"],
        row["_r_parents"], row["_r_deleted"], 1 if named else 0, row.get("_r_batch"),
    ]
    # A session document's rows carry their session (T1-D29); it travels with
    # the row like the other carried fields, and a row without it is refused.
    if "_r_session" in columns_of(db, table):
        names.append("_r_session")
        values.append(row.get("_r_session"))
    placeholders = ", ".join("?" for _ in names)
    quoted = ", ".join(f'"{name}"' for name in names)
    db.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', values)

    for parent in parents_of(row["_r_parents"]):
        replica_hex, _, seq = parent.partition(":")
        if not seq.isdigit():
            continue
        db.execute(
            f'UPDATE "{table}" SET _r_superseded = 1'
            " WHERE hex(_r_replica) = ? AND _r_seq = ? AND _r_entity = ? AND _r_superseded = 0",
            (replica_hex.upper(), int(seq), row["_r_entity"]),
        )
    return "added"


def shown(author: bytes) -> str:
    """An author id as a person is shown it: base64url, no padding."""
    return base64.urlsafe_b64encode(bytes(author)).rstrip(b"=").decode("ascii")


def merge(local: sqlite3.Connection, sibling: sqlite3.Connection, verdicts: dict[str, str]) -> dict:
    """Union merge, taking only what a verified header lists (docs/format.md).

    `verdicts` is the signature check's answer for each of the sibling's
    headers, by id in lowercase hex: "ok" or a BATCH_ code. A header missing
    from it was not checked, and a header not checked is not signed.
    """
    tables = replicated_tables(local)
    result = {"applied": 0, "duplicate": 0, "rejected": [], "newReplicas": 0, "refusedBatches": []}
    refusals: dict[tuple[str, str, str], bytes] = {}  # (id, reason, author hex) -> author

    def refuse_batch(hid: str, author: bytes, reason: str) -> None:
        refusals[(hid, reason, bytes(author).hex())] = author

    # The headers that reveal an author signing twice (D160, D165), by author:
    # reported once per author, under the lowest of them (D171).
    revealed: dict[str, tuple[bytes, list[str]]] = {}

    def reveal(author: bytes, hid: str) -> None:
        revealed.setdefault(bytes(author).hex(), (bytes(author), []))[1].append(hid)

    equivocated_before = ids_of(equivocated_ids(local))

    # The seats void before anything arrives: a merge reports only the seats it
    # makes void (D165).
    session = is_session(local)
    voided_before = {(s, seat) for s, seat, _c in Admission(local, tables).voided} if session else set()

    # The clock first, and before any row: a local row written afterwards must
    # outrank what arrived, or it loses to its own ancestors under the
    # highest-_r_lc pick and the newest edit disappears behind an older one.
    before = local.execute("SELECT lc FROM _dai_replica").fetchone()[0]
    ceiling = before
    theirs = sibling.execute("SELECT lc FROM _dai_replica").fetchone()
    if theirs:
        ceiling = max(ceiling, theirs[0])
    for table in replicated_tables(sibling):
        highest = sibling.execute(f'SELECT max(_r_lc) FROM "{table}"').fetchone()[0]
        if highest is not None:
            ceiling = max(ceiling, highest)
    local.execute("UPDATE _dai_replica SET lc = ?", (ceiling,))

    # Union, and nothing more. A replica id seen is a replica id known;
    # anything further would be inventing an authority Level 1 does not have.
    known = {row[0] for row in local.execute("SELECT hex(id) FROM _dai_replicas")}
    seen = list(sibling.execute("SELECT id FROM _dai_replica")) + list(
        sibling.execute("SELECT id FROM _dai_replicas")
    )
    for (rid,) in seen:
        if bytes(rid).hex().upper() in known:
            continue
        known.add(bytes(rid).hex().upper())
        result["newReplicas"] += 1
        # The id, and nothing the sibling said about it. A label is a name
        # this copy gives a key, never one the key carries (T1-D12), so it is
        # not imported; first_seen is the local clock as it stood when the
        # merge began, not the ceiling it is about to become (T1-D19).
        local.execute(
            "INSERT INTO _dai_replicas (id, label, first_seen, rows_seen) VALUES (?, NULL, ?, 0)",
            (rid, before),
        )

    # The signed headers: a union by id of the verified ones, before any row.
    # A header lists the rows it covers as [table, seq], its author being its
    # own; a row's _r_batch is a cache of one header that lists it, never the truth.
    has_batches = lambda db: db.execute(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '_dai_batch'"
    ).fetchone()
    held: dict[str, bytes] = {}
    covering: dict[str, str] = {}  # "table|author:seq" -> the lowest ok id listing it
    covers: set[str] = set()  # "id|table|author:seq"
    # A row whose parents are not the one shape is refused before anything else
    # reads it, and so is every row of a complete batch that signed one: the
    # author signed them together, and that header is not kept (D159).
    malformed = {
        f"{table}|{row_id(r_replica, r_seq)}"
        for table in tables
        for r_replica, r_seq, r_parents in sibling.execute(f'SELECT _r_replica, _r_seq, _r_parents FROM "{table}"')
        if not well_formed_parents(r_parents)
    }
    tainted: set[str] = set()
    if has_batches(local) and has_batches(sibling):
        headers = sibling.execute(
            "SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch"
        ).fetchall()
        arrived = []
        for header in sorted(headers, key=lambda h: bytes(h[0]).hex()):
            hid = bytes(header[0]).hex()
            held[hid] = header[0]
            verdict = verdicts.get(hid, "BATCH_SIGNATURE_INVALID")
            if verdict not in ("ok", "incomplete"):
                refuse_batch(hid, header[1], verdict)
                continue
            listed = [f"{table}|{row_id(header[1], seq)}" for table, seq in json.loads(header[8])]
            if verdict == "ok" and any(key in malformed for key in listed):
                tainted.update(listed)
                refuse_batch(hid, header[1], "ROW_MALFORMED")
                continue
            # "incomplete": the author's header (batch format 2 signs its list),
            # whose rows the sibling does not hold as signed. Kept, so evidence
            # travels (D160), and no row is taken through it.
            new = local.execute("SELECT 1 FROM _dai_batch WHERE id = ?", (header[0],)).fetchone() is None
            local.execute(
                "INSERT OR IGNORE INTO _dai_batch (id, author, lc, sig, pub, att, version, digest, covers)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                header,
            )
            if new:
                arrived.append(header)
            if verdict != "ok":
                continue
            for key in listed:
                covers.add(f"{hid}|{key}")
                covering.setdefault(key, hid)
        # Equivocation (D160; docs/format.md#revealing-two-headers): a header
        # that arrived reveals it when it lists a seq that another header of
        # its author, held here now, lists in any table with a different
        # digest, and that was not signed twice here before. A third
        # conflicting header reveals nothing new (D171).
        for header in arrived:
            mine = {
                seq
                for _table, seq in json.loads(header[8])
                if (bytes(header[1]), seq) not in equivocated_before
            }
            for other_id, other_digest, other_covers in local.execute(
                "SELECT id, digest, covers FROM _dai_batch WHERE author = ?", (header[1],)
            ):
                if bytes(other_id) == bytes(header[0]) or bytes(other_digest) == bytes(header[7]):
                    continue
                if mine & {seq for _table, seq in json.loads(other_covers)}:
                    reveal(header[1], bytes(header[0]).hex())
                    break

    # Signed means listed by an ok header, whatever the row says. Signed rows
    # are placed first, unsigned after, so table order never decides.
    signed_rows: list[tuple[str, dict]] = []
    unsigned_rows: list[tuple[str, dict]] = []
    for table in tables:
        names = columns_of(sibling, table)
        authored = [name for name in names if not name.startswith("_r_")]
        for raw in sibling.execute(f'SELECT * FROM "{table}"').fetchall():
            incoming = dict(zip(names, raw))
            row = {
                "_r_replica": incoming["_r_replica"],
                "_r_seq": incoming["_r_seq"],
                "_r_lc": incoming["_r_lc"],
                "_r_entity": incoming["_r_entity"],
                "_r_parents": incoming["_r_parents"],
                "_r_deleted": incoming["_r_deleted"],
                "_r_batch": incoming.get("_r_batch"),
                "_r_session": incoming.get("_r_session"),
                "columns": {name: incoming[name] for name in authored},
            }
            key = f"{table}|{row_id(row['_r_replica'], row['_r_seq'])}"
            named = bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else None
            cover = covering.get(key)
            if key in malformed or (cover is None and key in tainted):
                # Never taken; reported once, with the batch that signed it, or
                # here when nothing complete did.
                if key not in tainted:
                    refuse_batch(named or "", row["_r_replica"], "ROW_MALFORMED")
                continue
            if cover is not None:
                keep = named if named is not None and f"{named}|{key}" in covers else cover
                row["_r_batch"] = held[keep]
                signed_rows.append((table, row))
            elif named is not None:
                # It names a header that does not vouch for it: refused in the
                # name of whoever wrote the row.
                if named not in held or verdicts.get(named) in ("ok", "incomplete"):
                    refuse_batch(named, row["_r_replica"], "BATCH_DIGEST_MISMATCH")
            elif local.execute(
                f'SELECT 1 FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?',
                (row["_r_replica"], row["_r_seq"]),
            ).fetchone() is not None:
                # Unsigned, and held here already at that id: not new, so the
                # ordinary path decides, a duplicate or a second row at one id.
                unsigned_rows.append((table, row))
            else:
                # Unsigned and new: nobody's key vouches for it, so it is refused
                # in every table (BATCH_UNSIGNED, batch format version 2), under
                # the id it carries.
                refuse_batch("", row["_r_replica"], "BATCH_UNSIGNED")

    def reject(rid: str) -> None:
        if rid not in result["rejected"]:
            result["rejected"].append(rid)

    def held_batch(table: str, row: dict):
        return local.execute(
            f'SELECT _r_batch FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?',
            (row["_r_replica"], row["_r_seq"]),
        ).fetchone()

    def displace(table: str, row: dict) -> None:
        # A signed row outranks an unsigned one at its id: the unsigned one goes,
        # and what it superseded is a head again unless something else of its
        # entity names it (T1-D35).
        (parents,) = local.execute(
            f'SELECT _r_parents FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?',
            (row["_r_replica"], row["_r_seq"]),
        ).fetchone()
        local.execute(
            f'DELETE FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?',
            (row["_r_replica"], row["_r_seq"]),
        )
        for parent in parents_of(parents):
            local.execute(
                f'UPDATE "{table}" SET _r_superseded = 0'
                " WHERE lower(hex(_r_replica)) || ':' || _r_seq = ? AND _r_superseded = 1"
                f' AND NOT EXISTS (SELECT 1 FROM "{table}" n, json_each(n._r_parents) p'
                f' WHERE p.value = ? AND n._r_entity = "{table}"._r_entity)',
                (parent, parent),
            )
        reject(row_id(row["_r_replica"], row["_r_seq"]))

    def place(table: str, row: dict, signed: bool) -> None:
        # One author's seq names one row, whatever table it is in: an unsigned
        # row at a seq another table holds is a collision.
        for other in tables:
            if other == table:
                continue
            there = held_batch(other, row)
            if there is None:
                continue
            if signed and there[0] is None:
                displace(other, row)
                continue
            # Two signed rows at one id in two tables are both taken: their
            # headers are equivocation (docs/format.md#row-one-id).
            if signed:
                continue
            raise ValueError(f"ROW_REJECTED: {row_id(row['_r_replica'], row['_r_seq'])} is a row of {other}")
        try:
            outcome = apply_row(local, table, row)
        except ValueError:
            there = held_batch(table, row)
            if not signed or there is None or there[0] is not None:
                raise
            displace(table, row)
            outcome = apply_row(local, table, row)
        result["applied" if outcome == "added" else "duplicate"] += 1
        if outcome == "added":
            added.append((table, row))

    added: list[tuple[str, dict]] = []
    for rows, signed in ((signed_rows, True), (unsigned_rows, False)):
        for table, row in rows:
            try:
                place(table, row, signed)
            except ValueError:
                # One refused row does not deny the rest (T1-D13): a refusal
                # must never be cheaper than the thing it refuses.
                reject(row_id(row["_r_replica"], row["_r_seq"]))

    if session:
        # Read after every row is in, so a confirm that arrived in the same
        # exchange counts. Taken and stored, since they are signed, and not
        # admitted: a row for a seat its author does not hold, or naming a
        # version of another seat's (identity step 5, D132), and a row naming
        # another session's version of its entity, whichever of the two
        # arrived (D131).
        admission = Admission(local, tables)
        for table, row in added:
            stored = next(r for r in admission.rows[table] if rid_of(r) == rid_of(row))
            if table in admission.seated and admission.unseated(table, stored):
                refuse_batch(bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "", row["_r_replica"], "SEAT_NOT_HELD")
        for table in tables:
            if not admission.filtered(table):
                continue
            came = {rid_of(row) for t, row in added if t == table}
            for reason, child, parent in admission.crossings(table):
                if rid_of(child) in came or rid_of(parent) in came:
                    batch = child["_r_batch"]
                    refuse_batch(bytes(batch).hex() if batch is not None else "", child["_r_replica"], reason)
        # A seat the creator confirmed to two copies, void once both are held:
        # the merge that made it void says so, in her name (D165), revealed by
        # the rows it took that the void rests on: the seat's counting confirms
        # and the session's creator's seat row, not deleted and not at an
        # equivocated id (docs/format.md#revealing-two-confirms). None taken:
        # filed under no id.
        for s, seat, creator in admission.voided:
            if (s, seat) in voided_before:
                continue
            resting = [
                row
                for table, row in added
                if row.get("_r_session") is not None
                and bytes(row["_r_session"]) == s
                and bytes(row["_r_replica"]) == creator
                and (bytes(row["_r_replica"]), row["_r_seq"]) not in admission.equivocated_at
                and (
                    (table == "_dai_confirm" and bytes(row["columns"]["seat"]) == seat)
                    or (
                        table == "_dai_seat"
                        and row["_r_deleted"] == 0
                        and session_id(bytes(row["_r_replica"]), row["_r_seq"]) == s
                    )
                )
            ]
            for row in resting:
                reveal(creator, bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "")
            if not resting:
                reveal(creator, "")

    for author, ids in revealed.values():
        refuse_batch(min(ids), author, "AUTHOR_EQUIVOCATED")

    result["refusedBatches"] = [
        {"author": shown(refusals[key]), "reason": key[1]} for key in sorted(refusals)
    ]
    return result


# ---------------------------------------------------------------- the runner


def load(path: Path) -> sqlite3.Connection:
    """A private copy, so a fixture is never written to."""
    disk = sqlite3.connect(path)
    memory = sqlite3.connect(":memory:")
    disk.backup(memory)
    disk.close()
    return memory


SCHEMA = SUITE / "schema.json"


def validate_shape(name: str, result: dict) -> list[str]:
    """Holds result.json to the schema shipped beside it.

    Checked here rather than in the generator on purpose. A generator that
    validates its own output can only confirm it agrees with itself, and when
    the field and the check that wanted it were removed by the same edit,
    nothing downstream noticed for a day. A check that can be deleted by the
    same motion that deletes what it checks is not a check.

    A missing field fails rather than being skipped: a vector this reader
    cannot understand is a vector it is not checking, and a silent skip reads
    exactly like a pass.
    """
    if not SCHEMA.exists():
        return [f"{name}: conformance/merge/schema.json is missing; nothing defines what a vector must carry"]
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    problems: list[str] = []

    for field in schema["required"]:
        if field not in result:
            problems.append(f"{name}: result.json has no {field!r}, which the schema requires")
    cites = result.get("cites")
    if isinstance(cites, list) and len(cites) == 0:
        problems.append(f"{name}: cites is empty; a vector nobody can trace to the document is a rule the suite invented")
    for direction in ("ab", "ba"):
        block = result.get(direction)
        if not isinstance(block, dict):
            continue
        for field in schema["requiredInResult"]:
            if field not in block:
                problems.append(f"{name}: {direction} has no {field!r}, which the schema requires")
    return problems


def check(name: str) -> list[str]:
    directory = SUITE / name
    failures: list[str] = []
    expected = json.loads((directory / "result.json").read_text(encoding="utf-8"))

    # The shape first. A vector whose record is malformed is not a vector that
    # ran and passed; it is one nothing checked.
    failures.extend(validate_shape(name, expected))

    # The signature check's answer for every header, made once by the verifier
    # (README, Verdicts). Required: a vector without it is one nothing checked.
    verdicts_path = directory / "verdicts.json"
    if not verdicts_path.exists():
        return failures + [f"{name}: verdicts.json is missing"]
    verdicts = json.loads(verdicts_path.read_text(encoding="utf-8"))

    for direction, (into, other) in (("ab", ("a.db", "b.db")), ("ba", ("b.db", "a.db"))):
        local = load(directory / into)
        sibling = load(directory / other)
        result = merge(local, sibling, verdicts.get(other.split(".")[0], {}))
        dump = canonical_dump(local, replicated_tables(local))
        wanted = (directory / f"expected-{direction}.txt").read_text(encoding="utf-8")

        if dump != wanted:
            failures.append(f"{name} [{direction}]: the tables differ from the expected dump")
        # What the document admits after the merge, computed here from the
        # tables (backlog D171). A vector that says it ships this and does not
        # is one nothing checked.
        if expected.get("admitted") is True:
            admitted_path = directory / f"expected-admitted-{direction}.txt"
            if not admitted_path.exists():
                failures.append(f"{name} [{direction}]: result.json says admitted and expected-admitted-{direction}.txt is missing")
            elif admitted_dump(local) != admitted_path.read_text(encoding="utf-8"):
                failures.append(f"{name} [{direction}]: what the document admits differs from expected-admitted-{direction}.txt")
        for field in ("applied", "duplicate", "rejected", "refusedBatches"):
            if result[field] != expected[direction][field]:
                failures.append(
                    f"{name} [{direction}]: {field} was {result[field]!r},"
                    f" expected {expected[direction][field]!r}"
                )
        local.close()
        sibling.close()

    # The schema both copies must agree on before any of this is allowed.
    # Shipped as text rather than a hash so a disagreement is readable.
    shape = directory / "expected-schema.txt"
    if shape.exists():
        local = load(directory / "a.db")
        mine = replicated_schema_of(local)
        local.close()
        if mine != shape.read_text(encoding="utf-8"):
            failures.append(f"{name}: the canonical replicated schema differs from expected-schema.txt")

    # Both directions of a converging vector must agree, and the one that does
    # not converge must not (a disputed row id is where union merge stops).
    ab = (directory / "expected-ab.txt").read_text(encoding="utf-8")
    ba = (directory / "expected-ba.txt").read_text(encoding="utf-8")
    if expected.get("converges", True) and ab != ba:
        failures.append(f"{name}: the fixture claims to converge and its two dumps differ")
    if not expected.get("converges", True) and ab == ba:
        failures.append(f"{name}: the fixture claims not to converge and its two dumps agree")
    return failures


def main() -> int:
    if not SUITE.exists():
        print("no conformance/merge; run `npm run fixtures`")
        return 1
    wanted = sys.argv[1:] or sorted(p.name for p in SUITE.iterdir() if p.is_dir())
    failures: list[str] = []
    for name in wanted:
        found = check(name)
        failures.extend(found)
        print(f"{'ok' if not found else 'FAILED':>7}  {name}")
    if failures:
        print()
        for line in failures:
            print(f"  {line}")
        return 1
    print(f"\n{len(wanted)} merge vectors, both directions, as specified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
