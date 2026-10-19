"""Changeset application for the reference reader (R-O, the ordinary data interface).

A document with no session policy carries one replicated table, `_cs_log`,
whose rows are signed changesets: each row's payload is one save's changes to
the application's ordinary tables. `dai_merge.py` admits the log exactly as it
admits any replicated table; this module then applies every admitted changeset
to the application's tables under the runtime's policy (src/changesets.ts),
and nothing else.

It is a full recompute, not the runtime's incremental path: every application
row is cleared and rebuilt from the admitted log alone. The runtime's own
bookkeeping (`_cs_cell`, `_cs_flag`, ...) is never read, so agreement is about
the policy, not about two copies of one state.

    python conformance/reference/dai_changes.py <dir>
    python conformance/reference/dai_changes.py --vectors conformance/changesets

`<dir>` holds pairs `<name>-a.db`, `<name>-b.db` and `<name>-verdicts.json`
({"a": {...}, "b": {...}}, each header's verdict by id). For each pair and
each direction it merges with dai_merge.merge, applies the log, and prints one
JSON object per line: {"name", "direction", "tables", "flags", "held"}.

With --vectors, each subdirectory of the folder is one checked-in vector
(`a.db`, `b.db`, `verdicts.json`, `expected.json`; see its README). Both
directions are merged and applied, and the result is diffed against
`expected.json`. One line per vector and direction, then the count; the exit
status is 1 if any differs.
"""

from __future__ import annotations

import json
import struct
import sqlite3
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dai_merge as dm  # noqa: E402

LOG = "_cs_log"
INTERNAL = ("_dai", "_cs_", "sqlite_")


# ---------------------------------------------------------------- CBOR


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.at = 0

    def take(self, n: int) -> bytes:
        out = self.data[self.at : self.at + n]
        self.at += n
        return out

    def head(self) -> tuple[int, int]:
        first = self.take(1)[0]
        major, info = first >> 5, first & 31
        if info < 24:
            return major, info
        if info == 24:
            return major, self.take(1)[0]
        if info == 25:
            return major, struct.unpack(">H", self.take(2))[0]
        if info == 26:
            return major, struct.unpack(">I", self.take(4))[0]
        if info == 27:
            return major, struct.unpack(">Q", self.take(8))[0]
        raise ValueError(f"CBOR additional info {info} is not used here")

    def value(self) -> object:
        start = self.data[self.at]
        if start == 0xFB:
            self.at += 1
            return struct.unpack(">d", self.take(8))[0]
        major, n = self.head()
        if major == 0:
            return n
        if major == 1:
            return -1 - n
        if major == 2:
            return bytes(self.take(n))
        if major == 3:
            return self.take(n).decode("utf-8")
        if major == 4:
            return [self.value() for _ in range(n)]
        if major == 5:
            out = {}
            for _ in range(n):
                key = self.value()
                out[key] = self.value()
            return out
        if major == 7:
            if n == 20:
                return False
            if n == 21:
                return True
            if n == 22:
                return None
        raise ValueError(f"CBOR major {major} value {n} is not used here")


def cbor_decode(data: bytes) -> object:
    return _Reader(bytes(data)).value()


# ---------------------------------------------------------------- keys


def q(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def app_tables(db: sqlite3.Connection) -> list[str]:
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")]
    return [n for n in names if not n.startswith(INTERNAL)]


def keys_of(db: sqlite3.Connection, table: str) -> tuple[str, list[str]]:
    """The key a changeset names a row by, read from the stored schema: an
    author-ranged or uuid key carries its runtime default; a table with no
    primary key is keyed by its rowid."""
    info = db.execute(f"SELECT name, pk FROM pragma_table_info({sql_text(table)}) ORDER BY cid").fetchall()
    pks = sorted([r for r in info if r[1] > 0], key=lambda r: r[1])
    if not pks:
        return "rowid", ["rowid"]
    return "key", [r[0] for r in pks]


def sql_text(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


# ---------------------------------------------------------------- policy


def apply_log(db: sqlite3.Connection) -> None:
    """Every admitted changeset, applied to emptied application tables."""
    for name, fn, n in (
        ("dai_projecting", lambda: 1, 0),
        ("dai_id", lambda t: None, 1),
        ("dai_uuid", lambda: str(uuid.uuid4()), 0),
        ("dai_inserted", lambda a, b: None, 2),
    ):
        db.create_function(name, n, fn)
    db.execute("PRAGMA foreign_keys = OFF")
    tables = app_tables(db)
    keys = {t: keys_of(db, t) for t in tables}
    for t in tables:
        db.execute(f"DELETE FROM {q(t)}")

    # Grow-only sets, from the log alone.
    cells: dict[tuple[str, str], dict[str, dict[str, tuple[object, int, str]]]] = {}
    sup: set[tuple[str, str, str, str]] = set()
    seen: dict[tuple[str, str], dict[str, set[str]]] = {}
    rows = db.execute(
        f"SELECT lower(hex(_r_replica)), _r_seq, _r_lc, payload FROM {q(LOG)} ORDER BY _r_lc, lower(hex(_r_replica)), _r_seq"
    ).fetchall()
    for author, seq, lc, payload in rows:
        ver = f"{author}:{seq}"
        _, ops = cbor_decode(payload)  # type: ignore[misc]
        for table, k, _code, new, _old, bases, saw in ops:  # type: ignore[union-attr]
            pk = json.dumps(k, separators=(",", ":"), ensure_ascii=False)
            row = cells.setdefault((table, pk), {})
            for col, val in new.items():
                row.setdefault(col, {})[ver] = (val, int(lc), author)
            for col, vers in bases.items():
                for v in vers:
                    sup.add((table, pk, col, v))
            for v in saw:
                seen.setdefault((table, pk), {}).setdefault(ver, set()).add(v)

    flags: dict[tuple[str, str, str], object] = {}
    held: dict[tuple[str, str], tuple[str, dict]] = {}

    def state(table: str, pk: str):
        row = cells.get((table, pk))
        if not row:
            return None
        heads = {
            col: {v: x for v, x in vers.items() if (table, pk, col, v) not in sup} for col, vers in row.items()
        }
        exists = heads.get("", {})
        dels = [v for v, x in exists.items() if x[0] == 0]
        alive = [v for v, x in exists.items() if x[0] == 1]
        saw = set()
        for d in dels:
            saw |= seen.get((table, pk), {}).get(d, set())
        data = {c: hs for c, hs in heads.items() if c != ""}
        deleted = not alive and all(v in saw for hs in data.values() for v in hs)
        values = {}
        pending = []
        for col, hs in data.items():
            if not hs:
                continue
            order = sorted(hs.items(), key=lambda kv: (-kv[1][1], _neg(kv[1][2]), _neg(kv[0])))
            values[col] = order[0][1][0]
            if len(hs) > 1:
                pending.append(col)
        return {"deleted": deleted, "contested": (not deleted) and bool(dels), "values": values, "pending": pending}

    def birth(table: str, pk: str):
        exists = cells.get((table, pk), {}).get("", {})
        born = sorted((x[1], x[2]) for x in exists.values() if x[0] == 1)
        return born[0] if born else None

    def where(table: str) -> str:
        return " AND ".join(f"{q(c)} IS ?" for c in keys[table][1])

    def write(table: str, k: list, values: dict) -> None:
        kind, pk_cols = keys[table]
        data = [c for c in values if c not in pk_cols]
        if kind == "rowid":
            if db.execute(f"SELECT 1 FROM {q(table)} WHERE rowid IS ?", k).fetchone():
                if data:
                    db.execute(f"UPDATE {q(table)} SET {', '.join(f'{q(c)} = ?' for c in data)} WHERE rowid IS ?", [values[c] for c in data] + k)
                return
            cols = ["rowid"] + [q(c) for c in data]
            db.execute(f"INSERT INTO {q(table)} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})", k + [values[c] for c in data])
            return
        cols = pk_cols + data
        update = ", ".join(f"{q(c)} = excluded.{q(c)}" for c in data)
        db.execute(
            f"INSERT INTO {q(table)} ({', '.join(q(c) for c in cols)}) VALUES ({', '.join('?' for _ in cols)}) "
            f"ON CONFLICT ({', '.join(q(c) for c in pk_cols)}) DO {('UPDATE SET ' + update) if update else 'NOTHING'}",
            k + [values[c] for c in data],
        )

    def occupant(table: str, pk: str, values: dict):
        pk_cols = keys[table][1]
        for (name,) in db.execute(f"SELECT name FROM pragma_index_list({sql_text(table)}) WHERE \"unique\" = 1 AND origin <> 'pk'").fetchall():
            cols = [r[0] for r in db.execute(f"SELECT name FROM pragma_index_info({sql_text(name)}) ORDER BY seqno")]
            if any(c not in values for c in cols):
                continue
            hit = db.execute(
                f"SELECT {', '.join(q(c) for c in pk_cols)} FROM {q(table)} WHERE {' AND '.join(f'{q(c)} IS ?' for c in cols)}",
                [values[c] for c in cols],
            ).fetchone()
            if hit:
                other = json.dumps(list(hit), separators=(",", ":"))
                if other != pk:
                    return other
        return None

    def hold(table: str, pk: str, reason: str, values: dict) -> None:
        held[(table, pk)] = (reason, values)
        flags[(table, pk, "held")] = reason

    def place(table: str, pk: str, force: bool = False) -> None:
        s = state(table, pk)
        if s is None or table not in keys:
            return
        k = json.loads(pk)
        if s["deleted"] and not force:
            db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", k)
            return
        if s["contested"]:
            flags[(table, pk, "delete-conflict")] = None
        if s["pending"]:
            flags[(table, pk, "pending")] = s["pending"]
        try:
            write(table, k, s["values"])
        except sqlite3.IntegrityError as e:
            message = str(e)
            if "UNIQUE" in message:
                other = occupant(table, pk, s["values"])
                if other:
                    mine, theirs = birth(table, pk), birth(table, other)
                    if mine and (not theirs or mine < theirs):
                        hold(table, other, f"UNIQUE: lost the slot to {pk}", (state(table, other) or {}).get("values", {}))
                        db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", json.loads(other))
                        write(table, k, s["values"])
                        return
                    hold(table, pk, f"UNIQUE: {other} holds the slot", s["values"])
                    return
            hold(table, pk, message, s["values"])
            db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", k)

    # Rows are placed in order of birth, so a UNIQUE slot goes to the earlier-born row.
    order = sorted(cells, key=lambda tk: (birth(*tk) or (1 << 62, ""), tk))
    for table, pk in order:
        place(table, pk)

    kept: set[tuple[str, str]] = set()
    for _ in range(16):
        revived = 0
        for child_table, rowid, parent, fkid in db.execute("SELECT * FROM pragma_foreign_key_check").fetchall():
            fk = db.execute(f"SELECT \"from\", \"to\" FROM pragma_foreign_key_list({sql_text(child_table)}) WHERE id = ? ORDER BY seq", [fkid]).fetchall()
            if not fk or rowid is None or parent not in keys:
                continue
            child = db.execute(f"SELECT {', '.join(q(f[0]) for f in fk)} FROM {q(child_table)} WHERE rowid = ?", [rowid]).fetchone()
            to = [f[1] or keys[parent][1][0] for f in fk]
            if child is None or to != keys[parent][1]:
                continue
            pk = json.dumps(list(child), separators=(",", ":"))
            if state(parent, pk) is None:
                flags[(child_table, json.dumps([rowid]), "orphan")] = None
                continue
            if (parent, pk) in kept:
                continue
            kept.add((parent, pk))
            flags[(parent, pk, "kept-referenced")] = None
            place(parent, pk, True)
            revived += 1
        if not revived:
            break

    db.execute("DELETE FROM _cs_flag")
    db.execute("DELETE FROM _cs_held")
    for (t, pk, kind) in flags:
        db.execute("INSERT INTO _cs_flag (tbl, pk, kind, detail) VALUES (?, ?, ?, NULL)", [t, pk, kind])
    for (t, pk), (reason, _values) in held.items():
        db.execute("INSERT INTO _cs_held (tbl, pk, reason, row) VALUES (?, ?, ?, '{}')", [t, pk, reason])


def _neg(s: str) -> tuple:
    """Descending order on a string, as a sort key."""
    return tuple(-ord(ch) for ch in s) + (1,)


def dump(db: sqlite3.Connection) -> dict:
    out = {}
    db.row_factory = sqlite3.Row
    for t in app_tables(db):
        kind, pk = keys_of(db, t)
        select = f"SELECT rowid AS rowid, * FROM {q(t)}" if kind == "rowid" else f"SELECT * FROM {q(t)}"
        order = "rowid" if kind == "rowid" else ", ".join(q(c) for c in pk)
        out[t] = [
            {c: (f"<{bytes(r[c]).hex()}>" if isinstance(r[c], (bytes, bytearray)) else r[c]) for c in r.keys()}
            for r in db.execute(f"{select} ORDER BY {order}")
        ]
    db.row_factory = None
    return out


def judged(db: sqlite3.Connection) -> dict:
    return {
        "tables": dump(db),
        "flags": sorted([list(r) for r in db.execute("SELECT tbl, pk, kind FROM _cs_flag")]),
        "held": sorted([list(r) for r in db.execute("SELECT tbl, pk FROM _cs_held")]),
    }


def main(folder: Path) -> None:
    for verdicts_file in sorted(folder.glob("*-verdicts.json")):
        name = verdicts_file.name[: -len("-verdicts.json")]
        verdicts = json.loads(verdicts_file.read_text(encoding="utf-8"))
        for direction, (mine, theirs) in (("ab", ("a", "b")), ("ba", ("b", "a"))):
            local = dm.load(folder / f"{name}-{mine}.db")
            sibling = dm.load(folder / f"{name}-{theirs}.db")
            result = dm.merge(local, sibling, verdicts[theirs], {}, verdicts[mine], {})
            apply_log(local)
            out = judged(local)
            out.update(
                {
                    "name": name,
                    "direction": direction,
                    "applied": result["applied"],
                    "refused": [r.get("reason") if isinstance(r, dict) else r for r in result["refusedBatches"]],
                }
            )
            print(json.dumps(out, ensure_ascii=False, default=str))


def merged(folder: Path, mine: str, theirs: str, verdicts: dict) -> dict:
    """One direction of a vector: `mine` merges `theirs`, then the log is applied."""
    local = dm.load(folder / f"{mine}.db")
    sibling = dm.load(folder / f"{theirs}.db")
    result = dm.merge(local, sibling, verdicts[theirs], {}, verdicts[mine], {})
    apply_log(local)
    out = judged(local)
    out["refused"] = [r.get("reason") if isinstance(r, dict) else r for r in result["refusedBatches"]]
    return out


def vectors(root: Path) -> int:
    failed = 0
    total = 0
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        expected = json.loads((folder / "expected.json").read_text(encoding="utf-8"))
        verdicts = json.loads((folder / "verdicts.json").read_text(encoding="utf-8"))
        for direction, (mine, theirs) in (("ab", ("a", "b")), ("ba", ("b", "a"))):
            total += 1
            got = merged(folder, mine, theirs, verdicts)
            want = expected[direction]
            problems = []
            if got["refused"]:
                problems.append(f"refused batches {got['refused']}")
            if got["tables"] != want["tables"]:
                problems.append(f"tables differ: got {json.dumps(got['tables'])}, want {json.dumps(want['tables'])}")
            for part in ("flags", "held"):
                if sorted(got[part]) != sorted(want[part]):
                    problems.append(f"{part} differ: got {got[part]}, want {want[part]}")
            if problems:
                failed += 1
                print(f"FAIL {folder.name} {direction}: " + "; ".join(problems))
            else:
                print(f"ok   {folder.name} {direction}")
    print(f"{total - failed}/{total} passed")
    return 1 if failed or total == 0 else 0


if __name__ == "__main__":
    if sys.argv[1] == "--vectors":
        sys.exit(vectors(Path(sys.argv[2])))
    main(Path(sys.argv[1]))
