"""The reference reader of batch format version 2 (docs/format.md).

    python conformance/reference/dai_merge.py            # every fixture
    python conformance/reference/dai_merge.py <name>     # one of them

Reads the checked-in fixtures, performs its own merge in both directions, and
diffs its own canonical dump against the expected text beside them. It never
reads the TypeScript generator's output at run time: the point of a second
implementation is that it agrees about the answer, and a gate where one side
produces what the other checks is a gate against nothing.

Built with the runtime, not apart from it: it is leveled in the commits that
change the runtime's merge, and mirrors its structure in places, so it is a
second implementation of one reading of the page, not independent evidence of
the page (conformance/reference/README.md; branch review pass A, M2). The
independent reader is conformance/readers/rust-merge, built from the page.

It does not check signatures: each header's verdict is read from the vector's
verdicts.json (docs/format.md#fixtures-verdicts).
"""

from __future__ import annotations

import base64
import decimal
import hashlib
import json
import math
import re
import sqlite3
import struct
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

# The session profile's bound on parties, where a fixture's manifest.json
# gives none (docs/format.md#fixtures-manifest).
MAX_PARTIES = 2
PARENT_ID = re.compile(r"[0-9a-f]{32}:[1-9][0-9]{0,15}")
SAFE_INTEGER = 2**53 - 1


# ----------------------------------------------------------------- the dump


def real_text(value: float) -> str:
    """A finite REAL other than -0.0 as the dump writes it (docs/format.md#dump-real).

    The digits are the fewest that read back as the same double, which `repr`
    gives; where they go is the page's rule, not `repr`'s, which turns to an
    exponent at other magnitudes (`1e-06`, `1e+16`).
    """
    sign = "-" if value < 0 else ""
    shortest = decimal.Decimal(repr(abs(value))).as_tuple()
    digits = "".join(map(str, shortest.digits)).rstrip("0") or "0"
    # The value is 0.<digits> times ten to the n.
    n = len(shortest.digits) + shortest.exponent if digits != "0" else 1
    k = len(digits)
    if k <= n <= 21:
        text = digits + "0" * (n - k) + ".0"
    elif 0 < n <= 21:
        text = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        text = "0." + "0" * -n + digits
    else:
        exponent = n - 1
        text = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
    return sign + text


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
        return real_text(value)
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
        # Less _r_superseded: a display cache no rule reads (format.md#merge-dump).
        names = [name for name in columns_of(db, table) if name != "_r_superseded"]
        lines.append(f"# {table}")
        select = ", ".join(f'"{name}"' for name in names)
        rows = db.execute(
            f'SELECT {select} FROM "{table}" ORDER BY hex(_r_replica) ASC, _r_seq ASC'
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


def parents_of(text: str, replica: object = None, seq: object = None) -> list[str]:
    """The ids a row names as parents; a row not the one shape names nothing,
    in every read, a copy's own included (docs/format.md#parents-malformed,
    #parents-own-malformed, #parent-forward)."""
    if not well_formed_parents(text, replica, seq):
        return []
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def well_formed_parents(text: object, replica: object = None, seq: object = None) -> bool:
    """Whether a row's parents are the one shape (D159), and, given the row's
    own author and seq, name none of the author's own ids at or above its seq
    (docs/format.md#parent-forward)."""
    if not isinstance(text, str):
        return False
    try:
        value = json.loads(text)
    except ValueError:
        return False
    if not isinstance(value, list) or len(value) > PARENTS_CAP:
        return False
    own = bytes(replica).hex() if isinstance(replica, (bytes, bytearray)) else None
    return all(
        isinstance(item, str)
        and PARENT_ID.fullmatch(item) is not None
        and int(item[33:]) <= SAFE_INTEGER
        and not (own is not None and isinstance(seq, int) and item[:32] == own and int(item[33:]) >= seq)
        for item in value
    )


def rid_of(row: dict) -> str:
    return row_id(row["_r_replica"], row["_r_seq"])


def cbor_head(major: int, n: int) -> bytes:
    """A CBOR head in the shortest form (RFC 8949 §4.2.1)."""
    if n < 24:
        return bytes([(major << 5) | n])
    for width, code in ((1, 24), (2, 25), (4, 26), (8, 27)):
        if n < 1 << (8 * width):
            return bytes([(major << 5) | code]) + n.to_bytes(width, "big")
    raise ValueError("too large for CBOR")


def cbor_value(value: object) -> bytes | None:
    """A column value as canonical CBOR (docs/format.md#cbor); None for what no
    signed row can hold."""
    if value is None:
        return b"\xf6"
    if isinstance(value, (bytes, bytearray)):
        return cbor_head(2, len(value)) + bytes(value)
    if isinstance(value, str):
        data = value.encode("utf-8")
        return cbor_head(3, len(data)) + data
    if isinstance(value, float) and value.is_integer() and abs(value) <= SAFE_INTEGER:
        value = int(value)
    if isinstance(value, int) and not isinstance(value, bool):
        if not -(2**64) <= value < 2**64:
            return None
        return cbor_head(0, value) if value >= 0 else cbor_head(1, -1 - value)
    if isinstance(value, float) and math.isfinite(value):
        return b"\xfb" + struct.pack(">d", value)
    return None


def session_id(author: object, seq: object, seat: object, seats: object, close: object) -> bytes | None:
    """SHA-256 of the author id, the seq as eight bytes big-endian, and the
    canonical CBOR of [seat, seats, close] as the row holds them, first 16
    bytes (docs/format.md#session-id, #session-id-roster)."""
    if not isinstance(author, (bytes, bytearray)) or len(author) != 16:
        return None
    if not isinstance(seq, int) or seq < 1 or seq >= 2**64:
        return None
    parts = [cbor_value(seat), cbor_value(seats), cbor_value(close)]
    if any(part is None for part in parts):
        return None
    roster = cbor_head(4, 3) + b"".join(parts)  # type: ignore[arg-type]
    return hashlib.sha256(bytes(author) + seq.to_bytes(8, "big") + roster).digest()[:16]


def seat_value(value: object) -> bool:
    """A seat value is a byte string of exactly 16 bytes (docs/format.md#seat-value-shape)."""
    return isinstance(value, (bytes, bytearray)) and len(value) == 16


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


def of_the_merge(db: sqlite3.Connection):
    """Whether a row of a session document is a row of the merge
    (docs/format.md#uncovered-row): reached through a header this copy holds,
    the one its _r_batch names, listing it (its table, its author, its seq);
    or under this copy's own id, pending until sealed. Any other row seats,
    admits, holds and closes nothing."""
    own = {bytes(rid) for (rid,) in db.execute("SELECT id FROM _dai_replica")}
    covered: set[tuple[str, bytes, object, bytes]] = set()
    for hid, author, covers in db.execute("SELECT id, author, covers FROM _dai_batch"):
        try:
            listed = json.loads(covers)
        except (ValueError, TypeError):
            listed = []
        for entry in listed if isinstance(listed, list) else []:
            if isinstance(entry, list) and len(entry) == 2:
                covered.add((entry[0], bytes(author), entry[1], bytes(hid)))

    def counts(table: str, row: dict) -> bool:
        if bytes(row["_r_replica"]) in own:
            return True
        batch = row.get("_r_batch")
        return isinstance(batch, (bytes, bytearray)) and (table, bytes(row["_r_replica"]), row["_r_seq"], bytes(batch)) in covered

    return counts


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
    `max_parties` is the manifest's (manifest.json); each session's close rule
    is on its creator's seat row (docs/format.md#roster-declared).
    """

    def __init__(self, db: sqlite3.Connection, tables: list[str], max_parties: int):
        self.tables = tables
        self.rows: dict[str, list[dict]] = {}
        self.sessioned: set[str] = set()
        # Every rule reads the rows of the merge only (#uncovered-row).
        counts = of_the_merge(db) if is_session(db) else (lambda _table, _row: True)
        for table in tables:
            names = columns_of(db, table)
            if "_r_session" in names:
                self.sessioned.add(table)
            rows = (dict(zip(names, raw)) for raw in db.execute(f'SELECT * FROM "{table}"'))
            self.rows[table] = [r for r in rows if counts(table, r)]
        views = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type = 'view'")}
        self.seated = dict(db.execute("SELECT tbl, col FROM _dai_seat_rules")) if "_dai_seat_rules" in views else {}
        self.roles = dict(db.execute("SELECT tbl, author FROM _dai_author_rules")) if "_dai_author_rules" in views else {}

        self.equivocated = equivocated_ids(db)
        self.equivocated_at = ids_of(self.equivocated)
        self.equivocated_text = {f"{author.hex()}:{seq}" for author, seq in self.equivocated_at}
        # Every row id this copy holds, in any table: what a parent is held
        # against (docs/format.md#waiting-on-parent).
        self.held = {rid_of(r) for table in tables for r in self.rows[table]}
        signed_twice = {author for author, _seq in self.equivocated_at}

        # Each session's creator's seat row: the _dai_seat row, deleted or not,
        # whose own author, seq and roster hash to its session (#creator).
        self.creator_rows: dict[bytes, dict] = {}
        for s in self.rows.get("_dai_seat", []):
            if session_id(s["_r_replica"], s["_r_seq"], s.get("seat"), s.get("seats"), s.get("close")) == bytes(s["_r_session"]):
                self.creator_rows[bytes(s["_r_session"])] = s
        # Its roster: the open seats, and whether it is valid (#roster-declared).
        self.open_seats: dict[bytes, list[bytes]] = {}
        valid: dict[bytes, bool] = {}
        for session, s in self.creator_rows.items():
            seats = s.get("seats")
            values = [bytes(seats[i : i + 16]) for i in range(0, len(seats), 16)] if isinstance(seats, (bytes, bytearray)) else []
            self.open_seats[session] = values
            valid[session] = (
                seat_value(s.get("seat"))
                and isinstance(seats, (bytes, bytearray))
                and len(seats) % 16 == 0
                and len(set(values)) == len(values)
                and bytes(s["seat"]) not in values
                and 1 + len(values) <= max_parties
                and s.get("close") in ("any", "creator")
            )

        # The first pass, from the headers' equivocators alone: what a close
        # that counts is decided over (#close-counts), so equivocation by a
        # close never reads itself.
        live0 = {
            session: s
            for session, s in self.creator_rows.items()
            if s["_r_deleted"] == 0 and valid[session] and bytes(s["_r_replica"]) not in signed_twice
        }
        confirms0 = self.confirms_in(live0)
        holders0 = self.holders_in(live0, confirms0, signed_twice)
        members0 = {(session, replica) for session, _seat, replica in holders0}
        self.closes0 = [
            x
            for x in self.rows.get("_dai_close", [])
            if x["_r_deleted"] == 0
            and bytes(x["_r_session"]) in live0
            and (
                bytes(x["_r_replica"]) == bytes(live0[bytes(x["_r_session"])]["_r_replica"])
                or (live0[bytes(x["_r_session"])]["close"] == "any" and (bytes(x["_r_session"]), bytes(x["_r_replica"])) in members0)
            )
        ]
        # A close that counts and a row of its author in that session at a
        # higher seq, in any table, are equivocation (#close-monotone).
        self.close_equivocated = {
            (bytes(x["_r_session"]), bytes(x["_r_replica"]))
            for x in self.closes0
            if any(
                r["_r_session"] is not None
                and bytes(r["_r_session"]) == bytes(x["_r_session"])
                and bytes(r["_r_replica"]) == bytes(x["_r_replica"])
                and r["_r_seq"] > x["_r_seq"]
                for table in tables
                if table in self.sessioned
                for r in self.rows[table]
            )
        }
        # The equivocators (#equivocator): two headers at one id, or a close
        # followed by a row.
        self.equivocators = signed_twice | {author for _session, author in self.close_equivocated}

        # Void and live sessions (#session-void).
        self.void_sessions = {
            session
            for session, s in self.creator_rows.items()
            if not valid[session] or bytes(s["_r_replica"]) in self.equivocators
        }
        self.live = {session: s for session, s in live0.items() if bytes(s["_r_replica"]) not in self.equivocators}
        self.creator_of = {(session, bytes(s["_r_replica"])) for session, s in self.live.items()}

        # The confirms that count (#confirms), the void seats (#void) and who
        # holds what (#holders).
        self.confirms = self.confirms_in(self.live)
        by_seat: dict[tuple[bytes, bytes], set[bytes]] = {}
        for session, seat, holder, _seq, _creator in self.confirms:
            by_seat.setdefault((session, seat), set()).add(holder)
        # (session, seat, creator), for a seat whose confirms name two holders:
        # the creator signing twice, which a merge reveals (#revealing-two-confirms).
        self.split = {
            (session, seat, bytes(self.live[session]["_r_replica"]))
            for (session, seat), holders in by_seat.items()
            if len(holders) > 1
        }
        self.voided = {
            (session, seat, bytes(self.live[session]["_r_replica"]))
            for (session, seat), holders in by_seat.items()
            if len(holders) > 1 or holders & self.equivocators
        }
        void_seats = {(session, seat) for session, seat, _creator in self.voided}
        self.holders = {(session, bytes(s["seat"]), bytes(s["_r_replica"])) for session, s in self.live.items()}
        self.holders |= {
            (session, seat, next(iter(holders)))
            for (session, seat), holders in by_seat.items()
            if (session, seat) not in void_seats
        }
        self.members = {(session, replica) for session, _seat, replica in self.holders}
        self.void_seats = void_seats

        # The closed sessions (#closed).
        self.closed = {
            bytes(x["_r_session"])
            for x in self.closes0
            if bytes(x["_r_session"]) in self.live and bytes(x["_r_replica"]) not in self.equivocators
        }

    def confirms_in(self, live: dict[bytes, dict]) -> list[tuple[bytes, bytes, bytes, int, bytes]]:
        """(session, seat, holder, seq, creator) for every confirm that counts in
        the live sessions given: by the creator, in her session, naming a value
        her creator's seat row lists, and a holder that is an author id; deleted
        or not, superseded or not, at any seq (#confirms,
        #confirm-versions-count)."""
        found = []
        for f in self.rows.get("_dai_confirm", []):
            session = bytes(f["_r_session"])
            row = live.get(session)
            if row is None or bytes(f["_r_replica"]) != bytes(row["_r_replica"]):
                continue
            # A holder is an author id, 16 bytes, as a seat value is; a confirm
            # naming anything else names nobody and counts for nothing.
            if not seat_value(f["holder"]):
                continue
            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session]:
                found.append((session, bytes(f["seat"]), bytes(f["holder"]), f["_r_seq"], bytes(f["_r_replica"])))
        return found

    def holders_in(self, live: dict[bytes, dict], confirms: list, equivocators: set[bytes]) -> set[tuple[bytes, bytes, bytes]]:
        holders = {(session, bytes(s["seat"]), bytes(s["_r_replica"])) for session, s in live.items()}
        by_seat: dict[tuple[bytes, bytes], set] = {}
        for session, seat, holder, _seq, _creator in confirms:
            by_seat.setdefault((session, seat), set()).add(holder)
        for (session, seat), named in by_seat.items():
            if len(named) == 1 and not (named & equivocators):
                holders.add((session, seat, next(iter(named))))
        return holders

    def unequivocal(self, row: dict) -> bool:
        return (bytes(row["_r_replica"]), row["_r_seq"]) not in self.equivocated_at

    def counts(self, row: dict) -> bool:
        """A roster or close row counts for something: its author is no equivocator."""
        return bytes(row["_r_replica"]) not in self.equivocators

    def reportable(self, row: dict) -> bool:
        """A row a merge may report: in a live session, by no equivocator, naming
        no equivocated id (#report-silent)."""
        return (
            row["_r_session"] is not None
            and bytes(row["_r_session"]) in self.live
            and bytes(row["_r_replica"]) not in self.equivocators
            and not self.names_equivocated(row)
            and not self.awaits_parent(row)
        )

    def awaits_parent(self, row: dict) -> bool:
        """It names as a parent an id this copy holds no row at, in any table
        (docs/format.md#waiting-on-parent): neither admitted nor reported until
        that parent is held."""
        return any(parent not in self.held for parent in parents_of(row["_r_parents"], row["_r_replica"], row["_r_seq"]))

    def names_equivocated(self, row: dict) -> bool:
        """It names an equivocated id as a parent (docs/format.md#admitted-parent-equivocated):
        not admitted and not reported, whatever that id holds here."""
        return any(parent in self.equivocated_text for parent in parents_of(row["_r_parents"], row["_r_replica"], row["_r_seq"]))

    def filtered(self, table: str) -> bool:
        """An author table of a session document: its heads are over admitted rows (T1-D29)."""
        return table not in ROSTER and table in self.sessioned

    def named(self, table: str, row: dict) -> list[dict]:
        """The rows of its own entity that this row names as earlier versions."""
        wanted = set(parents_of(row["_r_parents"], row["_r_replica"], row["_r_seq"]))
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
        return seat_value(seat) and (bytes(row["_r_session"]), bytes(seat), bytes(row["_r_replica"])) in self.holders

    def waiting(self, table: str, row: dict) -> bool:
        """Its author's current ask in its session names the open seat the row
        names, which nobody holds and is not void (#waiting)."""
        seat = row[self.seated[table]]
        session = bytes(row["_r_session"])
        if not seat_value(seat) or session not in self.live or bytes(seat) not in self.open_seats[session]:
            return False
        if any(h[0] == session and h[1] == bytes(seat) for h in self.holders) or (session, bytes(seat)) in self.void_seats:
            return False
        return any(
            b["_r_deleted"] == 0
            and bytes(b["_r_session"]) == session
            and bytes(b["_r_replica"]) == bytes(row["_r_replica"])
            and seat_value(b["seat"])
            and bytes(b["seat"]) == bytes(seat)
            for b in self.heads("_dai_binding")
        )

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
        return not self.foreign(table, row) and self.unequivocal(row) and not self.names_equivocated(row) and not self.awaits_parent(row)

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
                    and me in parents_of(c["_r_parents"], c["_r_replica"], c["_r_seq"])
                    for c in rows
                )
            elif table == "_dai_seat":
                # Only creators' seat rows count, and nothing hides one
                # (#creator-row-immutable).
                hidden = not (
                    self.counts(r)
                    and self.creator_rows.get(bytes(r["_r_session"])) is not None
                    and rid_of(self.creator_rows[bytes(r["_r_session"])]) == me
                )
            else:
                # A roster or close row by an equivocator neither shows nor
                # hides; a plain table's, only at an equivocated id.
                counts = self.counts if table in ROSTER else self.unequivocal
                if not counts(r):
                    continue
                hidden = any(
                    bytes(c["_r_entity"]) == bytes(r["_r_entity"])
                    and (not session or (bytes(c["_r_session"]) == bytes(r["_r_session"]) and bytes(c["_r_replica"]) == bytes(r["_r_replica"])))
                    and counts(c)
                    and me in parents_of(c["_r_parents"], c["_r_replica"], c["_r_seq"])
                    for c in rows
                )
            if not hidden:
                found.append(r)
        return sorted(found, key=lambda r: (bytes(r["_r_replica"]).hex(), r["_r_seq"]))

    def unseated(self, table: str, row: dict) -> bool:
        """What a merge reports as SEAT_NOT_HELD (#seat-not-held): a reportable
        row naming no seat value, or a seat its author does not hold and does
        not wait in that is not void, or another seat's row."""
        if not self.reportable(row):
            return False
        seat = row[self.seated[table]]
        if not seat_value(seat) or self.other_seat(table, row):
            return True
        if self.holds(table, row) or self.waiting(table, row):
            return False
        return (bytes(row["_r_session"]), bytes(seat)) not in self.void_seats

    def crossings(self, table: str) -> list[tuple[str, dict, dict]]:
        """(reason, row, the row it names) for every reportable row naming another session's or another seat's version."""
        found = []
        for r in self.rows[table]:
            if not self.reportable(r):
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


def waiting_on_parent(db: sqlite3.Connection, tables: list[str]) -> set[tuple[str, str]]:
    """(table, row id) for every row of a session author table naming as a
    parent an id this copy holds no row at, in any table
    (docs/format.md#waiting-on-parent)."""
    held: set[str] = set()
    named: list[tuple[str, str, list[str]]] = []
    # Held means held as a row of the merge (#uncovered-row).
    counts = of_the_merge(db)
    for table in tables:
        sessioned = "_r_session" in columns_of(db, table)
        for replica, seq, parents, batch in db.execute(f'SELECT _r_replica, _r_seq, _r_parents, _r_batch FROM "{table}"'):
            if not counts(table, {"_r_replica": replica, "_r_seq": seq, "_r_batch": batch}):
                continue
            rid = row_id(replica, seq)
            held.add(rid)
            if sessioned and table not in ROSTER:
                named.append((table, rid, parents_of(parents, replica, seq)))
    return {(table, rid) for table, rid, parents in named if any(p not in held for p in parents)}


def admitted_dump(db: sqlite3.Connection, max_parties: int) -> str:
    """The admitted state in the text expected-admitted-*.txt holds (backlog D171)."""
    tables = replicated_tables(db)
    admission = Admission(db, tables, max_parties)
    lines: list[str] = []
    for table in tables:
        lines.append(f"# {table}")
        lines.extend(f"{rid_of(r)}\t{r['_r_deleted']}" for r in admission.heads(table))
    lines.append("# holders")
    # A holder is an author id (#confirms); a text part is shown as its UTF-8, as SQLite's hex() shows it.
    hexed = lambda part: part.hex() if isinstance(part, (bytes, bytearray)) else str(part).encode("utf-8").hex()
    lines.extend("\t".join(hexed(part) for part in h) for h in sorted(admission.holders, key=lambda h: tuple(hexed(p) for p in h)))
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


def merge(
    local: sqlite3.Connection,
    sibling: sqlite3.Connection,
    verdicts: dict[str, str],
    lists: dict[str, str] | None = None,
    own_verdicts: dict[str, str] | None = None,
    own_lists: dict[str, str] | None = None,
    max_parties: int = MAX_PARTIES,
    views: tuple[str, str] | None = None,
) -> dict:
    """Union merge, taking only what a verified header lists (docs/format.md).

    `verdicts` is the signature check's answer for each of the sibling's
    headers, by id in lowercase hex: "ok" or a BATCH_ code. A header missing
    from it was not checked, and a header not checked is not signed. `lists`
    is, for a header made authentic by a list other than the one it stores,
    that list: what it lists and is kept under (#merge-headers-kept-list).
    `own_verdicts` and `own_lists` are the same for the local copy's own
    headers, against its own rows: which of them are complete here, and what
    they list (#merge-row-held-signed). `max_parties` is the local copy's
    manifest's bound, and `views` the two copies' signed-view digests, local
    first: a sibling whose digest differs is refused whole
    (#document-mismatch).
    """
    lists = lists or {}
    own_verdicts = own_verdicts or {}
    own_lists = own_lists or {}
    tables = replicated_tables(local)
    result = {"applied": 0, "duplicate": 0, "rejected": [], "newReplicas": 0, "refusedBatches": []}
    if views is not None and views[0] != views[1]:
        return {**result, "refused": "SIGNED_VIEW_MISMATCH"}
    refusals: dict[tuple[str, str, str], bytes] = {}  # (id, reason, author hex) -> author

    def refuse_batch(hid: str, author: bytes, reason: str) -> None:
        refusals[(hid, reason, bytes(author).hex())] = author

    # The headers that reveal an author signing twice (D160, D165), by author:
    # reported once per author, under the lowest of them (D171).
    revealed: dict[str, tuple[bytes, list[str]]] = {}

    def reveal(author: bytes, hid: str) -> None:
        revealed.setdefault(bytes(author).hex(), (bytes(author), []))[1].append(hid)

    equivocated_before = ids_of(equivocated_ids(local))

    # The seats confirmed to two holders, and the closes followed by a row,
    # before anything arrives: a merge reports only what it makes true (D165,
    # #revealing-close).
    session = is_session(local)
    first = Admission(local, tables, max_parties) if session else None
    split_before = {(s, seat) for s, seat, _c in first.split} if first else set()
    close_before = set(first.close_equivocated) if first else set()

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
        if not well_formed_parents(r_parents, r_replica, r_seq)
    }
    tainted: set[str] = set()
    # The headers this copy held before the merge: its own.
    held_before = (
        {bytes(hid).hex() for (hid,) in local.execute("SELECT id FROM _dai_batch")} if has_batches(local) else set()
    )
    if has_batches(local) and has_batches(sibling):
        headers = sibling.execute(
            "SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch"
        ).fetchall()
        arrived = []
        for header in sorted(headers, key=lambda h: bytes(h[0]).hex()):
            hid = bytes(header[0]).hex()
            if hid in lists:
                header = (*header[:8], lists[hid])
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
            else:
                # Held here already, perhaps under a relabeled list: rewritten
                # to the list it signed (#merge-headers-rewritten).
                local.execute("UPDATE _dai_batch SET covers = ? WHERE id = ? AND covers <> ?", (header[8], header[0], header[8]))
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

    # A row this copy holds with _r_batch unset, listed by a header it held
    # before the merge that is complete here, is signed, not pending: the merge
    # sets the cache, to the lowest such header, before any row is placed, so
    # a signed row arriving at that id meets a signed row (#merge-row-held-signed).
    pending: dict[tuple[str, bytes, int], bytes | None] = {}
    for table in tables:
        for r_replica, r_seq in local.execute(f'SELECT _r_replica, _r_seq FROM "{table}" WHERE _r_batch IS NULL'):
            pending[(table, bytes(r_replica), r_seq)] = None
    if pending and held_before:
        for hid_bytes, author, stored in sorted(
            local.execute("SELECT id, author, covers FROM _dai_batch").fetchall(), key=lambda h: bytes(h[0]).hex()
        ):
            hid = bytes(hid_bytes).hex()
            if hid not in held_before or own_verdicts.get(hid) != "ok":
                continue
            for table, seq in json.loads(own_lists.get(hid, stored)):
                key = (table, bytes(author), seq)
                if key in pending and pending[key] is None:
                    pending[key] = hid_bytes
        for (table, author, seq), hid_bytes in pending.items():
            if hid_bytes is not None:
                local.execute(
                    f'UPDATE "{table}" SET _r_batch = ? WHERE _r_replica = ? AND _r_seq = ? AND _r_batch IS NULL',
                    (hid_bytes, author, seq),
                )

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
        for parent in parents_of(parents, row["_r_replica"], row["_r_seq"]):
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

    # The rows waiting on a parent this copy does not hold, before anything is
    # placed (docs/format.md#waiting-on-parent): one this merge releases is
    # decided now, once, and reported as a row it took.
    waiting_before = waiting_on_parent(local, tables) if session else set()
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
        admission = Admission(local, tables, max_parties)
        for table, row in added:
            stored = next(r for r in admission.rows[table] if rid_of(r) == rid_of(row))
            if table in admission.seated and admission.unseated(table, stored):
                refuse_batch(bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "", row["_r_replica"], "SEAT_NOT_HELD")
        # The rows this merge released from waiting on a parent, as taken.
        released = {
            (table, rid_of(r))
            for table in tables
            for r in admission.rows[table]
            if (table, rid_of(r)) in waiting_before and not admission.awaits_parent(r)
        }
        for table, r in ((t, r) for t in tables for r in admission.rows[t] if (t, rid_of(r)) in released):
            if table in admission.seated and admission.unseated(table, r):
                refuse_batch(bytes(r["_r_batch"]).hex() if r["_r_batch"] is not None else "", r["_r_replica"], "SEAT_NOT_HELD")
        for table in tables:
            if not admission.filtered(table):
                continue
            came = {rid_of(row) for t, row in added if t == table} | {rid for t, rid in released if t == table}
            for reason, child, parent in admission.crossings(table):
                if rid_of(child) in came or rid_of(parent) in came:
                    batch = child["_r_batch"]
                    refuse_batch(bytes(batch).hex() if batch is not None else "", child["_r_replica"], reason)
        # A seat the creator confirmed to two copies, void once both are held:
        # the merge that made it so says so, in her name (D165), revealed by
        # the rows it took that the void rests on: the seat's counting confirms
        # and the creator's seat row of the live session
        # (docs/format.md#revealing-two-confirms). None taken: filed under no
        # id. A seat void because its holder is an equivocator accuses only him.
        for s, seat, creator in admission.split:
            if (s, seat) in split_before:
                continue
            counting = {seq for cs, cseat, _holder, seq, _c in admission.confirms if cs == s and cseat == seat}
            creator_row = admission.live[s]
            resting = [
                row
                for table, row in added
                if row.get("_r_session") is not None
                and bytes(row["_r_session"]) == s
                and bytes(row["_r_replica"]) == creator
                and (
                    (table == "_dai_confirm" and row["_r_seq"] in counting)
                    or (table == "_dai_seat" and row["_r_seq"] == creator_row["_r_seq"])
                )
            ]
            for row in resting:
                reveal(creator, bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "")
            if not resting:
                reveal(creator, "")
        # A close that counts followed by a row of its author in that session
        # (#close-monotone): the merge that makes it true reports him, revealed
        # by the rows it took that it rests on, his closes there or his rows
        # above the lowest of them (#revealing-close). None taken: no id.
        for s, author in admission.close_equivocated:
            if (s, author) in close_before:
                continue
            closes = [x["_r_seq"] for x in admission.closes0 if bytes(x["_r_session"]) == s and bytes(x["_r_replica"]) == author]
            resting = [
                row
                for table, row in added
                if row.get("_r_session") is not None
                and bytes(row["_r_session"]) == s
                and bytes(row["_r_replica"]) == author
                and ((table == "_dai_close" and row["_r_seq"] in closes) or row["_r_seq"] > min(closes))
            ]
            for row in resting:
                reveal(author, bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "")
            if not resting:
                reveal(author, "")

    # Under the lowest revealing header of any kind; under no id only for an
    # author revealed with none (#equivocated-filed, #equivocated-filed-no-id).
    for author, ids in revealed.values():
        refuse_batch(min((i for i in ids if i), default=""), author, "AUTHOR_EQUIVOCATED")

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
    # For a header made authentic by a list other than the one it stores, the
    # list that did (README, Verdicts): what it is kept under. Only where a
    # vector has one.
    lists_path = directory / "lists.json"
    lists = json.loads(lists_path.read_text(encoding="utf-8")) if lists_path.exists() else {}
    # What each copy's signed manifest gives a reader (docs/format.md#fixtures-manifest):
    # its signed-view digest and its session profile. Required: the bound is
    # read from nowhere else.
    manifest_path = directory / "manifest.json"
    if not manifest_path.exists():
        return failures + [f"{name}: manifest.json is missing"]
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # What each copy admits before any merge, where the vector rules that too
    # (R21): a row waiting on a parent is admitted on neither copy until it is held.
    if expected.get("before") is True:
        for mine in ("a", "b"):
            before_path = directory / f"expected-admitted-{mine}.txt"
            if not before_path.exists():
                failures.append(f"{name}: result.json says before and expected-admitted-{mine}.txt is missing")
                continue
            local = load(directory / f"{mine}.db")
            parties = manifest[mine].get("session", {}).get("max_parties", MAX_PARTIES)
            if admitted_dump(local, parties) != before_path.read_text(encoding="utf-8"):
                failures.append(f"{name} [{mine}]: what the copy admits before any merge differs from expected-admitted-{mine}.txt")
            local.close()

    for direction, (into, other) in (("ab", ("a.db", "b.db")), ("ba", ("b.db", "a.db"))):
        local = load(directory / into)
        sibling = load(directory / other)
        copy, mine = other.split(".")[0], into.split(".")[0]
        bound = manifest[mine].get("session", {}).get("max_parties", MAX_PARTIES)
        result = merge(
            local,
            sibling,
            verdicts.get(copy, {}),
            lists.get(copy, {}),
            verdicts.get(mine, {}),
            lists.get(mine, {}),
            bound,
            (manifest[mine]["view"], manifest[copy]["view"]),
        )
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
            elif admitted_dump(local, bound) != admitted_path.read_text(encoding="utf-8"):
                failures.append(f"{name} [{direction}]: what the document admits differs from expected-admitted-{direction}.txt")
        if result.get("refused") != expected[direction].get("refused"):
            failures.append(f"{name} [{direction}]: refused was {result.get('refused')!r}, expected {expected[direction].get('refused')!r}")
        for field in ("applied", "duplicate", "rejected", "newReplicas", "refusedBatches"):
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
