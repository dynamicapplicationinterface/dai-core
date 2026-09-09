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

import json
import math
import sqlite3
import sys
from pathlib import Path

SUITE = Path(__file__).resolve().parents[1] / "merge"


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
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- the merge


def row_id(replica: bytes, seq: int) -> str:
    return f"{bytes(replica).hex()}:{seq}"


def parents_of(text: str) -> list[str]:
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return []
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


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
            and all(existing[name] == row["columns"].get(name) for name in authored)
        )
        if same:
            return "duplicate"
        raise ValueError(f"ROW_REJECTED: a different row already exists as {rid}")

    # Superseded on arrival when something present already names this row. A
    # merge delivers children before parents, so this is not a rare case.
    named = db.execute(
        f'SELECT 1 FROM "{table}", json_each("{table}"._r_parents)'
        " WHERE json_each.value = ? LIMIT 1",
        (rid,),
    ).fetchone()

    names = authored + [
        "_r_replica", "_r_seq", "_r_lc", "_r_entity",
        "_r_parents", "_r_deleted", "_r_superseded", "_r_sig",
    ]
    values = [row["columns"].get(name) for name in authored] + [
        row["_r_replica"], row["_r_seq"], row["_r_lc"], row["_r_entity"],
        row["_r_parents"], row["_r_deleted"], 1 if named else 0, row.get("_r_sig"),
    ]
    placeholders = ", ".join("?" for _ in names)
    quoted = ", ".join(f'"{name}"' for name in names)
    db.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', values)

    for parent in parents_of(row["_r_parents"]):
        replica_hex, _, seq = parent.partition(":")
        if not seq.isdigit():
            continue
        db.execute(
            f'UPDATE "{table}" SET _r_superseded = 1'
            " WHERE hex(_r_replica) = ? AND _r_seq = ? AND _r_superseded = 0",
            (replica_hex.upper(), int(seq)),
        )
    return "added"


def merge(local: sqlite3.Connection, sibling: sqlite3.Connection) -> dict:
    tables = replicated_tables(local)
    result = {"applied": 0, "duplicate": 0, "rejected": [], "newReplicas": 0}

    # The clock first, and before any row: a local row written afterwards must
    # outrank what arrived, or it loses to its own ancestors under the
    # highest-_r_lc pick and the newest edit disappears behind an older one.
    ceiling = local.execute("SELECT lc FROM _dai_replica").fetchone()[0]
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
    seen = list(sibling.execute("SELECT id, label FROM _dai_replica")) + list(
        sibling.execute("SELECT id, label FROM _dai_replicas")
    )
    for rid, label in seen:
        if bytes(rid).hex().upper() in known:
            continue
        known.add(bytes(rid).hex().upper())
        result["newReplicas"] += 1
        local.execute(
            "INSERT INTO _dai_replicas (id, label, first_seen, rows_seen) VALUES (?, ?, ?, 0)",
            (rid, label, ceiling),
        )

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
                "_r_sig": incoming.get("_r_sig"),
                "columns": {name: incoming[name] for name in authored},
            }
            try:
                outcome = apply_row(local, table, row)
                result["applied" if outcome == "added" else "duplicate"] += 1
            except ValueError:
                # One refused row does not deny the rest (T1-D13): a refusal
                # must never be cheaper than the thing it refuses.
                result["rejected"].append(row_id(row["_r_replica"], row["_r_seq"]))
    return result


# ---------------------------------------------------------------- the runner


def load(path: Path) -> sqlite3.Connection:
    """A private copy, so a fixture is never written to."""
    disk = sqlite3.connect(path)
    memory = sqlite3.connect(":memory:")
    disk.backup(memory)
    disk.close()
    return memory


def check(name: str) -> list[str]:
    directory = SUITE / name
    failures: list[str] = []
    expected = json.loads((directory / "result.json").read_text(encoding="utf-8"))

    for direction, (into, other) in (("ab", ("a.db", "b.db")), ("ba", ("b.db", "a.db"))):
        local = load(directory / into)
        sibling = load(directory / other)
        result = merge(local, sibling)
        dump = canonical_dump(local, replicated_tables(local))
        wanted = (directory / f"expected-{direction}.txt").read_text(encoding="utf-8")

        if dump != wanted:
            failures.append(f"{name} [{direction}]: the tables differ from the expected dump")
        for field in ("applied", "duplicate", "rejected"):
            if result[field] != expected[direction][field]:
                failures.append(
                    f"{name} [{direction}]: {field} was {result[field]!r},"
                    f" expected {expected[direction][field]!r}"
                )
        local.close()
        sibling.close()

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
