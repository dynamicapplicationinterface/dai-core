"""Hold-outs: the proof that a witness has teeth.

    python scripts/holdout.py                    # every rule: each must fail its fixtures
    python scripts/holdout.py <rule> ...         # these rules
    python scripts/holdout.py <rule> <fixture>   # one row of a witness table
    python scripts/holdout.py --list             # the rules, their anchors and what each removes

A hold-out removes one rule of docs/format.md, and a witness is a fixture the
hold-out fails. A rule whose removal every fixture passes has no witness,
whatever the fixtures cite. Two kinds:

- the reader (RULES): a copy of conformance/reference/dai_merge.py with the
  rule removed, by text replacements each asserted to match exactly once, so
  a hold-out that no longer applies stops with an error instead of running
  the reader unchanged; loaded in memory, run over every fixture;
- the runtime (RUNTIME): what the verifier and the signer decide, which a
  reader takes from the fixtures and cannot be held out on. A copy of dist/
  with the rule removed, under node_modules/.cache/holdout, and the generator
  run with it in --check mode over the vectors named (needs `npm run build`).

Each rule is named for what it removes, with the anchor it removes it from
and the fixtures that must fail without it. Run with no arguments, every rule
is run and reported HOLDS (each named fixture fails) or NO TEETH (one
passes); the reader, and the runtime, are first run unchanged over the same
fixtures, since a fixture they already fail proves nothing about a rule. A
reader that raises fails the fixture (the fixtures' own triggers refuse some
removals outright). Nothing in the repository is edited.

The witness tables in the handoffs name rules from here. A rule whose witness
is a TypeScript spec, not a fixture, is not here: its hold-out is the runtime
or the runner itself, removed, run and put back, and the handoff says so.
"""

from __future__ import annotations

import re
import shutil
import subprocess
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
SHAPE = "merge-parents-shape"
REFUSALS = "merge-row-refusals"
NAMED = "merge-seal-outranks-named"
VERIFY = "merge-verify-refused"
RELABEL = "merge-relabeled-list"
CANON = "merge-canonical-order"
EPARENT = "merge-equivocated-parent-plain"
HELDROW = "merge-held-row-signed"
HELDLIST = "merge-held-header-relabeled"
OWNSEAT = "session-equivocated-own-seat-parent"
NAMEDHIGH = "merge-row-batch-named-higher"
ROSTERNAMES = "session-roster-names-equivocated"
OTHERTABLE = "session-parent-in-another-table"

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
    # ------------------------------------------------ witness pass 2: Parents and ordering
    "parents-blob": (
        "parents-shape", "parents stored as a BLOB, not text, are read as their text", [SHAPE],
        [("    if not isinstance(text, str):\n        return False\n    try:\n        value = json.loads(text)",
          "    if isinstance(text, (bytes, bytearray)):\n        text = bytes(text).decode('utf-8', 'replace')\n    if not isinstance(text, str):\n        return False\n    try:\n        value = json.loads(text)")],
    ),
    "parents-past-safe": (
        "parents-shape", "a parent's seq past 2^53 - 1 is the shape", [SHAPE],
        [(" and int(item[33:]) <= SAFE_INTEGER", "")],
    ),
    "parents-leading-zero": (
        "parents-shape", "a parent's seq with a leading zero is the shape", [SHAPE],
        [('PARENT_ID = re.compile(r"[0-9a-f]{32}:[1-9][0-9]{0,15}")', 'PARENT_ID = re.compile(r"[0-9a-f]{32}:[0-9]{1,16}")')],
    ),
    "parents-ordered": (
        "parents-order-unchecked", "parents out of order, or naming one id twice, are malformed", [SHAPE],
        [("    return all(\n        isinstance(item, str) and PARENT_ID",
          "    if value != sorted(set(value)):\n        return False\n    return all(\n        isinstance(item, str) and PARENT_ID")],
    ),
    "parents-own-read": (
        "parents-own-malformed", "a copy's own malformed row's parents are read as they stand, outside a merge", [SHAPE],
        [("    if not well_formed_parents(text):\n        return []\n    try:", "    try:")],
    ),
    # ------------------------------------------------ witness pass 2: Merge
    "malformed-incomplete-refused": (
        "merge-headers-malformed", "an incomplete header listing a malformed row is refused ROW_MALFORMED", [REFUSALS],
        [('if verdict == "ok" and any(key in malformed for key in listed):', 'if any(key in malformed for key in listed):')],
    ),
    "malformed-reported-again": (
        "merge-row-malformed", "a malformed row a refused header listed is reported again, under the batch it names", [REFUSALS],
        [("                if key not in tainted:\n", "                if True:\n")],
    ),
    "mismatch-malformed-header-silent": (
        "merge-row-digest-mismatch", "a row naming a header refused ROW_MALFORMED, which does not list it, is not reported", [ORDER],
        [('if named not in held or verdicts.get(named) in ("ok", "incomplete"):',
          'if named not in held or (verdicts.get(named) in ("ok", "incomplete") and (named, "ROW_MALFORMED", bytes(sibling.execute("SELECT author FROM _dai_batch WHERE lower(hex(id)) = ?", (named,)).fetchone()[0]).hex()) not in refusals):')],
    ),
    "mismatch-not-held-silent": (
        "merge-row-digest-mismatch", "a row naming a header the sibling does not hold is not reported", [REFUSALS],
        [('if named not in held or verdicts.get(named) in ("ok", "incomplete"):', 'if verdicts.get(named) in ("ok", "incomplete"):')],
    ),
    "place-unsigned-first": (
        "merge-place", "unsigned rows are placed before signed ones", [NAMED],
        [("for rows, signed in ((signed_rows, True), (unsigned_rows, False)):", "for rows, signed in ((unsigned_rows, False), (signed_rows, True)):")],
    ),
    "outranked-frees-parent": (
        "merge-signed-outranks", "what an outranked row superseded is a head again even when something else names it", [NAMED],
        [(" AND _r_superseded = 1\"\n                f' AND NOT EXISTS (SELECT 1 FROM \"{table}\" n, json_each(n._r_parents) p'\n                f' WHERE p.value = ? AND n._r_entity = \"{table}\"._r_entity)',\n                (parent, parent),",
          " AND _r_superseded = 1\",\n                (parent,),")],
    ),
    "outranks-own-table-only": (
        "merge-signed-outranks-any-table", "a signed row does not outrank an unsigned one at its id in another table", ["merge-seal-cross-table", NAMED],
        [("            if signed and there[0] is None:\n                displace(other, row)\n                continue\n",
          "            if signed and there[0] is None:\n                continue\n")],
    ),
    "kept-under-stored-list": (
        "merge-headers-kept-list", "a header made authentic by the rows' list is kept under the list the sibling stored", [RELABEL],
        [("            if hid in lists:\n                header = (*header[:8], lists[hid])\n", "")],
    ),
    "new-replicas-uncounted": (
        "merge-counts", "newReplicas counts nothing", ["merge-disjoint", "merge-sealed"],
        [('        result["newReplicas"] += 1\n', "")],
    ),
    # ------------------------------------------------ witness pass 2: the page lines
    "own-headers-not-counted": (
        "equivocation-own-headers", "a merge compares an arriving header only with the sibling's headers, not the copy's own", ["session-equivocation", PLAIN],
        [("            for other_id, other_digest, other_covers in local.execute(", "            for other_id, other_digest, other_covers in sibling.execute(")],
    ),
    "outside-names-equivocated": (
        "parent-equivocated-outside", "a roster or plain row naming an equivocated id as a parent is no head", [EPARENT, ROSTERNAMES],
        [("                if not self.unequivocal(r):\n                    continue\n",
          "                if not self.unequivocal(r) or self.names_equivocated(r):\n                    continue\n")],
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
    # ------------------------------------------------ the step 6 re-review's fix-up (1 October)
    "held-row-pending": (
        "merge-row-held-signed", "a held row with _r_batch unset is pending, whatever complete header the copy holds lists it", [HELDROW, "merge-seal-lost-pointer", AFTER],
        [("    if pending and held_before:\n", "    if False:\n")],
    ),
    "held-header-kept-relabeled": (
        "merge-headers-rewritten", "a header the copy held already keeps the list it held it under", [HELDLIST],
        [('                local.execute("UPDATE _dai_batch SET covers = ? WHERE id = ? AND covers <> ?", (header[8], header[0], header[8]))\n', "                pass\n")],
    ),
    # The re-review's own probes, for anchors neither witness table named: each
    # failed a fixture already, and is kept here so the witness stays named.
    "equivocation-per-table": (
        "equivocation-any-table", "one seq signed in two tables under different digests is not equivocation", ["session-equivocation-two-tables", PLAIN],
        [("digests.setdefault((bytes(author), entry[1]), set())", "digests.setdefault((bytes(author), entry[0], entry[1]), set())"),
         ("if len(digests[(author, seq)]) > 1}", "if len(digests[(author, table, seq)]) > 1}"),
         ("                for _table, seq in json.loads(header[8])\n",
          "                for _table, seq in [(t, (t, s)) for t, s in json.loads(header[8])]\n"),
         ("if (bytes(header[1]), seq) not in equivocated_before", "if (bytes(header[1]), seq[1]) not in equivocated_before"),
         ("if mine & {seq for _table, seq in json.loads(other_covers)}:", "if mine & {(t, s) for t, s in json.loads(other_covers)}:")],
    ),
    "third-reveals": (
        "equivocated-third", "a third conflicting header at an id already equivocated reveals", ["session-equivocation-filed"],
        [("                if (bytes(header[1]), seq) not in equivocated_before\n", "")],
    ),
    "row-batch-named-any": (
        "merge-row-batch", "a signed row keeps the header it names when the sibling holds it, complete or not", ["merge-named-incomplete-header"],
        [('keep = named if named is not None and f"{named}|{key}" in covers else cover', "keep = named if named is not None and named in held else cover")],
    ),
    "unsigned-held-any-table": (
        "merge-row-unsigned", "an unsigned row the copy holds at its id in any table goes to placing", ["merge-seal-cross-table"],
        [("            elif local.execute(\n                f'SELECT 1 FROM \"{table}\" WHERE _r_replica = ? AND _r_seq = ?',\n                (row[\"_r_replica\"], row[\"_r_seq\"]),\n            ).fetchone() is not None:",
          "            elif any(local.execute(\n                f'SELECT 1 FROM \"{t}\" WHERE _r_replica = ? AND _r_seq = ?',\n                (row[\"_r_replica\"], row[\"_r_seq\"]),\n            ).fetchone() is not None for t in tables):")],
    ),
    "unsigned-collision-taken": (
        "row-one-id", "an unsigned row at an id another table holds is placed", [NAMED],
        [("            raise ValueError(f\"ROW_REJECTED: {row_id(row['_r_replica'], row['_r_seq'])} is a row of {other}\")", "            continue")],
    ),
    "revealing-incomplete-silent": (
        "revealing-two-headers", "an incomplete kept header reveals nothing", ["session-equivocation-filed"],
        [("            if new:\n                arrived.append(header)\n", "            if new and verdict == \"ok\":\n                arrived.append(header)\n")],
    ),
    "creator-seat-row-any-seq": (
        "session-id-creator-row", "the creator's seat row is any seat row whose author has some seq hashing to its session", ["session-creator-by-seq"],
        [('if s["_r_deleted"] == 0 and self.unequivocal(s) and session_id(s["_r_replica"], s["_r_seq"]) == bytes(s["_r_session"]):',
          'if s["_r_deleted"] == 0 and self.unequivocal(s) and any(session_id(s["_r_replica"], q["_r_seq"]) == bytes(s["_r_session"]) for q in self.rows.get("_dai_seat", []) if bytes(q["_r_replica"]) == bytes(s["_r_replica"])):')],
    ),
    "parent-any-table": (
        "parent-other-entity", "a row of another table at the id a parent names is a version of its entity", [OTHERTABLE],
        [('return [p for p in self.rows[table] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]',
          'return [p for t in self.rows for p in self.rows[t] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]')],
    ),
    "parent-equivocated-admitted": (
        "admitted-parent-equivocated", "a row naming an equivocated id as a parent is admitted when it otherwise would be", [OWNSEAT],
        [("            and self.unequivocal(row)\n            and not self.names_equivocated(row)\n", "            and self.unequivocal(row)\n")],
    ),
    "row-batch-always-lowest": (
        "merge-row-batch", "a signed row's _r_batch is the lowest complete kept header listing it, whatever it names", [NAMEDHIGH],
        [('keep = named if named is not None and f"{named}|{key}" in covers else cover', "keep = cover")],
    ),
    "confirm-names-equivocated": (
        "parent-equivocated-outside", "a confirm naming an equivocated id as a parent counts for nothing", [ROSTERNAMES],
        [("                self.unequivocal(f)\n                and (session",
          "                self.unequivocal(f)\n                and not self.names_equivocated(f)\n                and (session")],
    ),
    "close-names-equivocated": (
        "parent-equivocated-outside", "a close naming an equivocated id as a parent counts for nothing", [ROSTERNAMES],
        [("            and self.unequivocal(x)\n        ]", "            and self.unequivocal(x)\n            and not self.names_equivocated(x)\n        ]")],
    ),
}


# What the verifier and the signer decide, a reader takes from the fixtures
# (verdicts.json) and cannot be held out on. These hold-outs are the runtime:
# a copy of dist/ with one rule removed, by regular-expression edits (the
# bundles rename helpers, `hex2`, `utf8Order2`), each of which must match
# somewhere; the generator run with it, in --check mode, over the vectors
# named, which fail when a verdict, a dump or a header's bytes move (a header
# whose bytes move has no kept signature, and --check signs nothing).
#
# name -> (anchor, what the runtime does instead, fixtures that must fail, [(pattern, replacement), ...])
RUNTIME: dict[str, tuple[str, str, list[str], list[tuple[str, str]]]] = {
    "verify-complete-first": (
        "verify-order", "a header whose listed rows are not all held is incomplete, kept, before its authenticity is asked", [VERIFY],
        [(r"if \(!covers\) \{",
          'if (!covers && stored && !stored.every(([t, s]) => carried.has(t) && db.all(`SELECT 1 FROM "${t}" WHERE _r_replica = ? AND _r_seq = ?`, [author, s]).length === 1)) {'
          ' verdicts.set([...id].map((x) => x.toString(16).padStart(2, "0")).join(""), { ok: true, author, covers: stored, complete: false }); continue; }'
          " if (!covers) {")],
    ),
    "id-unchecked": (
        "verify-authentic", "a header need not hash to its id", [VERIFY],
        [(r"if \((hex\d*)\(await batchIdOf\d*\(canonical\)\) !== \1\(id\)\) continue;", "")],
    ),
    "version-unchecked": (
        "version-unknown-header", "a header of any version is checked as if its version were known", [VERIFY],
        [(r"version === BATCH_FORMAT_VERSION\d* && ", "")],
    ),
    "unreplicated-tried": (
        "verify-unreplicated", "a list naming a table the document does not replicate is tried, and a row there is not found", [VERIFY],
        [(r"if \(list\.some\(\(\[table\]\) => !carried\.has\(table\)\)\) continue;", ""),
         (r'const found = (db\.all\(`SELECT \* FROM "\$\{table\}" WHERE _r_replica = \? AND _r_seq = \?`, \[author, seq\]\));',
          r"const found = carried.has(table) ? \1 : [];")],
    ),
    "spelling-lenient": (
        "covers-spelling", "a stored list in another spelling of the same pairs is a list", [VERIFY],
        [(r"if \(JSON\.stringify\(pairs\) !== text\) return null;", "")],
    ),
    "lists-any-author": (
        "verify-lists-tried", "the recovered list is every row naming the id, of any author", [RELABEL],
        [(r"WHERE _r_batch = \? AND _r_replica = \?`, \[id, author\]", "WHERE _r_batch = ?`, [id]")],
    ),
    "rows-seq-order": (
        "canonical-rows", "canonical rows ordered by seq alone", [CANON],
        [(r"\.sort\(\(a, b\) => utf8Order\d*\(a\.table, b\.table\) \|\| a\.row\._r_seq - b\.row\._r_seq\)", ".sort((a, b) => a.row._r_seq - b.row._r_seq)")],
    ),
    "covers-seq-order": (
        "canonical-header", "covers ordered by seq alone, when signed and when read", [CANON],
        [(r"pairs\.sort\(\(a, b\) => utf8Order\d*\(a\[0\], b\[0\]\) \|\| a\[1\] - b\[1\]\);", "pairs.sort((a, b) => a[1] - b[1]);"),
         (r"utf8Order\d*\(pairs\[i - 1\]\[0\], pairs\[i\]\[0\]\) \|\| pairs\[i - 1\]\[1\] - pairs\[i\]\[1\]", "pairs[i - 1][1] - pairs[i][1]")],
    ),
    "locale-order": (
        "conv-utf8-order", "names ordered by locale, not by their UTF-8 bytes", [CANON],
        [(r"function (utf8Order\d*)\(a, b\) \{", r"function \1(a, b) { return a.localeCompare(b);")],
    ),
    "utf16-order": (
        "conv-utf8-order", "names ordered by UTF-16 code unit, not by their UTF-8 bytes", [CANON],
        [(r"function (utf8Order\d*)\(a, b\) \{", r"function \1(a, b) { return a < b ? -1 : a > b ? 1 : 0;")],
    ),
    # ------------------------------------------------ the step 6 re-review's fix-up (1 October)
    # The admission and roster views are SQL the reader does not share, so the
    # rules the reader holds out above are held out of the runtime too.
    "seq-twice-allowed": (
        "covers-seq-once", "a list naming one seq in two tables is a list", ["merge-seal-seq-twice"],
        [(r"if \(new Set\(pairs\.map\(\(\[, seq\]\) => seq\)\)\.size !== pairs\.length\) return null;", "")],
    ),
    "held-row-pending-rt": (
        "merge-row-held-signed", "a held row with _r_batch unset is pending, whatever complete header the copy holds lists it", [HELDROW, "merge-seal-lost-pointer", AFTER],
        [(r"if \(heldBefore\.size > 0\) \{", "if (false) {")],
    ),
    "held-header-kept-relabeled-rt": (
        "merge-headers-rewritten", "a header the copy held already keeps the list it held it under", [HELDLIST],
        [(r'if \(!isNew\) local\.run\("UPDATE _dai_batch SET covers', 'if (false) local.run("UPDATE _dai_batch SET covers')],
    ),
    "parent-equivocated-admitted-rt": (
        "admitted-parent-equivocated", "admitted and waiting rows may name an equivocated id as a parent", [OWNSEAT],
        [(r" AND NOT \$\{namesEquivocated\d*\(row\)\}", "")],
    ),
    "row-batch-always-lowest-rt": (
        "merge-row-batch", "a signed row's _r_batch is the lowest complete kept header listing it, whatever it names", [NAMEDHIGH],
        [(r"const keep = named && covers\.has\(`\$\{named\}\|\$\{key\}`\) \? named : cover;", "const keep = cover;")],
    ),
    "confirm-names-equivocated-rt": (
        "parent-equivocated-outside", "a confirm naming an equivocated id as a parent counts for nothing (_dai_confirmed)", [ROSTERNAMES],
        [(r'WHERE \$\{(unequivocal\d*)\("f"\)\}', r'WHERE ${\1("f")} AND NOT ${namesEquivocated("f")}')],
    ),
    "close-names-equivocated-rt": (
        "parent-equivocated-outside", "a close naming an equivocated id as a parent counts for nothing (_dai_closed, and late rows)", [ROSTERNAMES],
        [(r'\$\{(closedBy\d*)\("x", closeCreator\)\} AND \$\{(unequivocal\d*)\("x"\)\}',
          r'${\1("x", closeCreator)} AND ${\2("x")} AND NOT ${namesEquivocated("x")}')],
    ),
    "outside-names-equivocated-rt": (
        "parent-equivocated-outside", "a roster, close or plain row naming an equivocated id as a parent is no head", [EPARENT, ROSTERNAMES],
        [(r'WHERE \$\{(unequivocal\d*)\("r"\)\}(\s+AND NOT EXISTS \(SELECT 1 FROM \$\{q\} c,)',
          r'WHERE ${\1("r")} AND NOT ${namesEquivocated("r")}\2')],
    ),
}

CACHE = REPO / "node_modules" / ".cache" / "holdout"


def runtime_copy(name: str, edits: list[tuple[str, str]], wanted: list[str]) -> Path:
    """dist/ with the edits made, and the generator and the vectors it checks,
    under node_modules/.cache so the bundles still resolve their packages."""
    root = CACHE / name
    shutil.rmtree(root, ignore_errors=True)
    (root / "dist").mkdir(parents=True)
    texts = {path.name: path.read_text(encoding="utf-8") for path in (REPO / "dist").glob("*.js")}
    if not texts:
        raise SystemExit("no dist/; run `npm run build` first")
    for pattern, replacement in edits:
        total = 0
        for file, text in texts.items():
            texts[file], count = re.subn(pattern, replacement, text)
            total += count
        if total == 0:
            raise SystemExit(f"a runtime hold-out's edit matches nothing in dist/: {pattern[:80]!r}")
    for file, text in texts.items():
        (root / "dist" / file).write_text(text, encoding="utf-8")
    (root / "scripts").mkdir()
    shutil.copy(REPO / "scripts" / "build-merge-fixtures.mjs", root / "scripts")
    (root / "docs").mkdir()
    shutil.copy(REPO / "docs" / "replicated-tables.md", root / "docs")
    suite = root / "conformance" / "merge"
    suite.mkdir(parents=True)
    for file in ("signatures.json", "README.md"):
        shutil.copy(SUITE / file, suite)
    for name_ in wanted:
        shutil.copytree(SUITE / name_, suite / name_)
    return root


def generate(name: str, edits: list[tuple[str, str]], wanted: list[str]) -> list[str]:
    """The generator's complaints, checking `wanted` against a runtime with the edits made; none when it passes."""
    root = runtime_copy(name, edits, wanted)
    try:
        run = subprocess.run(
            ["node", str(root / "scripts" / "build-merge-fixtures.mjs"), "--check", "--only", ",".join(wanted)],
            capture_output=True, text=True, encoding="utf-8", cwd=root,
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if run.returncode == 0:
        return []
    lines = [line for line in (run.stderr + run.stdout).splitlines() if line.strip()]
    return lines[:8] or [f"exit {run.returncode}"]


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


def checked(reader: types.ModuleType, name: str) -> list[str]:
    """What a reader gets wrong on one fixture. A reader that raises gets it
    wrong too: the fixtures' own triggers refuse some removals outright."""
    try:
        return reader.check(name)
    except Exception as error:  # noqa: BLE001, any failure to finish is a failure
        return [f"{name}: raised {type(error).__name__}: {error}"]


def baseline(names: list[str], runtime: list[str]) -> None:
    """The reader unchanged must pass every fixture a hold-out is run over, and
    the runtime unchanged every vector a runtime hold-out is run over."""
    reader = held([])
    failing = [n for n in names if checked(reader, n)]
    if failing:
        raise SystemExit(f"the reader itself fails {', '.join(failing)}; no hold-out proves anything until it passes")
    if runtime:
        found = generate("baseline", [], runtime)
        if found:
            raise SystemExit("the runtime itself fails " + ", ".join(runtime) + ":\n  " + "\n  ".join(found))


def failing_under(rule: str, names: list[str]) -> dict[str, list[str]]:
    """The fixtures this hold-out fails, with what went wrong: a reader hold-out
    over every fixture given, a runtime one over the vectors it names."""
    if rule in RULES:
        reader = held(RULES[rule][3])
        return {n: found for n in names if (found := checked(reader, n))}
    _anchor, _what, must, edits = RUNTIME[rule]
    wanted = [n for n in names if n in must] or must
    found = generate(rule, edits, wanted)
    # The generator stops at the first vector it cannot build; each named
    # vector is run alone when there are several, so each is seen to fail.
    if len(wanted) == 1:
        return {wanted[0]: found} if found else {}
    return {n: f for n in wanted if (f := generate(rule, edits, [n]))}


def describe(rule: str) -> tuple[str, str, list[str], str]:
    if rule in RULES:
        anchor, what, must, _edits = RULES[rule]
        return anchor, what, must, "reader"
    anchor, what, must, _edits = RUNTIME[rule]
    return anchor, what, must, "runtime"


def one(rule: str, fixture: str) -> int:
    anchor, what, _must, kind = describe(rule)
    baseline([fixture], [fixture] if kind == "runtime" else [])
    found = failing_under(rule, [fixture]).get(fixture, [])
    print(f"{rule} (#{anchor}, the {kind}): {what}")
    if found:
        for line in found:
            print(f"  {line}")
        print(f"{fixture} fails it: a witness.")
        return 0
    print(f"{fixture} passes it: not a witness of this rule.")
    return 1


def every(wanted: list[str]) -> int:
    names = fixtures()
    runtime = sorted({n for rule in wanted if rule in RUNTIME for n in RUNTIME[rule][2]})
    baseline(names, runtime)
    bad = 0
    for rule in wanted:
        anchor, _what, must, kind = describe(rule)
        failing = sorted(failing_under(rule, names))
        missed = [n for n in must if n not in failing]
        bad += bool(missed)
        verdict = "NO TEETH" if missed else "HOLDS"
        line = f"{verdict:9} {rule:34} {kind:8} #{anchor:30} fails: {', '.join(failing) or '-'}"
        if missed:
            line += f"   (should also fail: {', '.join(missed)})"
        print(line, flush=True)
    print(
        f"\n{len(wanted) - bad} of {len(wanted)} hold-outs fail every fixture named for them; "
        f"the reader unchanged passes all {len(names)}"
        + (f", and the runtime unchanged the {len(runtime)} its hold-outs run." if runtime else ".")
    )
    return 1 if bad else 0


def main(argv: list[str]) -> int:
    rules = {**RULES, **RUNTIME}
    if argv[:1] == ["--list"]:
        for rule in rules:
            anchor, what, must, kind = describe(rule)
            print(f"{rule:34} {kind:8} #{anchor:30} {what}  [{', '.join(must)}]")
        return 0
    if len(argv) == 2 and argv[0] in rules and argv[1] in fixtures():
        return one(argv[0], argv[1])
    unknown = [a for a in argv if a not in rules]
    if unknown:
        raise SystemExit(f"no hold-out named {unknown[0]!r} (nor a fixture); --list names them")
    return every(argv or list(rules))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
