"""The property pass, by the Python reader.

    node scripts/properties.mjs        # first: checks the runtime, writes the scenarios
    python scripts/properties.py       # the same scenarios, the Python reader
    python scripts/properties.py --all # every violation, filed ones too

P0, P1 and P2 as scripts/properties.mjs states them (P0 over what is
admitted, not the reports, D190), checked here over the
scenarios it wrote (node_modules/.cache/properties/<vector>.json): each
vector's items (a header and the rows it covers, with the verifier's verdict),
the orders, the mutations (each sealed by the runtime's own seal and verified
by its verifier: this reader does not check signatures) and the subsets. This
reader takes every item and mutation itself, with its own merge, from an empty
copy, and computes what it admits with its own admission; nothing of the
runtime's state is read but the verdicts.

A violation is a finding, filed or not as scripts/properties-known.json says,
and fails the run the same way. Where this reader and the runtime reach
different states from the same arrivals, that is said too, and fails it: the
fixtures hold the two to one answer, and these scenarios are more of them.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else REPO / "node_modules" / ".cache" / "properties"
KNOWN = REPO / "scripts" / "properties-known.json"
spec = importlib.util.spec_from_file_location("dai_merge", REPO / "conformance" / "reference" / "dai_merge.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

ROSTER_SECTIONS = {"holders", "voided", "equivocated", "closed", "reports"}


def decode(value):
    return bytes.fromhex(value["b"]) if isinstance(value, dict) else value


def connection() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.create_function("dai_session_id", 5, m.session_id, deterministic=True)
    return db


def from_bytes(data: bytes) -> sqlite3.Connection:
    db = connection()
    db.deserialize(data)
    return db


def empty_of(statements: list[str]) -> bytes:
    db = connection()
    for sql in statements:
        db.execute(sql)
    data = db.serialize()
    db.close()
    return data


def sibling_of(empty: bytes, header: dict, rows: list[dict]) -> sqlite3.Connection:
    db = from_bytes(empty)
    names = list(header)
    db.execute(f"INSERT INTO _dai_batch ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})", [decode(header[n]) for n in names])
    db.execute("INSERT OR IGNORE INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", (decode(header["author"]),))
    for entry in rows:
        row = entry["row"]
        columns = list(row)
        db.execute(
            f'INSERT INTO "{entry["table"]}" ({", ".join(f"{chr(34)}{c}{chr(34)}" for c in columns)}) VALUES ({", ".join("?" for _ in columns)})',
            [decode(row[c]) for c in columns],
        )
    return db


class Trial:
    """A savepoint rolled back on leaving: every trial leaves the copy as it was."""

    count = 0

    def __init__(self, db: sqlite3.Connection):
        self.db = db
        Trial.count += 1
        self.name = f"trial{Trial.count}"

    def __enter__(self):
        self.db.execute(f"SAVEPOINT {self.name}")
        return self.db

    def __exit__(self, *_):
        self.db.execute(f"ROLLBACK TO {self.name}")
        self.db.execute(f"RELEASE {self.name}")
        return False


def sections(dump: str) -> dict[str, list[str]]:
    found: dict[str, list[str]] = {}
    current = None
    for line in dump.split("\n"):
        if line.startswith("# "):
            current = line[2:]
            found[current] = []
        elif line and current is not None:
            found[current].append(line)
    return found


def admitted_and_held(dump: str) -> list[str]:
    lines = []
    for name, rows in sections(dump).items():
        if name == "holders":
            lines += [f"hold {r}" for r in rows]
        elif name not in ROSTER_SECTIONS:
            lines += [f"{name} {r}" for r in rows]
    return lines


def standing_of(dump: str, author: str) -> str:
    lines = []
    for name, rows in sections(dump).items():
        if name == "holders":
            lines += [f"hold {r}" for r in rows if r.endswith(f"\t{author}")]
        elif name == "closed":
            lines += [f"closed {r}" for r in rows]
        elif name not in ROSTER_SECTIONS:
            lines += [f"{name} {r}" for r in rows if r.startswith(f"{author}:")]
    return "\n".join(sorted(lines))


def gains_of(subsets: list[dict], listed: dict[str, list[str]]) -> dict | None:
    """As the runtime's check: what a set showing his signing twice gives him that a smaller set short of it does not."""
    for shown in (s for s in subsets if s["revealing"]):
        for short in (s for s in subsets if not s["revealing"] and all(h in shown["subset"] for h in s["subset"])):
            added = {rid for h in shown["subset"] if h not in short["subset"] for rid in listed[h]}
            had = set(short["admitted"])
            gained = [line for line in shown["admitted"] if line not in had and (line.startswith("hold ") or line.split(" ")[1] not in added)]
            if gained:
                return {"shown": [h[:8] for h in shown["subset"]], "short": [h[:8] for h in short["subset"]], "gained": gained}
    return None


class Vector:
    def __init__(self, scenario: dict):
        self.s = scenario
        self.name = scenario["name"]
        self.empty = empty_of(scenario["schema"])
        observer = from_bytes(self.empty)
        oid = bytes.fromhex(scenario["observer"])
        observer.execute("INSERT INTO _dai_replica (id, seq, lc) VALUES (?, 0, 0)", (oid,))
        observer.execute("INSERT INTO _dai_replicas (id, first_seen, rows_seen) VALUES (?, 0, 0)", (oid,))
        self.observer = observer.serialize()
        observer.close()
        self.people = scenario["people"]
        self.items = {k: [self.arrival(i) for i in v] for k, v in scenario["items"].items()}

    def arrival(self, j: dict) -> dict:
        return {"id": j["id"], "author": j.get("author"), "view": j.get("view", self.s["view"]), "copy": sibling_of(self.empty, j["header"], j["rows"]), "verdicts": j["verdicts"], "lists": j.get("lists", {})}

    def arrive(self, local: sqlite3.Connection, item: dict) -> list[str]:
        result = m.merge(local, item["copy"], item["verdicts"], item["lists"], {}, {}, self.s["max_parties"], (self.s["view"], item["view"]))
        reports = [f"{self.people.get(r['author'], r['author'])} {r['reason']}" for r in result["refusedBatches"]]
        if result.get("refused"):
            reports.append(f"refused {result['refused']}")
        return reports

    def replay(self, local: sqlite3.Connection, items: list[dict]) -> list[str]:
        reports: list[str] = []
        for item in items:
            reports += self.arrive(local, item)
        return reports

    def dump(self, local: sqlite3.Connection) -> str:
        return m.admitted_dump(local, self.s["max_parties"])

    def signature(self, local: sqlite3.Connection, reports: list[str]) -> str:
        return f"{self.dump(local)}# reports\n" + "\n".join(sorted(set(reports))) + "\n"

    def admitted_of(self, local: sqlite3.Connection, dump: str, author: str) -> list[str]:
        """As the runtime's: an author's holds and admitted rows, a hidden row included."""
        found = sections(dump)
        lines = [f"hold {r}" for r in found.get("holders", []) if r.endswith(f"\t{author}")]
        for table in m.replicated_tables(local):
            heads = {r.split("\t")[0] for r in found.get(table, [])}
            for (rid,) in local.execute(f'SELECT lower(hex(_r_replica)) || \':\' || _r_seq FROM "{table}" WHERE lower(hex(_r_replica)) = ?', (author,)).fetchall():
                if rid in heads or self.admitted_though(local, table, rid):
                    lines.append(f"{table} {rid}")
        return sorted(lines)

    def admitted_though(self, local: sqlite3.Connection, table: str, rid: str) -> bool:
        """As the runtime's check: the row asked about with every row of its entity naming it taken out."""
        author, seq = rid.split(":")
        rows = local.execute(
            f'SELECT lower(hex(_r_replica)) || \':\' || _r_seq, _r_parents FROM "{table}" WHERE _r_entity = (SELECT _r_entity FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?)',
            (bytes.fromhex(author), int(seq)),
        ).fetchall()
        named = {rid}
        grew = True
        while grew:
            grew = False
            for row_id, parents_text in rows:
                if row_id in named:
                    continue
                try:
                    parents = json.loads(parents_text)
                except (TypeError, ValueError):
                    parents = []
                if isinstance(parents, list) and any(p in named for p in parents if isinstance(p, str)):
                    named.add(row_id)
                    grew = True
        named.discard(rid)
        if not named:
            return False
        with Trial(local):
            for (trigger,) in local.execute("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?", (table,)).fetchall():
                local.execute(f'DROP TRIGGER "{trigger}"')
            for row_id in named:
                author, seq = row_id.split(":")
                local.execute(f'DELETE FROM "{table}" WHERE _r_replica = ? AND _r_seq = ?', (bytes.fromhex(author), int(seq)))
            return any(line.split("\t")[0] == rid for line in sections(self.dump(local)).get(table, []))


def check(scenario: dict, violations: list[dict], disagreements: list[str]) -> None:
    v = Vector(scenario)
    name = v.name
    items = v.items["union"]

    # P0
    states: dict[str, list[int]] = {}
    local = from_bytes(v.observer)
    orders = scenario["p0"]["orders"]

    def finish(order, reports):
        states.setdefault(v.signature(local, reports), list(order))

    if orders == "all":
        def go(path, reports):
            if len(path) == len(items):
                finish(path, reports)
                return
            for i in range(len(items)):
                if i in path:
                    continue
                with Trial(local):
                    go(path + [i], reports + v.replay(local, [items[i]]))
        go([], [])
    else:
        for order in orders:
            with Trial(local):
                finish(order, v.replay(local, [items[i] for i in order]))
    local.close()
    # P0 compares what is admitted, not the reports: a report says what one
    # merge made true (D190). The reports are still held to the runtime's, below.
    admitted: dict[str, list[int]] = {}
    for text, order in states.items():
        admitted.setdefault(text.split("# reports\n")[0], order)
    if len(admitted) > 1:
        (first, o1), (second, o2) = list(admitted.items())[:2]
        a, b = first.split("\n"), second.split("\n")
        violations.append({"key": f"P0 {name} state", "orders": [[items[i]["id"][:8] for i in o1], [items[i]["id"][:8] for i in o2]],
                           "difference": {"only_first": [x for x in a if x not in b][:6], "only_second": [x for x in b if x not in a][:6]}})
    if set(states) != set(scenario["p0"]["states"]):
        disagreements.append(f"{name} P0: {len(states)} state(s) here, {len(scenario['p0']['states'])} in the runtime, not the same")

    # P1
    def trial(local, before, label, mutation, sibling, author, node):
        with Trial(local):
            reports = v.arrive(local, sibling)
            after = v.dump(local)
            now = set(admitted_and_held(after))
            removed = []
            for line in admitted_and_held(before):
                if line in now:
                    continue
                if line.startswith("hold "):
                    removed.append(line)
                    continue
                table, rest = line.split(" ", 1)
                if not v.admitted_though(local, table, rest.split("\t")[0]):
                    removed.append(line)
            if removed and not any(r.endswith(" AUTHOR_EQUIVOCATED") for r in reports):
                violations.append({"key": f"P1 {name} {label} {mutation}", "author": author, "removed": removed, "reports": reports})
            if node is not None and (after != node["after"] or sorted(reports) != sorted(node["reports"])):
                disagreements.append(f"{name} P1 {label} {mutation}: the state or the reports differ from the runtime's")

    bases = {}
    for label, list_ in v.items.items():
        local = from_bytes(v.observer)
        v.replay(local, list_)
        bases[label] = (local, v.dump(local))
    held = [r for r in scenario["p1"] if "held" in r]
    for record in scenario["p1"]:
        if "held" in record:
            continue
        sibling = v.arrival(record)
        author = record["name"].split(":")[1]
        for label, (local, before) in bases.items():
            trial(local, before, label, record["name"], sibling, author, record["results"].get(label))
        sibling["copy"].close()
    for local, _ in bases.values():
        local.close()
    local = from_bytes(v.observer)
    by_set: dict[int, list[dict]] = {}
    for record in held:
        by_set.setdefault(record["holding"], []).append(record)
    for mask, records in by_set.items():
        with Trial(local):
            v.replay(local, [item for j, item in enumerate(items) if mask & (1 << j)])
            before = v.dump(local)
            for record in records:
                trial(local, before, "union", record["name"], items[record["held"]], record["name"].split(":")[1], record["results"]["union"])
    local.close()

    # P2: the same for every set of his conflicting headers that shows him signing twice, and no gain from showing it.
    for entry in scenario["p2"]:
        author = entry["author"]
        who = next((n for b64, n in v.people.items() if base64.urlsafe_b64decode(b64 + "==").hex() == author), author[:8])
        listed = {}
        for hid in entry["ids"]:
            item = next(item for item in items if item["id"] == hid)
            covers = item["copy"].execute("SELECT covers FROM _dai_batch").fetchone()[0]
            listed[hid] = [f"{author}:{seq}" for _table, seq in json.loads(covers)]
        local = from_bytes(v.observer)
        v.replay(local, [item for item in items if item["id"] not in entry["all"]])
        standings: dict[str, list[str]] = {}
        mine = []
        for subset in entry["subsets"]:
            with Trial(local):
                v.replay(local, [next(item for item in items if item["id"] == hid) for hid in subset["subset"]])
                dump = v.dump(local)
                standing = standing_of(dump, author)
                admitted = v.admitted_of(local, dump, author)
            mine.append({"subset": subset["subset"], "revealing": subset["revealing"], "standing": standing, "admitted": admitted})
            if admitted != subset["admitted"]:
                disagreements.append(f"{name} P2 {who} {[h[:8] for h in subset['subset']]}: the admitted rows differ from the runtime's")
            if subset["revealing"]:
                standings.setdefault(standing, subset["subset"])
            if standing != subset["standing"]:
                disagreements.append(f"{name} P2 {who} {[h[:8] for h in subset['subset']]}: the standing differs from the runtime's")
        local.close()
        if len(standings) > 1:
            (s1, x), (s2, y) = list(standings.items())[:2]
            violations.append({"key": f"P2 {name} {who} chooses", "subsets": [[h[:8] for h in x], [h[:8] for h in y]],
                               "difference": {"only_first": [l for l in s1.split("\n") if l not in s2.split("\n")][:6], "only_second": [l for l in s2.split("\n") if l not in s1.split("\n")][:6]}})
        gained = gains_of(mine, listed)
        if gained:
            violations.append({"key": f"P2 {name} {who} gains", **gained})

    for list_ in v.items.values():
        for item in list_:
            item["copy"].close()


def main() -> int:
    show_all = "--all" in sys.argv
    args = sys.argv[1:]
    wanted = [a for i, a in enumerate(args) if not a.startswith("--") and (i == 0 or args[i - 1] != "--out")]
    if not OUT.exists():
        print("no scenarios; run `node scripts/properties.mjs` first")
        return 1
    known = json.loads(KNOWN.read_text(encoding="utf-8")) if KNOWN.exists() else {}
    files = sorted(OUT.glob("*.json"))
    if wanted:
        files = [f for f in files if f.stem in wanted]
    violations: list[dict] = []
    disagreements: list[str] = []
    for path in files:
        before = len(violations), len(disagreements)
        try:
            check(json.loads(path.read_text(encoding="utf-8")), violations, disagreements)
        except Exception as error:  # a reader that raises fails the vector, and the run goes on
            disagreements.append(f"{path.stem}: raised {type(error).__name__}: {error}")
        print(f"{path.stem}: {len(violations) - before[0]} violation(s), {len(disagreements) - before[1]} disagreement(s)")
    # One finding per key: a header released from many held sets is one violation, found first from one of them.
    violations = list({x["key"]: x for x in reversed(violations)}.values())[::-1]
    unfiled = [x for x in violations if x["key"] not in known]
    for x in violations if show_all else unfiled:
        filed = f" (filed: {known[x['key']]})" if x["key"] in known else ""
        print(f"  {x['key']}{filed}\n    {json.dumps({k: val for k, val in x.items() if k != 'key'})}")
    keys = {x["key"] for x in violations}
    gone = [] if wanted else [k for k in known if not k.startswith("_") and k not in keys]
    for k in gone:
        print(f"  filed and no longer occurring: {k}")
    for line in disagreements[:40]:
        print(f"  disagrees: {line}")
    print(f"\n{len(files)} vectors by the Python reader: {len(violations)} violation(s), {len(unfiled)} unfiled, {len(disagreements)} disagreement(s) with the runtime.")
    return 1 if unfiled or gone or disagreements else 0


if __name__ == "__main__":
    raise SystemExit(main())
