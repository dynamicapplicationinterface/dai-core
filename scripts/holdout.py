"""Hold-outs of the Python merge reader: the proof that a witness has teeth.

    python scripts/holdout.py                    # every rule: each must fail its fixtures
    python scripts/holdout.py <rule> ...         # these rules, over every fixture
    python scripts/holdout.py <rule> <fixture>   # one row of a witness table
    python scripts/holdout.py --list             # the rules, their anchors and what each removes

A hold-out is a copy of conformance/reference/dai_merge.py with one rule of
docs/format.md removed: a text replacement asserted to match exactly once, so
a hold-out that no longer applies stops with an error instead of running the
reader unchanged. A witness is a fixture the hold-out fails. A rule whose
removal every fixture passes has no witness, whatever the fixtures cite.

Each rule is named for what it removes, with the anchor it removes it from
and the fixtures that must fail without it. Run with no arguments, every rule
is run over every fixture and reported HOLDS (each named fixture fails) or NO
TEETH (one passes); the reader itself is first run unchanged over the same
fixtures, since a fixture the reader fails already proves nothing about a
rule. The copy is never written to disk and the reader is never edited.

The witness tables in the handoffs name rules from here. A rule whose witness
is a TypeScript spec, not a fixture, is not here: its hold-out is the runtime
itself, and the handoff says so beside it.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
READER = REPO / "conformance" / "reference" / "dai_merge.py"
SUITE = REPO / "conformance" / "merge"
SUITE_LINE = 'SUITE = Path(__file__).resolve().parents[1] / "merge"'

EOS = "session-entity-other-session"
OSEAT = "session-other-seat"
CLOSE = "session-close-scope"
CREATOR = "session-creator-deleted"
SEATV = "session-equivocated-seat-version"
ECREATOR = "session-equivocated-creator"
WHOLE = "session-equivocation-whole-digest"
PLAIN = "merge-equivocated-plain-heads"
ORDER = "merge-report-order"
BOTH = "session-equivocation-and-void"
SEATROW = "session-void-creator-seat-row"
X3 = "session-void-equivocated-confirm"
AFTER = "session-seat-not-held-after-merge"
SILENT = "session-equivocated-row-silent"

SORT = "for key in sorted(refusals)\n"

# name -> (anchor, what the copy does instead, fixtures that must fail, [(old, new), ...])
RULES: dict[str, tuple[str, str, list[str], list[tuple[str, str]]]] = {
    # ------------------------------------------------ witness pass 1: Session admission
    "parent-any-entity": (
        "parent-other-entity", "a parent of another entity counts as a version", [OSEAT],
        [('return [p for p in self.rows[table] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]',
          'return [p for p in self.rows[table] if rid_of(p) in wanted]')],
    ),
    "creator-equivocated": (
        "session-skip-equivocated", "the creator's seat row at an equivocated id seats its author", [ECREATOR],
        [('if s["_r_deleted"] == 0 and self.unequivocal(s) and session_id', 'if s["_r_deleted"] == 0 and session_id')],
    ),
    "creator-deleted": (
        "creator", "a deleted creator's seat row counts", [CREATOR],
        [('if s["_r_deleted"] == 0 and self.unequivocal(s) and session_id', 'if self.unequivocal(s) and session_id')],
    ),
    "confirm-any-creator": (
        "confirms", "a confirm counts by the creator of any session", [CREATOR],
        [('and (session, bytes(f["_r_replica"])) in self.creator_of\n',
          'and bytes(f["_r_replica"]) in {c[1] for c in self.creator_of}\n')],
    ),
    "close-deleted-counts": (
        "close-counts", "a close row written deleted counts", [CLOSE],
        [('if x["_r_deleted"] == 0\n            and (bytes(x["_r_session"])', 'if (bytes(x["_r_session"])')],
    ),
    "close-revoked-by-delete": (
        "close-first", "a delete of a close revokes it", [CLOSE],
        [("        self.closed = {bytes(x[\"_r_session\"]) for x in self.closes}",
          "        revoked = {p for y in self.rows.get('_dai_close', []) if y['_r_deleted'] == 1 for p in parents_of(y['_r_parents'])}\n"
          "        self.closes = [x for x in self.closes if rid_of(x) not in revoked]\n"
          "        self.closed = {bytes(x[\"_r_session\"]) for x in self.closes}")],
    ),
    "close-member-any-session": (
        "close-counts", "a member of any session may close", [CLOSE],
        [('and (bytes(x["_r_session"]), bytes(x["_r_replica"])) in self.members',
          'and bytes(x["_r_replica"]) in {m[1] for m in self.members}')],
    ),
    "close-equivocated": (
        "equivocated-counts-nothing", "a close at an equivocated id counts", ["session-equivocation-two-tables"],
        [("            and self.unequivocal(x)\n        ]", "        ]")],
    ),
    "late-any-session": (
        "late", "a close makes its author late in every session", [CLOSE],
        [('bytes(x["_r_session"]) == bytes(row["_r_session"])\n            and bytes(x["_r_replica"])', 'bytes(x["_r_replica"])')],
    ),
    "seat-not-pair": (
        "admitted-seat", "holding a seat's bytes in any session holds it", [EOS],
        [('return isinstance(seat, bytes) and (bytes(row["_r_session"]), seat, bytes(row["_r_replica"])) in self.holders',
          'return isinstance(seat, bytes) and any(h[1] == seat and h[2] == bytes(row["_r_replica"]) for h in self.holders)')],
    ),
    "admit-other-session": (
        "admitted-no-other-session", "a row naming another session's version of its entity is admitted", [EOS],
        [("not self.foreign(table, row)\n            and self.not_late(row)", "self.not_late(row)")],
    ),
    "admit-other-seat": (
        "admitted-no-other-seat", "a row naming another seat's version is admitted", [OSEAT],
        [("if not self.holds(table, row) or self.other_seat(table, row):", "if not self.holds(table, row):")],
    ),
    "roster-equivocated-hides": (
        "heads-roster", "a roster row at an equivocated id hides the row it names", [SEATV],
        [("                    and self.unequivocal(c)\n                    and me in parents_of", "                    and me in parents_of")],
    ),
    "roster-equivocated-head": (
        "heads-roster", "a roster row at an equivocated id is a head", [SEATV],
        [("                if not self.unequivocal(r):\n                    continue\n", "")],
    ),
    "plain-equivocated-hides": (
        "heads-plain", "a plain row at an equivocated id hides the row it names", [PLAIN],
        [("                    and self.unequivocal(c)\n                    and me in parents_of", "                    and (self.unequivocal(c) if session else True)\n                    and me in parents_of")],
    ),
    "plain-equivocated-head": (
        "heads-plain", "a plain row at an equivocated id is a head", [PLAIN],
        [("                if not self.unequivocal(r):\n                    continue\n", "                if session and not self.unequivocal(r):\n                    continue\n")],
    ),
    # ------------------------------------------------ witness pass 1: Equivocation
    # A reader comparing the row at the id rather than the whole batch cannot
    # be written from the headers alone (a copy holds one row at an id in a
    # table), so this approximates it: two headers listing a seq in one table,
    # whose lists differ, differ in another row, so they are not equivocation
    # at this one.
    "equivocation-per-row": (
        "equivocation-whole-digest", "two headers that differ only in another row are not equivocation at this one", [WHOLE],
        [("    return {(author, table, seq) for author, table, seq in listings if len(digests[(author, seq)]) > 1}",
          "    lists = {}\n"
          "    for author, digest, covers in (db.execute('SELECT author, digest, covers FROM _dai_batch') if has_batch else []):\n"
          "        for entry in json.loads(covers):\n"
          "            lists.setdefault((bytes(author), entry[1]), []).append((entry[0], covers))\n"
          "    def elsewhere(key):\n"
          "        found = lists.get(key, [])\n"
          "        return len({t for t, _ in found}) == 1 and len({c for _, c in found}) > 1\n"
          "    return {(author, table, seq) for author, table, seq in listings if len(digests[(author, seq)]) > 1 and not elsewhere((author, seq))}"),
         ("                if mine & {seq for _table, seq in json.loads(other_covers)}:",
          "                theirs_, ours_ = json.loads(other_covers), json.loads(header[8])\n"
          "                if mine & {seq for _table, seq in theirs_} and (theirs_ == ours_ or {t for t, _ in theirs_} != {t for t, _ in ours_}):")],
    ),
    # ------------------------------------------------ witness pass 1: Reports
    "order-no-id-last": ("report-order", "reports under no id sort last", [ORDER], [(SORT, 'for key in sorted(refusals, key=lambda k: (k[0] == "", k))\n')]),
    "order-author-before-code": ("report-order", "the author key sorts before the code", [ORDER], [(SORT, "for key in sorted(refusals, key=lambda k: (k[0], k[2], k[1]))\n")]),
    "order-author-descending": ("report-order", "authors sort in descending order", [ORDER], [(SORT, "for key in sorted(refusals, key=lambda k: (k[0], k[1], [-ord(c) for c in k[2]]))\n")]),
    "signature-invalid-no-id": ("code-signature-invalid", "BATCH_SIGNATURE_INVALID filed under no id", [ORDER], [("refuse_batch(hid, header[1], verdict)", 'refuse_batch("", header[1], verdict)')]),
    "malformed-header-no-id": ("code-row-malformed", "ROW_MALFORMED for a refused header filed under no id", [ORDER], [('refuse_batch(hid, header[1], "ROW_MALFORMED")', 'refuse_batch("", header[1], "ROW_MALFORMED")')]),
    "malformed-named-no-id": ("code-row-malformed", "ROW_MALFORMED for a row naming a batch filed under no id", [ORDER], [('refuse_batch(named or "", row["_r_replica"], "ROW_MALFORMED")', 'refuse_batch("", row["_r_replica"], "ROW_MALFORMED")')]),
    "malformed-unnamed-unsigned": ("code-row-malformed", "a malformed row naming no batch reported BATCH_UNSIGNED", [ORDER], [('refuse_batch(named or "", row["_r_replica"], "ROW_MALFORMED")', 'refuse_batch(named or "", row["_r_replica"], "ROW_MALFORMED" if named else "BATCH_UNSIGNED")')]),
    "digest-mismatch-no-id": ("code-digest-mismatch", "BATCH_DIGEST_MISMATCH filed under no id", [ORDER], [('refuse_batch(named, row["_r_replica"], "BATCH_DIGEST_MISMATCH")', 'refuse_batch("", row["_r_replica"], "BATCH_DIGEST_MISMATCH")')]),
    "unsigned-under-header": (
        "code-unsigned", "BATCH_UNSIGNED filed under the author's lowest header", [ORDER],
        [('refuse_batch("", row["_r_replica"], "BATCH_UNSIGNED")',
          'refuse_batch(min((i for i, h in held.items() if bytes(sibling.execute("SELECT author FROM _dai_batch WHERE id = ?", (h,)).fetchone()[0]) == bytes(row["_r_replica"])), default=""), row["_r_replica"], "BATCH_UNSIGNED")')],
    ),
    "seat-filed-as-carried": (
        "code-seat-not-held", "SEAT_NOT_HELD filed under the batch the row carried, not its _r_batch after the merge", [AFTER],
        [('                "_r_session": incoming.get("_r_session"),\n',
          '                "_r_session": incoming.get("_r_session"),\n                "carried": incoming.get("_r_batch"),\n'),
         ('refuse_batch(bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "", row["_r_replica"], "SEAT_NOT_HELD")',
          'refuse_batch(bytes(row["carried"]).hex() if row["carried"] is not None else "", row["_r_replica"], "SEAT_NOT_HELD")')],
    ),
    "eos-not-reported": (
        "code-entity-other-session", "ENTITY_OTHER_SESSION not reported", [EOS],
        [('found.append(("ENTITY_OTHER_SESSION", r, p))', 'pass')],
    ),
    "crossing-filed-no-id": (
        "code-entity-other-session", "a crossing filed under no id", [EOS],
        [('refuse_batch(bytes(batch).hex() if batch is not None else "", child["_r_replica"], reason)',
          'refuse_batch("", child["_r_replica"], reason)')],
    ),
    "crossing-filed-parent": (
        "code-entity-other-session", "a crossing filed under the parent's batch", [EOS],
        [("batch = child[\"_r_batch\"]\n", "batch = parent[\"_r_batch\"]\n")],
    ),
    "crossing-not-made-true": (
        "report-made-true", "a crossing reported by every merge that holds it", [EOS],
        [("if rid_of(child) in came or rid_of(parent) in came:", "if True:")],
    ),
    "crossing-child-only": (
        "report-crossing", "a crossing reported only when the merge took the child", [EOS],
        [("if rid_of(child) in came or rid_of(parent) in came:", "if rid_of(child) in came:")],
    ),
    "seat-crossing-child-only": (
        "report-crossing", "a version of another seat reported only when the merge took the child", [OSEAT],
        [("if rid_of(child) in came or rid_of(parent) in came:", "if rid_of(child) in came or (reason == 'ENTITY_OTHER_SESSION' and rid_of(parent) in came):")],
    ),
    "seat-any-length": (
        "seat-not-held", "any byte string is a seat", [X3],
        [('if not isinstance(seat, bytes) or len(seat) != 16:\n            return True', 'if not isinstance(seat, bytes):\n            return True')],
    ),
    "other-seat-not-reported": (
        "seat-not-held", "a version of another seat not reported", [OSEAT],
        [("return (held and not self.holds(table, row)) or self.other_seat(table, row)", "return held and not self.holds(table, row)"),
         ('found.append(("SEAT_NOT_HELD", r, p))', "pass")],
    ),
    "late-reported": (
        "report-silent", "a late row taken is reported SEAT_NOT_HELD", [CLOSE],
        [('        seat = row[self.seated[table]]\n        if not isinstance(seat, bytes) or len(seat) != 16:',
          '        if not self.not_late(row):\n            return True\n        seat = row[self.seated[table]]\n        if not isinstance(seat, bytes) or len(seat) != 16:')],
    ),
    "reveal-kinds-apart": (
        "equivocated-report", "equivocation and void seats reported apart", [BOTH],
        [("    def reveal(author: bytes, hid: str) -> None:\n        revealed.setdefault(bytes(author).hex(), (bytes(author), []))[1].append(hid)",
          "    def reveal(author: bytes, hid: str, kind: str = '') -> None:\n        revealed.setdefault(bytes(author).hex() + kind, (bytes(author), []))[1].append(hid)"),
         ('reveal(creator, bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "")',
          'reveal(creator, bytes(row["_r_batch"]).hex() if row["_r_batch"] is not None else "", "|void")'),
         ('                reveal(creator, "")', '                reveal(creator, "", "|void")')],
    ),
    "reveal-held-before": (
        "revealing-two-headers", "a header the copy held before the merge reveals", [BOTH],
        [("        for header in arrived:\n",
          "        for header in local.execute('SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch').fetchall():\n")],
    ),
    "void-confirms-only": (
        "revealing-two-confirms", "only confirms reveal a void seat, not the creator's seat row", [SEATROW],
        [('table == "_dai_seat"\n                        and row["_r_deleted"] == 0', 'False\n                        and row["_r_deleted"] == 0')],
    ),
    "void-equivocated-confirm-reveals": (
        "revealing-two-confirms", "a confirm at an equivocated id reveals", [X3],
        [('                and (bytes(row["_r_replica"]), row["_r_seq"]) not in admission.equivocated_at\n', "")],
    ),
    "void-filed-highest": (
        "equivocated-filed", "AUTHOR_EQUIVOCATED filed under the highest revealing header", [SEATROW],
        [('refuse_batch(min(ids), author, "AUTHOR_EQUIVOCATED")', 'refuse_batch(max(ids), author, "AUTHOR_EQUIVOCATED")')],
    ),
    # ------------------------------------------------ R9: a row at an equivocated id
    "equivocated-unseated-reported": (
        "report-silent", "a row at an equivocated id naming no seat is reported SEAT_NOT_HELD", [SILENT],
        [("if self.names_equivocated(row) or not self.unequivocal(row):\n            return False",
          "if self.names_equivocated(row):\n            return False")],
    ),
    "equivocated-foreign-reported": (
        "report-silent", "a row at an equivocated id naming another session's version is reported ENTITY_OTHER_SESSION", [SILENT],
        [("if self.names_equivocated(r) or not self.unequivocal(r):\n                continue", "if self.names_equivocated(r):\n                continue"),
         ('and p[column] != r[column]:', 'and p[column] != r[column] and self.unequivocal(r):')],
    ),
    "equivocated-other-seat-reported": (
        "report-silent", "a row at an equivocated id naming another seat's version is reported SEAT_NOT_HELD", [SILENT],
        [("if self.names_equivocated(r) or not self.unequivocal(r):\n                continue", "if self.names_equivocated(r):\n                continue"),
         ('if bytes(p["_r_session"]) != bytes(r["_r_session"]):', 'if bytes(p["_r_session"]) != bytes(r["_r_session"]) and self.unequivocal(r):')],
    ),
}


def held(edits: list[tuple[str, str]]) -> types.ModuleType:
    """The reader with the edits made, loaded as a module that reads the suite."""
    text = READER.read_text(encoding="utf-8")
    for old, new in edits:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"a hold-out's edit matches the reader {count} times, not once: {old[:80]!r}")
        text = text.replace(old, new)
    if text.count(SUITE_LINE) != 1:
        raise SystemExit("the reader no longer names its suite as this script expects")
    text = text.replace(SUITE_LINE, f"SUITE = Path({str(SUITE)!r})")
    module = types.ModuleType("dai_merge_held")
    module.__dict__["__file__"] = str(READER)
    exec(compile(text, "dai_merge_held.py", "exec"), module.__dict__)
    return module


def fixtures() -> list[str]:
    return sorted(p.name for p in SUITE.iterdir() if p.is_dir())


def baseline(names: list[str]) -> None:
    """The reader unchanged must pass every fixture a hold-out is run over."""
    reader = held([])
    failing = [n for n in names if reader.check(n)]
    if failing:
        raise SystemExit(f"the reader itself fails {', '.join(failing)}; no hold-out proves anything until it passes")


def one(rule: str, fixture: str) -> int:
    anchor, what, _must, edits = RULES[rule]
    baseline([fixture])
    found = held(edits).check(fixture)
    print(f"{rule} (#{anchor}): {what}")
    if found:
        for line in found:
            print(f"  {line}")
        print(f"{fixture} fails it: a witness.")
        return 0
    print(f"{fixture} passes it: not a witness of this rule.")
    return 1


def every(wanted: list[str]) -> int:
    names = fixtures()
    baseline(names)
    bad = 0
    for rule in wanted:
        anchor, what, must, edits = RULES[rule]
        reader = held(edits)
        failing = [n for n in names if reader.check(n)]
        missed = [n for n in must if n not in failing]
        bad += bool(missed)
        verdict = "NO TEETH" if missed else "HOLDS"
        line = f"{verdict:9} {rule:34} #{anchor:28} fails: {', '.join(failing) or '-'}"
        if missed:
            line += f"   (should also fail: {', '.join(missed)})"
        print(line)
    print(f"\n{len(wanted) - bad} of {len(wanted)} hold-outs fail every fixture named for them; the reader unchanged passes all {len(names)}.")
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    if argv[:1] == ["--list"]:
        for rule, (anchor, what, must, _edits) in RULES.items():
            print(f"{rule:34} #{anchor:28} {what}  [{', '.join(must)}]")
        return 0
    if len(argv) == 2 and argv[0] in RULES and argv[1] in fixtures():
        return one(argv[0], argv[1])
    unknown = [a for a in argv if a not in RULES]
    if unknown:
        raise SystemExit(f"no hold-out named {unknown[0]!r} (nor a fixture); --list names them")
    return every(argv or list(RULES))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
