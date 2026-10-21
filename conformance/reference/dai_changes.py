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
import re
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
    # An ordinary table only: a virtual table's shadow tables are its module's (C04).
    names = [r[0] for r in db.execute("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' ORDER BY name")]
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


SAFE = (1 << 53) - 1


def js_number(x: float) -> str:
    """A float as ECMAScript's Number.prototype.toString writes it: the shortest
    digits that read back, in JavaScript's own layout (1e+21, 1.5e-7, 0.000001)."""
    if x != x:
        return "NaN"
    if x in (float("inf"), float("-inf")):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    mantissa, _, exp = repr(abs(x)).partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    # Where the point falls, counted from the first significant digit.
    if whole == "0":
        point = -(len(frac) - len(frac.lstrip("0"))) + (int(exp) if exp else 0)
    else:
        point = len(whole) + (int(exp) if exp else 0)
    digits = digits.rstrip("0") or "0"
    k, n = len(digits), point
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    return sign + digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))


def _key_part(v: object, exact: bool, fold) -> str:
    """One key part as the runtime's keyText (identity) or keySpelling (exact) writes it."""
    if isinstance(v, (bytes, bytearray)):
        return json.dumps({"$blob": bytes(v).hex()}, separators=(",", ":"))
    if isinstance(v, bool):
        v = int(v)
    if isinstance(v, int):
        return str(v) if -SAFE <= v <= SAFE else json.dumps({"$int": str(v)}, separators=(",", ":"))
    if isinstance(v, float):
        # A REAL with no fraction, or an infinity, is the one a JS number cannot hold as a REAL (the runtime's Float64).
        if v.is_integer() or v in (float("inf"), float("-inf")):
            if not exact and v.is_integer() and -SAFE <= v <= SAFE:
                return str(int(v))
            return json.dumps({"$real": js_number(v)}, separators=(",", ":"))
        return js_number(v)
    if isinstance(v, str):
        return json.dumps(fold(v) if fold else v, separators=(",", ":"), ensure_ascii=False)
    return json.dumps(v, separators=(",", ":"))


def key_text(k: list, folds=None) -> str:
    """A key's identity, as the runtime's keyText: exact for every storage class,
    one text for two keys SQLite takes for one row (M15, 1d-H4; 1d-H5)."""
    return "[" + ",".join(_key_part(v, False, folds[i] if folds else None) for i, v in enumerate(k)) + "]"


def key_spelling(k: list) -> str:
    """A key exactly as written, class and spelling both: what a row is written back with."""
    return "[" + ",".join(_key_part(v, True, None) for v in k) + "]"


def key_values(text: str) -> list:
    def hook(o: dict) -> object:
        if "$int" in o:
            return int(o["$int"])
        if "$blob" in o:
            return bytes.fromhex(o["$blob"])
        if "$real" in o:
            return float(o["$real"])
        return o

    return json.loads(text, object_hook=hook)


# ---------------------------------------------------------------- policy


def apply_log(db: sqlite3.Connection) -> None:
    """Every admitted changeset, applied to emptied application tables."""
    for name, fn, n in (
        ("dai_projecting", lambda: 1, 0),
        ("dai_id", lambda t: None, 1),
        ("dai_uuid", lambda: str(uuid.uuid4()), 0),
        ("dai_inserted", lambda a, b: None, 2),
        ("dai_enter", lambda: None, 0),
        ("dai_leave", lambda: None, 0),
    ):
        db.create_function(name, n, fn)
    db.execute("PRAGMA foreign_keys = OFF")
    tables = app_tables(db)
    keys = {t: keys_of(db, t) for t in tables}

    fold_cache: dict[str, object] = {}

    def folds(table: str):
        """Each key column's text, as its collation compares it (1d-H5): NOCASE folds
        ASCII letters, RTRIM drops trailing spaces. None where no key column folds."""
        if table not in fold_cache:
            index = db.execute(f"SELECT name FROM pragma_index_list({sql_text(table)}) WHERE origin = 'pk'").fetchone()
            colls = {}
            if index:
                colls = {r[0]: str(r[1]).upper() for r in db.execute(f"SELECT name, coll FROM pragma_index_xinfo({sql_text(index[0])}) WHERE key = 1")}
            pk_cols = keys[table][1] if table in keys else []

            def fold_of(coll: str):
                if coll == "NOCASE":
                    return lambda s: "".join(ch.lower() if "A" <= ch <= "Z" else ch for ch in s)
                if coll == "RTRIM":
                    return lambda s: s.rstrip(" ")
                return None

            found = [fold_of(colls.get(c, "BINARY")) for c in pk_cols]
            fold_cache[table] = found if any(found) else None
        return fold_cache[table]
    for t in tables:
        db.execute(f"DELETE FROM {q(t)}")

    # Grow-only sets, from the log alone.
    cells: dict[tuple[str, str], dict[str, dict[str, tuple[object, int, str]]]] = {}
    # The key as a version wrote it, where its identity reads otherwise (a REAL key, a folding collation).
    spell: dict[tuple[str, str, str], str] = {}
    sup: set[tuple[str, str, str, str]] = set()
    seen: dict[tuple[str, str], dict[str, set[str]]] = {}
    rows = db.execute(
        f"SELECT lower(hex(_r_replica)), _r_seq, _r_lc, payload FROM {q(LOG)} ORDER BY _r_lc, lower(hex(_r_replica)), _r_seq"
    ).fetchall()
    # Every admitted version, with its clock; and the versions already judged, applied or refused (R-X §3).
    known = {f"{author}:{seq}": int(lc) for author, seq, lc, _ in rows}
    judged_vers: set[str] = set()
    refused: dict[str, str] = {}

    def basis_verdict(ops: list, lc: int, author: str, seq: int, received: object):
        """Whether a changeset's operations bind their basis, read from the payload alone: every unit written
        names its basis, and every version its bases or resolves names is a version of that cell with a lower
        clock. A version not yet applied, from before it, is waited for; one already judged that is not that
        cell's, or one no earlier than itself, is a forgery. And every version named, a delete's seen too,
        is one the signer had received (1g-M1): its own from before, or at or below the seq its batch records
        it had applied of that author."""
        wait = False
        if not isinstance(received, dict):
            return "basis-forged"

        def had(v: object) -> bool:
            by, _, n = str(v).rpartition(":")
            if not n.isdigit():
                return False
            if by == author:
                return int(n) < seq
            up_to = received.get(by)
            return isinstance(up_to, int) and not isinstance(up_to, bool) and int(n) <= up_to

        for op in ops:
            if not isinstance(op, list) or len(op) < 7 or not isinstance(op[3], dict) or not isinstance(op[5], dict):
                return "basis-missing"
            table, k, code, new, _old, bases, saw = op[:7]
            if any(not isinstance(bases.get(c), list) for c in new):
                return "basis-missing"
            res = op[7] if len(op) > 7 else {}
            if not isinstance(res, dict):
                return "basis-forged"
            if not isinstance(saw, list) or not all(had(v) for v in saw):
                return "basis-forged"
            # A resolution resolves one unit whole (1g-L3): every column it writes, and no other, names the same
            # alternatives. An empty one resolves nothing, and is read as none.
            resolving = bool(res)
            if resolving:
                def alts(c):
                    return sorted(str(v) for v in res[c]) if isinstance(res.get(c), list) else None
                first = alts(next(iter(new), ""))
                if first is None or any(c not in new for c in res) or any(alts(c) != first for c in new):
                    return "basis-forged"
            pk = key_text(k, folds(table))
            op_wait = False
            for col, vers in list(bases.items()) + list(res.items()):
                if not isinstance(vers, list):
                    return "basis-forged"
                if not all(had(v) for v in vers):
                    return "basis-forged"
                for v in vers:
                    cell = cells.get((table, pk), {}).get(col, {}).get(v)
                    if cell is not None:
                        if cell[1] >= lc:
                            return "basis-forged"
                    elif v in judged_vers or known.get(v, float("-inf")) >= lc:
                        return "basis-forged"
                    else:
                        op_wait = True
            # An edit that changes nothing it was based on, and resolves nothing, is one an honest runtime never
            # signs (1g-L2). Judged once its basis is here, by value and storage class.
            if code == "U" and not resolving and not op_wait and new:
                def unchanged(c, val):
                    vers = bases[c]
                    if len(vers) != 1:
                        return False
                    cell = cells.get((table, pk), {}).get(c, {}).get(vers[0])
                    return cell is not None and type(cell[0]) is type(val) and cell[0] == val
                if all(unchanged(c, val) for c, val in new.items()):
                    return "basis-unchanged"
            wait = wait or op_wait
        return "wait" if wait else None

    for author, seq, lc, payload in rows:
        ver = f"{author}:{seq}"
        decoded = cbor_decode(payload)
        ops = decoded[1]  # type: ignore[index]
        # What the signer had received, signed with its batch (1g-M1); a batch without it names nothing it had.
        received = decoded[2] if len(decoded) > 2 else {}  # type: ignore[arg-type]
        verdict = basis_verdict(ops, int(lc), author, int(seq), received)  # type: ignore[arg-type]
        if verdict == "wait":
            continue
        judged_vers.add(ver)
        if verdict:
            refused[ver] = verdict
            continue
        for op in ops:  # type: ignore[union-attr]
            table, k, _code, new, _old, bases, saw = op[:7]
            # A resolution (R-X) names the alternatives it accepted or rejected; it supersedes exactly those.
            resolves = op[7] if len(op) > 7 else {}
            pk = key_text(k, folds(table))
            if new.get("") == 1 and key_spelling(k) != pk:
                spell.setdefault((table, pk, ver), key_spelling(k))
            row = cells.setdefault((table, pk), {})
            for col, val in new.items():
                row.setdefault(col, {})[ver] = (val, int(lc), author)
            for col, vers in list(bases.items()) + list(resolves.items()):
                for v in vers:
                    sup.add((table, pk, col, v))
            for v in saw:
                seen.setdefault((table, pk), {}).setdefault(ver, set()).add(v)

    flags: dict[tuple[str, str, str], object] = {}
    held: dict[tuple[str, str], tuple[str, dict]] = {}
    # The versions a constraint conflict set aside, by row: the proposals that contend there (M06).
    set_aside: dict[tuple[str, str], set[str]] = {}

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
        shown_by = {}
        pending = []
        for col, hs in data.items():
            if not hs:
                continue
            order = sorted(hs.items(), key=later)
            values[col] = order[0][1][0]
            shown_by[col] = order[0]
            if len(hs) > 1:
                pending.append(col)
        return {"deleted": deleted, "contested": (not deleted) and bool(dels), "values": values, "pending": pending, "shown_by": shown_by}

    def within_constraints(table: str, pk: str, k: list, s: dict) -> bool:
        """A CHECK or NOT NULL the merged values fail (R-T, M02): the latest
        candidate the table admits, setting aside the newest versions first,
        each column one shows going back to the latest value before it."""
        row = cells.get((table, pk), {})
        versions = sorted({v: x for v, x in s["shown_by"].values()}.items(), key=later)
        for n in range(1, len(versions) + 1):
            aside = {v for v, _ in versions[:n]}
            values = dict(s["values"])
            changed = False
            proposals = set()
            for col, (ver, _x) in s["shown_by"].items():
                if ver not in aside:
                    continue
                before = sorted(((v, x) for v, x in row.get(col, {}).items() if v not in aside), key=later)
                if not before:
                    continue
                values[col] = before[0][1][0]
                changed = True
                proposals.add(ver)
            if not changed:
                continue
            try:
                write(table, k, values)
            except sqlite3.IntegrityError:
                continue
            flags[(table, pk, "pending")] = s["pending"]
            set_aside[(table, pk)] = proposals
            return True
        return False

    def birth(table: str, pk: str):
        exists = cells.get((table, pk), {}).get("", {})
        born = sorted((x[1], x[2], v) for v, x in exists.items() if x[0] == 1)
        return born[0] if born else None

    def spelling(table: str, pk: str, values: dict) -> list:
        """The key a row is written with: its key columns' shown values, the last writer's by (lc, author),
        where its log carries them (1e-H3); else, for a log from before, its earliest-born version's
        spelling, else its identity's own."""
        pk_cols = keys[table][1]
        if pk_cols and all(c in values for c in pk_cols):
            return [values[c] for c in pk_cols]
        born = birth(table, pk)
        return key_values(spell.get((table, pk, born[2]), pk) if born else pk)

    def respells(table: str) -> bool:
        """Whether one key can be held under two spellings: a folding collation, or a key column with no type."""
        pk_cols = keys[table][1]
        types = {r[0]: str(r[1]).upper() for r in db.execute(f"SELECT name, type FROM pragma_table_info({sql_text(table)})")}

        def untyped(t: str) -> bool:
            return not any(w in t for w in ("INT", "CHAR", "CLOB", "TEXT", "REAL", "FLOA", "DOUB")) and (t == "" or "BLOB" in t)

        return any(untyped(types.get(c, "")) for c in pk_cols) or any(folds(table) or [])

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
        respell = respells(table)
        update = ", ".join(f"{q(c)} = excluded.{q(c)}" for c in (pk_cols if respell else []) + data)
        db.execute(
            f"INSERT INTO {q(table)} ({', '.join(q(c) for c in cols)}) VALUES ({', '.join('?' for _ in cols)}) "
            f"ON CONFLICT ({', '.join(q(c) for c in pk_cols)}) DO {('UPDATE SET ' + update) if update else 'NOTHING'}",
            k + [values[c] for c in data],
        )

    def unique_index(sql, columns):
        """A UNIQUE index's terms and WHERE, as the runtime's uniqueIndex reads them (M03)."""
        if not sql:
            return (columns, None) if all(c is not None for c in columns) else None
        m = re.search(r"\bON\b", sql, re.I)
        opened = sql.find("(", m.start()) if m else -1
        if opened < 0:
            return None
        terms, depth, quote, start, close = [], 0, "", opened + 1, -1
        i = opened + 1
        while i < len(sql) and close < 0:
            ch = sql[i]
            if quote:
                if ch == quote:
                    quote = ""
            elif ch in "'\"`":
                quote = ch
            elif ch == "[":
                quote = "]"
            elif ch == "(":
                depth += 1
            elif ch == ")" and depth > 0:
                depth -= 1
            elif ch in ",)" and depth == 0:
                terms.append(re.sub(r"\s+(ASC|DESC)$", "", sql[start:i].strip(), flags=re.I))
                start = i + 1
                if ch == ")":
                    close = i
            i += 1
        if close < 0:
            return None
        rest = sql[close + 1 :].strip()
        where = re.sub(r"^WHERE\b", "", rest, flags=re.I).strip() if re.match(r"^WHERE\b", rest, re.I) else None
        return terms, where

    def table_columns(table: str) -> list:
        return [r[0] for r in db.execute(f"SELECT name FROM pragma_table_info({sql_text(table)}) ORDER BY cid")]

    def row_of(table: str, pk: str, values: dict) -> dict:
        return {**dict(zip(keys[table][1], key_values(pk))), **values}

    def collides(table: str, index, x: dict, y: dict) -> bool:
        """Whether two rows take one slot of a UNIQUE index, its terms and WHERE as SQLite evaluates them."""
        terms, where = index
        cols = [c for c in table_columns(table) if c in x and c in y]
        same = [f"((SELECT {t} FROM x) IS (SELECT {t} FROM y))" for t in terms]
        if where:
            same += [f"(SELECT {where} FROM x)", f"(SELECT {where} FROM y)"]
        marks = ", ".join("?" for _ in cols)
        names = ", ".join(q(c) for c in cols)
        got = db.execute(
            f"WITH x({names}) AS (VALUES ({marks})), y({names}) AS (VALUES ({marks})) SELECT {' AND '.join(same)}",
            [x[c] for c in cols] + [y[c] for c in cols],
        ).fetchone()
        return bool(got and got[0] == 1)

    def occupant(table: str, pk: str, values: dict):
        """The other row holding a UNIQUE slot this row's values want, for an index on columns, expressions or with a WHERE."""
        pk_cols = keys[table][1]
        row = row_of(table, pk, values)
        mine = [c for c in table_columns(table) if c in row]
        for (name,) in db.execute(f"SELECT name FROM pragma_index_list({sql_text(table)}) WHERE \"unique\" = 1 AND origin <> 'pk'").fetchall():
            sql = db.execute("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?", [name]).fetchone()
            columns = [None if r[0] is None else q(r[0]) for r in db.execute(f"SELECT name FROM pragma_index_info({sql_text(name)}) ORDER BY seqno")]
            index = unique_index(sql[0] if sql else None, columns)
            if not index:
                continue
            terms, where = index
            cols = [c for c in table_columns(table) if any(re.search(r'(^|[^\w"])"?' + re.escape(c) + r'"?($|[^\w"])', t, re.I) for t in terms)]
            if any(c not in row for c in cols):
                continue
            extra = f" AND ({where}) AND (SELECT {where} FROM mine)" if where else ""
            hit = db.execute(
                f"WITH mine({', '.join(q(c) for c in mine)}) AS (VALUES ({', '.join('?' for _ in mine)})) "
                f"SELECT {', '.join(q(c) for c in pk_cols)} FROM {q(table)} WHERE {' AND '.join(f'({t}) IS (SELECT {t} FROM mine)' for t in terms)}{extra}",
                [row[c] for c in mine],
            ).fetchone()
            if hit:
                other = key_text(list(hit), folds(table))
                if other != pk:
                    return other, index
        return None

    room = [0]

    def same_value(a: object, b: object) -> bool:
        """Two values SQLite stores alike: the same storage class and value."""
        return type(a) is type(b) and a == b if not (isinstance(a, (int, float)) and isinstance(b, (int, float))) else (isinstance(a, float) == isinstance(b, float) and a == b)

    def hold(table: str, pk: str, reason: str, values: dict) -> None:
        held[(table, pk)] = (reason, values)
        flags[(table, pk, "held")] = reason

    def place(table: str, pk: str, force: bool = False) -> None:
        s = state(table, pk)
        if s is None or table not in keys:
            return
        k = spelling(table, pk, s["values"])
        at = key_values(pk)
        if s["deleted"] and not force:
            db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", at)
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
                found = occupant(table, pk, s["values"])
                other = found[0] if found else None
                # The row in the slot moves out of it in this same apply (M04, a swap): taken out, this row
                # written, and placed again under its own merged values.
                theirs = state(table, other) if found and room[0] < 8 else None
                if found and theirs and (theirs["deleted"] or not collides(table, found[1], row_of(table, pk, s["values"]), row_of(table, other, theirs["values"]))):
                    room[0] += 1
                    try:
                        db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", key_values(other))
                        wrote = True
                        try:
                            write(table, k, s["values"])
                        except sqlite3.IntegrityError:
                            wrote = False
                        place(table, other)
                        if wrote:
                            return
                    finally:
                        room[0] -= 1
                if other:
                    mine, theirs = birth(table, pk), birth(table, other)
                    if mine and (not theirs or mine < theirs):
                        hold(table, other, f"UNIQUE: {pk} holds the slot", (state(table, other) or {}).get("values", {}))
                        db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", key_values(other))
                        write(table, k, s["values"])
                        return
                    hold(table, pk, f"UNIQUE: {other} holds the slot", s["values"])
                    return
            if ("CHECK constraint failed" in message or "NOT NULL constraint failed" in message) and within_constraints(table, pk, k, s):
                return
            hold(table, pk, message, s["values"])
            db.execute(f"DELETE FROM {q(table)} WHERE {where(table)}", at)

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
            pk = key_text(list(child), folds(parent))
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

    # The effect group stays together (R-T, M06): a save is one group. A save
    # contends where a row it wrote is pending (every version a same-column
    # conflict names, the proposals a constraint conflict set aside) or held;
    # every other row where its change is still current is pending too.
    def data_heads(table: str, pk: str) -> dict:
        return {
            col: {v for v in vers if (table, pk, col, v) not in sup}
            for col, vers in cells.get((table, pk), {}).items()
            if col != ""
        }

    sources: dict[str, set[tuple[str, str]]] = {}
    for (t, pk, kind) in list(flags):
        if kind != "pending":
            continue
        s = state(t, pk) or {"pending": []}
        heads = data_heads(t, pk)
        for col in s["pending"]:
            for v in heads.get(col, set()):
                sources.setdefault(v, set()).add((t, pk))
        for v in set_aside.get((t, pk), set()):
            sources.setdefault(v, set()).add((t, pk))
    for (t, pk) in held:
        for vers in data_heads(t, pk).values():
            for v in vers:
                sources.setdefault(v, set()).add((t, pk))
    for ver, origin in sources.items():
        for (t, pk) in cells:
            if (t, pk) in origin or (t, pk) in held:
                continue
            if any(ver in vers for vers in data_heads(t, pk).values()):
                flags[(t, pk, "pending")] = None

    db.execute("DELETE FROM _cs_flag")
    db.execute("DELETE FROM _cs_held")
    for (t, pk, kind) in flags:
        db.execute("INSERT INTO _cs_flag (tbl, pk, kind, detail) VALUES (?, ?, ?, NULL)", [t, pk, kind])
    for (t, pk), (reason, _values) in held.items():
        db.execute("INSERT INTO _cs_held (tbl, pk, reason, row) VALUES (?, ?, ?, '{}')", [t, pk, reason])
    db.execute("CREATE TABLE IF NOT EXISTS _cs_refused (ver TEXT PRIMARY KEY, reason TEXT NOT NULL) WITHOUT ROWID")
    db.execute("DELETE FROM _cs_refused")
    for ver, reason in refused.items():
        db.execute("INSERT INTO _cs_refused (ver, reason) VALUES (?, ?)", [ver, reason])


def _neg(s: str) -> tuple:
    """Descending order on a string, as a sort key."""
    return tuple(-ord(ch) for ch in s) + (1,)


def later(kv: tuple) -> tuple:
    """The later version first, by (lc, author, ver), for (ver, (val, lc, author))."""
    return (-kv[1][1], _neg(kv[1][2]), _neg(kv[0]))


def shown(v: object) -> object:
    """A value as the runtime's changesDump writes it: a BLOB as <hex>, an integer past 2^53 as its digits, a REAL
    with no fraction or an infinity as <real ...>."""
    if isinstance(v, (bytes, bytearray)):
        return f"<{bytes(v).hex()}>"
    if isinstance(v, int) and not isinstance(v, bool) and not -SAFE <= v <= SAFE:
        return str(v)
    if isinstance(v, float) and (v.is_integer() or v in (float("inf"), float("-inf"))):
        return f"<real {js_number(v)}>"
    return v


def dump(db: sqlite3.Connection) -> dict:
    out = {}
    db.row_factory = sqlite3.Row
    for t in app_tables(db):
        kind, pk = keys_of(db, t)
        select = f"SELECT rowid AS rowid, * FROM {q(t)}" if kind == "rowid" else f"SELECT * FROM {q(t)}"
        order = "rowid" if kind == "rowid" else ", ".join(q(c) for c in pk)
        out[t] = [
            {c: shown(r[c]) for c in r.keys()}
            for r in db.execute(f"{select} ORDER BY {order}")
        ]
    db.row_factory = None
    return out


def judged(db: sqlite3.Connection) -> dict:
    return {
        "tables": dump(db),
        "flags": sorted([list(r) for r in db.execute("SELECT tbl, pk, kind FROM _cs_flag")]),
        "held": sorted([list(r) for r in db.execute("SELECT tbl, pk FROM _cs_held")]),
        # The admitted changesets refused for their basis (R-X §3): [version, reason].
        "rejected": sorted([list(r) for r in db.execute("SELECT ver, reason FROM _cs_refused")]),
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
            for part in ("flags", "held", "rejected"):
                if sorted(got[part]) != sorted(want.get(part, [])):
                    problems.append(f"{part} differ: got {got[part]}, want {want.get(part, [])}")
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
