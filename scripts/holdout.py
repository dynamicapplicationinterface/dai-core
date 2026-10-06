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
RECONF = "session-creator-equivocates-reconfirm"
UNDONE = "session-creator-equivocates-void-undone"
HEADERONLY = "session-creator-equivocates-header-only"
MAXP = "session-seat-beyond-max-parties"
UNSEATED = "session-equivocated-parent-unseated"
HOLDS = [f"session-seal-hold-{order}-{at}" for order in ("one-batch", "two-batch") for at in ("first", "last")]
WAITS = [
    "session-waits-entity-other-session",
    "session-waits-equivocated-parent-d5",
    "session-waits-equivocated-parent-e5",
    "session-waits-equivocated-row-silent",
    "session-waits-other-seat",
    "session-waits-other-seat-forward-bo",
    "session-waits-other-seat-forward-cy",
    "session-waits-reply-first",
    "session-waits-void-creator-row-tombstone",
]
# The ninth attack review (3 October) and its rulings, R14 to R20, A03, A09.
GAP1 = "session-gap-seat-row"
GAP2 = "session-gap-creator-row-version"
UNASKED = "session-seat-value-unasked"
OTHERROW = "session-seat-value-other-row"
CVERSION = "session-seat-value-creator-version"
THREE = "session-three-parties"
THREEQ = "session-three-parties-equivocator"
MISMATCH = "merge-signed-view-mismatch"
JOINERCLOSE = "session-joiner-equivocator-close"
TOMB = "session-void-creator-row-tombstone"
TEXTSEAT = "session-seat-value-text"
SHORTSEAT = "session-seat-value-short"
CLOSESKIP = "session-close-skipped-seq"
CLOSEDEL = "session-close-deleted"
FORWARD = "session-parent-forward"
INVALID = [f"session-roster-invalid-{shape}" for shape in ("own-seat", "too-many", "close-rule")]
# Branch review pass A (5 October): H1, a roster value that is not 16 bytes.
DUMPREAL = "merge-dump-real"
FILEDNONE = "session-equivocation-filed-over-none"
CONFIRMSHORT = "session-confirm-seat-short"
HOLDERSHORT = "session-confirm-holder-short"
# Branch review pass A, M3: the branch-new vectors without a hold-out (5 October).
BYSEQ = "session-creator-by-seq"
BELOW = "session-roster-row-below-creator"
DELCONFIRM = "session-deleted-confirm"
ROSTERHEADS = "session-roster-heads"
NOFRONTIER = "session-close-no-frontier"
EQPARENT = "session-equivocated-parent"
LOSTSAVE = "session-relayed-header-lost-save"
RELAYED = "session-malformed-header-relayed"
ROWMALFORMED = "session-row-malformed"
NULLSEAT = "session-seat-value-null"
ADOPTED = "merge-seal-adopted"
OUTRANKS = "merge-seal-outranks"
OUTRANKSX = "merge-seal-outranks-cross-entity"
STOWAWAY = "merge-seal-stowaway"
STOWAWAYO = "merge-seal-stowaway-other"
TAMPERED = "merge-seal-tampered"
# The tenth attack review, promoted (5 October).
SEATS10 = [f"session-roster-seats-{shape}" for shape in ("duplicate", "own-value", "bad-length", "text")]
CONFIRMS10 = ["session-confirm-value-not-listed", "session-confirm-own-seat"]
FORGED = "session-forged-session-id"
VERSIONSEATS = "session-creator-row-version-seats"
CLOSEHIGHER = "session-close-then-higher-row"
NEVER = "session-parent-never-arrives"
WITHHELD = "session-header-withheld"
UNSIGNEDCONFIRM = "session-unsigned-confirm"
SIGNSTWICE = "session-creator-signs-twice"
FORWARDER = "session-forwarder-header-only"
HALVES = "session-two-halves"
EXTRASEAT = "session-extra-seat-row-creator"
JOINERSEAT = "session-seat-row-by-joiner"

SORT = "for key in sorted(refusals)\n"

# The Level 1 vectors from main that no hold-out names yet (D193). A full run
# fails on any other vector no hold-out names.
UNNAMED_FROM_MAIN = [
    "heads-via-superseded-flag", "merge-conflict", "merge-idempotent", "merge-resolve", "merge-row-id-reused",
    "merge-tombstone", "merge-tombstone-conflict", "receive-then-write-both-sides", "schema-digest-replicated-only",
]

# name -> (anchor, what the copy does instead, fixtures that must fail, [(old, new), ...])
RULES: dict[str, tuple[str, str, list[str], list[tuple[str, str]]]] = {
    # ------------------------------------------------ witness pass 1: Session admission
    "parent-any-entity": (
        "parent-other-entity", "a parent of another entity counts as a version", [OSEAT],
        [('return [p for p in self.rows[table] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]',
          'return [p for p in self.rows[table] if rid_of(p) in wanted]')],
    ),
    # R10 (2 October) took this rule's place: an equivocated creator's seat row
    # is an equivocator's, so the session is void; the witness is the same.
    "creator-equivocated": (
        "session-void", "a session whose creator is an equivocator is not void: her seat row seats her, and her confirms count", [ECREATOR, "session-creator-equivocates-reconfirm", "session-creator-equivocates-void-undone", "session-creator-equivocates-header-only", SIGNSTWICE, FORWARDER, HALVES],
        [('            if s["_r_deleted"] == 0 and valid[session] and bytes(s["_r_replica"]) not in signed_twice\n', '            if s["_r_deleted"] == 0 and valid[session]\n'),
         ('        self.live = {session: s for session, s in live0.items() if bytes(s["_r_replica"]) not in self.equivocators}', '        self.live = dict(live0)')],
    ),
    "creator-deleted": (
        "creator", "a deleted creator's seat row counts", [CREATOR],
        [('            if s["_r_deleted"] == 0 and valid[session] and', '            if valid[session] and')],
    ),
    "confirm-any-creator": (
        "confirms", "a confirm counts by the creator of any session", [CREATOR],
        [('            if row is None or bytes(f["_r_replica"]) != bytes(row["_r_replica"]):', '            if row is None or bytes(f["_r_replica"]) not in {bytes(c["_r_replica"]) for c in live.values()}:')],
    ),
    "close-deleted-counts": (
        "close-counts", "a close row written deleted counts", [CLOSE],
        [('            if x["_r_deleted"] == 0\n            and bytes(x["_r_session"]) in live0', '            if bytes(x["_r_session"]) in live0')],
    ),
    "close-revoked-by-delete": (
        "close-first", "a delete of a close revokes it: the deleted close counts for nothing, and nothing after it is a row after a close", [CLOSEDEL],
        [("        # A close that counts and a row of its author in that session at a\n",
          "        revoked = {p for y in self.rows.get('_dai_close', []) if y['_r_deleted'] == 1 for p in parents_of(y['_r_parents'])}\n"
          "        self.closes0 = [x for x in self.closes0 if rid_of(x) not in revoked]\n"
          "        # A close that counts and a row of its author in that session at a\n")],
    ),
    "close-member-any-session": (
        "close-counts", "a member of any session may close", [CLOSE],
        [('and (bytes(x["_r_session"]), bytes(x["_r_replica"])) in members0)', 'and bytes(x["_r_replica"]) in {m[1] for m in members0})')],
    ),
    # close-equivocated folded into equivocator-close-counts (R17): a close at an
    # equivocated id is an equivocator's.
    # late-any-session retired with `late` (R18).
    "seat-not-pair": (
        "admitted-seat", "holding a seat's bytes in any session holds it", [EOS],
        [('return seat_value(seat) and (bytes(row["_r_session"]), bytes(seat), bytes(row["_r_replica"])) in self.holders',
          'return seat_value(seat) and any(h[1] == bytes(seat) and h[2] == bytes(row["_r_replica"]) for h in self.holders)')],
    ),
    "admit-other-session": (
        "admitted-no-other-session", "a row naming another session's version of its entity is admitted", [EOS],
        [("return not self.foreign(table, row) and self.unequivocal(row)", "return self.unequivocal(row)")],
    ),
    "admit-other-seat": (
        "admitted-no-other-seat", "a row naming another seat's version is admitted", [OSEAT],
        [("if not self.holds(table, row) or self.other_seat(table, row):", "if not self.holds(table, row):")],
    ),
    # A roster row hides only its own author's rows (heads-roster), so an
    # equivocator's roster row hiding one is out of reach since R10: the row it
    # would hide is hers, and no head already. roster-equivocated-hides retired.
    "roster-equivocated-head": (
        "heads-roster", "a seat row is a head when its own id is not equivocated, whoever wrote it", [SEATV],
        [("                    self.counts(r)\n                    and self.creator_rows.get", "                    self.unequivocal(r)\n                    and self.creator_rows.get")],
    ),
    "equivocator-close-counts": (
        "equivocator", "an equivocator's close counts, at an equivocated id or not", [CLOSESKIP, CLOSEDEL, CLOSEHIGHER],
        [('            if bytes(x["_r_session"]) in self.live and bytes(x["_r_replica"]) not in self.equivocators\n', '            if bytes(x["_r_session"]) in self.live\n')],
    ),
    "plain-equivocated-hides": (
        "heads-plain", "a plain row at an equivocated id hides the row it names", [PLAIN],
        [("                    and counts(c)\n                    and me in parents_of", "                    and (counts(c) if session else True)\n                    and me in parents_of")],
    ),
    "plain-equivocated-head": (
        "heads-plain", "a plain row at an equivocated id is a head", [PLAIN],
        [("                if not counts(r):\n                    continue\n", "                if session and not counts(r):\n                    continue\n")],
    ),
    # ------------------------------------------------ R10, R11: the eighth attack review (2 October)
    "void-session-reported": (
        "report-silent", "a row of a session that is not live is reported as any row is", [TOMB, CREATOR, INVALID[0], *SEATS10, FORGED],
        [('            row["_r_session"] is not None\n            and bytes(row["_r_session"]) in self.live\n', '            row["_r_session"] is not None\n')],
    ),
    # confirm-unminted-counts, minted-last-first and minted-by-value retired
    # with confirm-minted (R14): nothing is minted.
    # ------------------------------------------------ R12, R13 (2 October)
    # seat-by-value, held-row-versions-mint, seat-row-below-mints and
    # confirm-below-counts retired with seat-is-row, held-row-frozen and
    # session-from-creator-row (R14).
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
    # Since R21 a merge that brings a crossing's parent brings the child too or
    # releases it from waiting on that parent, so the parent clause and the
    # release each cover the other: a hold-out removes both, or neither shows.
    "crossing-child-only": (
        "report-crossing", "a crossing reported only when the merge took the child, not when it took the parent or released the child", [EOS],
        [("if rid_of(child) in came or rid_of(parent) in came:", "if rid_of(child) in came:"),
         (" | {rid for t, rid in released if t == table}", "")],
    ),
    "seat-crossing-child-only": (
        "report-crossing", "a version of another seat reported only when the merge took the child, not when it took the parent or released the child", [OSEAT],
        [("if rid_of(child) in came or rid_of(parent) in came:", "if rid_of(child) in came or (reason == 'ENTITY_OTHER_SESSION' and rid_of(parent) in came):"),
         (" | {rid for t, rid in released if t == table}", ""),
         # A released row is SEAT_NOT_HELD through `unseated` too, which counts another seat's version.
         ("for r in admission.rows[t] if (t, rid_of(r)) in released):", "for r in admission.rows[t] if False):")],
    ),
    # seat-any-length retired (A03): every row for a value nobody holds is
    # SEAT_NOT_HELD, so whether a byte string of another length is a seat value
    # changes nothing a fixture shows; seat-text keeps the anchor witnessed.
    "seat-text": (
        "seat-value-shape", "a 16-character text is a seat value, the same as the bytes of its UTF-8", [TEXTSEAT],
        [("    return isinstance(value, (bytes, bytearray)) and len(value) == 16",
          "    return (isinstance(value, (bytes, bytearray)) or isinstance(value, str)) and len(value) == 16"),
         ('            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session]:',
          '            if seat_value(f["seat"]) and (f["seat"].encode() if isinstance(f["seat"], str) else bytes(f["seat"])) in self.open_seats[session]:'),
         ('        return seat_value(seat) and (bytes(row["_r_session"]), bytes(seat), bytes(row["_r_replica"])) in self.holders',
          '        return seat_value(seat) and (bytes(row["_r_session"]), seat.encode() if isinstance(seat, str) else bytes(seat), bytes(row["_r_replica"])) in self.holders')],
    ),
    "dump-real-repr": (
        "dump-real", "a REAL is written as the language's own shortest repr places it (1e-06, 1e+16)", [DUMPREAL],
        [("        return real_text(value)\n",
          "        text = repr(value)\n        return text if ('.' in text or 'e' in text) else text + '.0'\n")],
    ),
    "dump-real-whole-integer": (
        "dump-real", "a whole REAL is written as an integer, without a decimal point", [DUMPREAL],
        [('        text = digits + "0" * (n - k) + ".0"\n', '        text = digits + "0" * (n - k)\n')],
    ),
    "filed-no-id-first": (
        "equivocated-filed", "an author revealed both with a revealing header and without one is filed under no id", [FILEDNONE],
        [('refuse_batch(min((i for i in ids if i), default=""), author,', "refuse_batch(min(ids), author,")],
    ),
    "holder-any": (
        "confirms", "a confirm's holder is whatever it names, an author id or not", [HOLDERSHORT],
        [('            if not seat_value(f["holder"]):\n                continue\n', "")],
    ),
    "other-seat-not-reported": (
        "seat-not-held", "a version of another seat not reported", [OSEAT],
        [("        if not seat_value(seat) or self.other_seat(table, row):\n            return True", "        if not seat_value(seat):\n            return True"),
         ('found.append(("SEAT_NOT_HELD", r, p))', "pass")],
    ),
    "unheld-value-silent": (
        "seat-not-held", "a row for a value nobody holds is reported only when someone else holds it", [UNASKED, OTHERROW, CVERSION, GAP1, "session-seat-beyond-max-parties", CONFIRMS10[0], VERSIONSEATS, EXTRASEAT],
        [('        return (bytes(row["_r_session"]), bytes(seat)) not in self.void_seats',
          '        return any(h[0] == bytes(row["_r_session"]) and h[1] == bytes(seat) for h in self.holders)')],
    ),
    # late-reported retired with `late` (R18).
    # reveal-kinds-apart retired with R10: an author who signs two headers at
    # one id is an equivocator, so every session she created is void and no
    # seat of hers is voided; one merge can no longer reveal her both ways.
    "reveal-held-before": (
        "revealing-two-headers", "a header the copy held before the merge reveals", [BOTH],
        [("        for header in arrived:\n",
          "        for header in local.execute('SELECT id, author, lc, sig, pub, att, version, digest, covers FROM _dai_batch').fetchall():\n")],
    ),
    "void-confirms-only": (
        "revealing-two-confirms", "only confirms reveal a void seat, not the creator's seat row", [SEATROW],
        [('or (table == "_dai_seat" and row["_r_seq"] == creator_row["_r_seq"])', "or False")],
    ),
    # void-equivocated-confirm-reveals retired with R10: a confirm at an
    # equivocated id is an equivocator's, so its session is void, and no seat
    # of a void session is voided for any confirm to reveal.
    "void-filed-highest": (
        "equivocated-filed", "AUTHOR_EQUIVOCATED filed under the highest revealing header", [SEATROW],
        [('refuse_batch(min((i for i in ids if i), default=""), author,', 'refuse_batch(max(ids), author,')],
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
        [("    own = bytes(replica).hex() if isinstance(replica, (bytes, bytearray)) else None\n",
          "    if value != sorted(set(value)):\n        return False\n    own = bytes(replica).hex() if isinstance(replica, (bytes, bytearray)) else None\n")],
    ),
    "parents-own-read": (
        "parents-own-malformed", "a copy's own malformed row's parents are read as they stand, outside a merge", [SHAPE],
        [("    if not well_formed_parents(text, replica, seq):\n        return []\n    try:", "    try:")],
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
        [("                if not counts(r):\n                    continue\n",
          "                if not counts(r) or self.names_equivocated(r):\n                    continue\n")],
    ),
    # ------------------------------------------------ R9: a row at an equivocated id
    # equivocated-unseated-reported, -foreign-reported and -other-seat-reported
    # (R9) folded into equivocator-rows-reported (R17): a row at an equivocated
    # id is an equivocator's.
    "equivocator-rows-reported": (
        "equivocator-holds-nothing", "an equivocator's rows are reported as any author's", [JOINERCLOSE],
        [('            and bytes(row["_r_replica"]) not in self.equivocators\n            and not self.names_equivocated(row)\n',
          '            and self.unequivocal(row)\n            and not self.names_equivocated(row)\n')],
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
        "equivocation-any-table", "one seq signed in two tables under different digests is not equivocation", ["session-equivocation-two-tables", PLAIN, OWNSEAT, SILENT],
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
        "revealing-two-headers", "an incomplete kept header reveals nothing", [HEADERONLY, X3, RELAYED, FORWARDER],
        [("            if new:\n                arrived.append(header)\n", "            if new and verdict == \"ok\":\n                arrived.append(header)\n")],
    ),
    # creator-seat-row-any-seq retired: under R15 the id hashes the roster, so
    # session-id-no-roster holds the same anchor out.
    "session-id-no-roster": (
        "session-id-roster", "the session id hashes the author and the seq alone", [GAP1, CREATOR],
        [("    roster = cbor_head(4, 3) + b\"\".join(parts)  # type: ignore[arg-type]\n", "    roster = b\"\"\n")],
    ),
    "parent-any-table": (
        "parent-other-entity", "a row of another table at the id a parent names is a version of its entity", [OTHERTABLE],
        [('return [p for p in self.rows[table] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]',
          'return [p for t in self.rows for p in self.rows[t] if bytes(p["_r_entity"]) == bytes(row["_r_entity"]) and rid_of(p) in wanted]')],
    ),
    "parent-equivocated-admitted": (
        "admitted-parent-equivocated", "a row naming an equivocated id as a parent is admitted when it otherwise would be", ["session-equivocated-parent-unseated"],
        [("return not self.foreign(table, row) and self.unequivocal(row) and not self.names_equivocated(row)",
          "return not self.foreign(table, row) and self.unequivocal(row)")],
    ),
    "row-batch-always-lowest": (
        "merge-row-batch", "a signed row's _r_batch is the lowest complete kept header listing it, whatever it names", [NAMEDHIGH],
        [('keep = named if named is not None and f"{named}|{key}" in covers else cover', "keep = cover")],
    ),
    "confirm-names-equivocated": (
        "parent-equivocated-outside", "a confirm naming an equivocated id as a parent counts for nothing", [ROSTERNAMES],
        [('            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session]:',
          '            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session] and not self.names_equivocated(f):')],
    ),
    "close-names-equivocated": (
        "parent-equivocated-outside", "a close naming an equivocated id as a parent counts for nothing", [ROSTERNAMES],
        [('            if x["_r_deleted"] == 0\n            and bytes(x["_r_session"]) in live0',
          '            if x["_r_deleted"] == 0 and not self.names_equivocated(x)\n            and bytes(x["_r_session"]) in live0')],
    ),
    # ------------------------------------------------ R21: a row waits on a parent it names (4 October, D189)
    "parent-not-waited": (
        "waiting-on-parent", "a row naming an id the copy holds no row at is decided as if the id named nothing", WAITS + [NEVER],
        [('        return any(parent not in self.held for parent in parents_of(row["_r_parents"], row["_r_replica"], row["_r_seq"]))',
          "        return False")],
    ),
    # ------------------------------------------------ R14 to R20, A03, A09: the ninth attack review (3 October)
    "roster-any-valid": (
        "roster-declared", "a creator's seat row's roster is valid whatever it holds", INVALID + SEATS10,
        [("            valid[session] = (\n", "            valid[session] = True or (\n")],
    ),
    "roster-unbounded": (
        "roster-declared", "a roster may list more seats than max_parties allows", ["session-roster-invalid-too-many"],
        [("                and 1 + len(values) <= max_parties\n", "")],
    ),
    "seat-rows-declare": (
        "creator-row-immutable", "every seat row of the creator's in her session, a version of her creator's seat row included, declares its seat an open one", [GAP1, GAP2, "session-seat-beyond-max-parties"],
        [('            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session]:',
          '            if seat_value(f["seat"]) and (bytes(f["seat"]) in self.open_seats[session] or any(seat_value(o["seat"]) and bytes(o["seat"]) == bytes(f["seat"]) for o in self.rows.get("_dai_seat", []) if bytes(o["_r_session"]) == session and bytes(o["_r_replica"]) == bytes(row["_r_replica"]) and bytes(o["seat"]) != bytes(row["seat"]))):')],
    ),
    "seat-rows-heads": (
        "creator-row-immutable", "every seat row by an author who is no equivocator is a head", [GAP1, GAP2, FORGED, VERSIONSEATS, EXTRASEAT, JOINERSEAT],
        [("                hidden = not (\n                    self.counts(r)\n", "                hidden = not (\n                    self.counts(r) or True\n")],
    ),
    "views-not-compared": (
        "document-mismatch", "a merge takes a sibling whose signed-view digest differs", [MISMATCH],
        [("    if views is not None and views[0] != views[1]:", "    if False:")],
    ),
    "bound-two": (
        "fixtures-manifest", "max_parties is 2, whatever the manifest says", [THREE, THREEQ],
        [('        bound = manifest[mine].get("session", {}).get("max_parties", MAX_PARTIES)', "        bound = MAX_PARTIES")],
    ),
    "equivocator-holds": (
        "equivocator-holds-nothing", "an equivocator keeps the seat he was confirmed in, and his rows count as any author's", [THREEQ, JOINERCLOSE, CLOSESKIP, CLOSEDEL, CLOSEHIGHER],
        [("            if len(holders) > 1 or holders & self.equivocators\n", "            if len(holders) > 1\n")],
    ),
    "close-not-monotone": (
        "close-monotone", "a close followed by a row of its author in that session is no equivocation", [CLOSESKIP, CLOSEDEL, CLOSEHIGHER],
        [("        self.equivocators = signed_twice | {author for _session, author in self.close_equivocated}",
          "        self.equivocators = set(signed_twice)")],
    ),
    "parent-forward-shaped": (
        "parent-forward", "a parent naming the row's own author at a seq at or above its own is the shape", [FORWARD],
        [("        and not (own is not None and isinstance(seq, int) and item[:32] == own and int(item[33:]) >= seq)\n", "")],
    ),
    "void-reads-delete": (
        "session-void", "a session whose creator's seat row this copy holds as a tombstone has a creator to report under", [TOMB],
        [('            and bytes(row["_r_session"]) in self.live\n',
          '            and (bytes(row["_r_session"]) in self.live or (bytes(row["_r_session"]) in self.creator_rows and self.creator_rows[bytes(row["_r_session"])]["_r_deleted"] == 1))\n')],
    ),
    "close-reveals-nothing": (
        "revealing-close", "a close followed by a row reveals nothing", [CLOSESKIP, CLOSEDEL, CLOSEHIGHER],
        [("        for s, author in admission.close_equivocated:\n", "        for s, author in []:\n")],
    ),
    # ------------------------------------------------ The tenth attack review, promoted (5 October).
    "roster-distinct-unchecked": (
        "roster-declared", "a roster may list one value twice", ["session-roster-seats-duplicate"],
        [("                and len(set(values)) == len(values)\n", "")],
    ),
    "roster-own-seat-unchecked": (
        "roster-declared", "a roster may list the creator's own seat", ["session-roster-seats-own-value"],
        [('                and bytes(s["seat"]) not in values\n', "")],
    ),
    "roster-length-unchecked": (
        "roster-declared", "a roster's seats need not be a run of 16-byte values: it is read in 16-byte pieces, the last one short", ["session-roster-seats-bad-length"],
        [("                and len(seats) % 16 == 0\n", "")],
    ),
    "roster-blob-unchecked": (
        "roster-declared", "a roster's seats need not be a byte string: a TEXT of a multiple of 16 characters is a roster of no open seats", ["session-roster-seats-text"],
        [("                and isinstance(seats, (bytes, bytearray))\n", "")],
    ),
    "confirm-any-value": (
        "confirms", "a confirm counts for any seat value, listed by the creator's seat row or not", CONFIRMS10 + [VERSIONSEATS, EXTRASEAT],
        [('            if seat_value(f["seat"]) and bytes(f["seat"]) in self.open_seats[session]:\n', '            if seat_value(f["seat"]):\n')],
    ),
    "creator-row-stored-session": (
        "session-id-creator-row", "a seat row carrying a roster, stored under a session no row hashes to, is that session's creator's seat row", [FORGED],
        [("        # Its roster: the open seats, and whether it is valid (#roster-declared).\n",
          "        for s in self.rows.get(\"_dai_seat\", []):\n"
          "            if s.get(\"seats\") is not None:\n"
          "                self.creator_rows.setdefault(bytes(s[\"_r_session\"]), s)\n"
          "        # Its roster: the open seats, and whether it is valid (#roster-declared).\n")],
    ),
    "creator-row-latest-seats": (
        "creator-row-immutable", "the roster is the seats of the latest version of the creator's seat row", [VERSIONSEATS],
        [('            seats = s.get("seats")\n',
          '            seats = max((o for o in self.rows.get("_dai_seat", []) if bytes(o["_r_entity"]) == bytes(s["_r_entity"]) and bytes(o["_r_session"]) == session and bytes(o["_r_replica"]) == bytes(s["_r_replica"])), key=lambda o: o["_r_seq"]).get("seats")\n')],
    ),
    "held-header-vouches-nothing": (
        "verify-incomplete-kept", "a header the copy holds incomplete takes no row through it, though the sibling brings that row and holds the header complete", [WITHHELD],
        [('            if verdict != "ok":\n                continue\n', '            if verdict != "ok" or own_verdicts.get(hid) == "incomplete":\n                continue\n')],
    ),
    "unsigned-taken": (
        "merge-row-unsigned", "an unsigned row new to the copy is taken, as an unsigned row it holds already is placed", [UNSIGNEDCONFIRM],
        [('                refuse_batch("", row["_r_replica"], "BATCH_UNSIGNED")\n', "                unsigned_rows.append((table, row))\n")],
    ),
    # ------------------------------------------------ Branch review pass A, M3: the branch-new vectors without a hold-out (5 October).
    # merge-cross-entity-parent and merge-seal-outranks-cross-entity rule heads
    # in a plain document, which only _r_superseded showed until both shipped
    # their admitted dumps (`admits`, 5 October); the dump leaves the flag out.
    "plain-parent-any-entity": (
        "parent-other-entity", "in a plain document or a roster table, a row of another entity naming a row as its parent hides it", ["merge-cross-entity-parent", OUTRANKSX],
        [('                    bytes(c["_r_entity"]) == bytes(r["_r_entity"])\n                    and (not session or', "                    (not session or")],
    ),
    "creator-seat-latest": (
        "session-id-creator-row", "the creator's seat is the seat of her latest seat row in her session, not of the one row the id names", [BYSEQ],
        [('        self.holders = {(session, bytes(s["seat"]), bytes(s["_r_replica"])) for session, s in self.live.items()}\n',
          '        self.holders = {(session, bytes(max((o for o in self.rows["_dai_seat"] if bytes(o["_r_session"]) == session and bytes(o["_r_replica"]) == bytes(s["_r_replica"]) and seat_value(o["seat"])), key=lambda o: o["_r_seq"])["seat"]), bytes(s["_r_replica"])) for session, s in self.live.items()}\n')],
    ),
    "confirm-below-creator-uncounted": (
        "confirms", "a confirm at a seq below its creator's seat row counts for nothing", [BELOW],
        [('            if not seat_value(f["holder"]):\n                continue\n',
          '            if not seat_value(f["holder"]) or f["_r_seq"] < row["_r_seq"]:\n                continue\n')],
    ),
    "confirm-deleted-uncounted": (
        "confirm-versions-count", "a deleted confirm counts for nothing", [DELCONFIRM],
        [('            if not seat_value(f["holder"]):\n                continue\n',
          '            if not seat_value(f["holder"]) or f["_r_deleted"] == 1:\n                continue\n')],
    ),
    "roster-heads-no-session": (
        "heads-roster", "roster heads are partitioned by entity and author, not session", [ROSTERHEADS],
        [('and (not session or (bytes(c["_r_session"]) == bytes(r["_r_session"]) and bytes(c["_r_replica"]) == bytes(r["_r_replica"])))',
          'and (not session or bytes(c["_r_replica"]) == bytes(r["_r_replica"]))')],
    ),
    "close-binds-session": (
        "close-monotone", "a close is followed by any author's row in its session at a higher seq, not only its own author's", [NOFRONTIER],
        [('                and bytes(r["_r_replica"]) == bytes(x["_r_replica"])\n                and r["_r_seq"] > x["_r_seq"]\n',
          '                and r["_r_seq"] > x["_r_seq"]\n')],
    ),
    "names-equivocated-reported": (
        "report-silent", "a row naming an equivocated id as a parent is reported as any row is", [EQPARENT],
        [('            and not self.names_equivocated(row)\n            and not self.awaits_parent(row)\n',
          '            and not self.awaits_parent(row)\n')],
    ),
    "adopt-arrived-header": (
        "merge-no-adopt", "a pending row takes the seal of any header the copy holds after the merge, one the sibling sent included, complete or not", [LOSTSAVE],
        [('            if hid not in held_before or own_verdicts.get(hid) != "ok":\n',
          '            if hid in held_before and own_verdicts.get(hid) != "ok":\n')],
    ),
    "malformed-header-kept": (
        "merge-headers-malformed", "a complete header listing a malformed row is kept and its other rows taken", [ROWMALFORMED],
        [('            if verdict == "ok" and any(key in malformed for key in listed):\n', "            if False:\n")],
    ),
    # The four branch vectors the review's count missed (it matched string
    # constants), each named here or below (5 October).
    "two-holders-not-void": (
        "void", "a seat whose counting confirms name two holders is not void: one of them holds it", ["session-second-confirm"],
        [("            if len(holders) > 1 or holders & self.equivocators\n", "            if holders & self.equivocators\n")],
    ),
    "seat-short-silent": (
        "seat-value-shape", "a row whose seat is a byte string of another length is no seated row and is not reported", [SHORTSEAT],
        [("        if not seat_value(seat) or self.other_seat(table, row):\n",
          "        if isinstance(seat, (bytes, bytearray)) and len(seat) != 16:\n            return False\n        if not seat_value(seat) or self.other_seat(table, row):\n")],
    ),
    "seat-null-silent": (
        "seat-value-shape", "a row whose seat is NULL is no seated row and is not reported", [NULLSEAT],
        [("        if not seat_value(seat) or self.other_seat(table, row):\n",
          "        if seat is None:\n            return False\n        if not seat_value(seat) or self.other_seat(table, row):\n")],
    ),
    "duplicate-keeps-pending": (
        "merge-row-held-signed", "a row held pending stays pending when the same row arrives signed by a header the copy receives", [ADOPTED],
        [('            if existing.get("_r_batch") is None and row.get("_r_batch") is not None:\n', "            if False:\n")],
    ),
    "signed-yields-to-unsigned": (
        "merge-signed-outranks", "a signed row is rejected at an id where the copy holds an unsigned row in its table", [OUTRANKS, OUTRANKSX],
        [("            if not signed or there is None or there[0] is not None:\n                raise\n", "            raise\n")],
    ),
    "mismatch-incomplete-silent": (
        "merge-row-digest-mismatch", "a row naming an incomplete kept header that does not vouch for it is not reported", [TAMPERED],
        [('if named not in held or verdicts.get(named) in ("ok", "incomplete"):', 'if named not in held or verdicts.get(named) == "ok":')],
    ),
    "row-signed-by-named": (
        "merge-row-signed", "a row naming a complete kept header is signed by it and taken, listed or not", [STOWAWAY, STOWAWAYO],
        [("            elif named is not None:\n                # It names a header",
          '            elif named is not None and named in held and verdicts.get(named) == "ok":\n'
          '                row["_r_batch"] = held[named]\n'
          "                signed_rows.append((table, row))\n"
          "            elif named is not None:\n                # It names a header")],
    ),
    "mismatch-in-header-author": (
        "merge-row-digest-mismatch", "BATCH_DIGEST_MISMATCH is filed in the name of the header's author, not the row's", [STOWAWAYO],
        [('refuse_batch(named, row["_r_replica"], "BATCH_DIGEST_MISMATCH")',
          'refuse_batch(named, bytes(sibling.execute("SELECT author FROM _dai_batch WHERE lower(hex(id)) = ?", (named,)).fetchone()[0]) if named in held else row["_r_replica"], "BATCH_DIGEST_MISMATCH")')],
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
    "parent-not-waited-rt": (
        "waiting-on-parent", "a row naming an id the copy holds no row at is decided as if the id named nothing (awaitsParent)", WAITS,
        [(r"(function awaitsParent\d*\(row\) \{\s+return )`EXISTS", r'\1"0";\n  `EXISTS')],
    ),
    "parent-equivocated-admitted-rt": (
        "admitted-parent-equivocated", "admitted and waiting rows may name an equivocated id as a parent", ["session-equivocated-parent-unseated"],
        [(r"(\$\{byRole\(row\)\}) AND NOT \$\{namesEquivocated\d*\(row\)\}", r"\1")],
    ),
    "row-batch-always-lowest-rt": (
        "merge-row-batch", "a signed row's _r_batch is the lowest complete kept header listing it, whatever it names", [NAMEDHIGH],
        [(r"const keep = named && covers\.has\(`\$\{named\}\|\$\{key\}`\) \? named : cover;", "const keep = cover;")],
    ),
    "confirm-names-equivocated-rt": (
        "parent-equivocated-outside", "a confirm naming an equivocated id as a parent counts for nothing (_dai_confirmed0)", [ROSTERNAMES],
        [(r"WHERE \(f\._r_session, f\.seat\) IN \(SELECT session, seat FROM roster_value\)\),",
          r'WHERE (f._r_session, f.seat) IN (SELECT session, seat FROM roster_value) AND NOT ${namesEquivocated("f")}),')],
    ),
    "close-names-equivocated-rt": (
        "parent-equivocated-outside", "a close naming an equivocated id as a parent counts for nothing (_dai_close0)", [ROSTERNAMES],
        [(r"(FROM _dai_close x\n\s+JOIN creator0 c ON c\.session = x\._r_session\n\s+WHERE x\._r_deleted = 0)", r'\1 AND NOT ${namesEquivocated("x")}')],
    ),
    "outside-names-equivocated-rt": (
        "parent-equivocated-outside", "a roster, close or plain row naming an equivocated id as a parent is no head", [EPARENT, ROSTERNAMES],
        [(r'WHERE \$\{(counts\d*)\("r"\)\}(\s+AND NOT EXISTS \(SELECT 1 FROM \$\{q\} c,)',
          r'WHERE ${\1("r")} AND NOT ${namesEquivocated("r")}\2')],
    ),
    # ------------------------------------------------ R10, R11: the eighth attack review (2 October)
    "session-not-void-rt": (
        "session-void", "a session whose creator is an equivocator keeps her as its creator (_dai_creator0, _dai_creator)", [ECREATOR, "session-creator-equivocates-reconfirm", "session-creator-equivocates-void-undone", "session-creator-equivocates-header-only"],
        [(r"\n\s+AND r\.replica NOT IN \(SELECT author FROM equivocated\)\),", "),"),
         (r"FROM creator0\n\s+WHERE replica NOT IN \(SELECT author FROM equivocator\)\),", "FROM creator0),")],
    ),
    "void-reported-rt": (
        "report-silent", "a row of a session that is not live is reported as any row is (_unseated, _other_seat, _foreign)", [TOMB],
        [(r"\$\{inLiveSession\d*\(row\)\} AND ", "")],
    ),
    "equivocator-roster-rt": (
        "equivocator", "an equivocator's binding, confirm and close rows count, but at an equivocated id (heads)", [JOINERCLOSE],
        [(r"const (counts\d*) = session \? (notEquivocator\d*) : (unequivocal\d*);", r"const \1 = \3;")],
    ),
    "equivocator-close-rt": (
        "equivocator", "an equivocator's close closes its session (_dai_closed)", [CLOSESKIP, CLOSEDEL],
        [(r"\n\s+AND k\.replica NOT IN \(SELECT author FROM equivocator\)\)", ")")],
    ),
    # confirm-unminted-rt retired with confirm-minted (R14).
    # R12, R13 (2 October).
    # void-by-value-rt and session-before-creator-rt retired with seat-is-row and
    # session-from-creator-row (R14).
    # ------------------------------------------------ R14 to R20, A03, A09 (3 October)
    "roster-valid-rt": (
        "roster-declared", "a roster with too many seats, or a close rule other than any or creator, is valid (_dai_roster_invalid)", ["session-roster-invalid-too-many", "session-roster-invalid-close-rule"],
        [(r"WHERE NOT \(typeof\(r\.seat\) = 'blob'", "WHERE 0 AND NOT (typeof(r.seat) = 'blob'")],
    ),
    "seat-rows-heads-rt": (
        "creator-row-immutable", "every seat row by an author who is no equivocator is a head (_dai_seat_heads)", [GAP1, GAP2],
        [(r"\n\s+AND \(r\._r_replica, r\._r_seq, r\._r_session\) IN \(SELECT replica, seq, session FROM _dai_creator_row\);", ";")],
    ),
    "seat-rows-declare-rt": (
        "creator-row-immutable", "a confirm counts for any seat a seat row of the creator's names (_dai_confirmed0)", [GAP1, GAP2, "session-seat-beyond-max-parties"],
        [(r"WHERE \(f\._r_session, f\.seat\) IN \(SELECT session, seat FROM roster_value\)\),",
          "WHERE ((f._r_session, f.seat) IN (SELECT session, seat FROM roster_value)"
          " OR EXISTS (SELECT 1 FROM _dai_seat o WHERE o._r_session = f._r_session AND o._r_replica = f._r_replica AND o.seat = f.seat AND o.seat <> c.seat))),")],
    ),
    "views-not-compared-rt": (
        "document-mismatch", "a merge takes a sibling whose signed-view digest differs", [MISMATCH],
        [(r"if \(options\.views && options\.views\.local !== options\.views\.sibling\) return", "if (false) return")],
    ),
    "equivocator-holds-rt": (
        "equivocator-holds-nothing", "a seat confirmed to an equivocator is held by him (_dai_voided, _dai_holder)", [THREEQ, CLOSESKIP, CLOSEDEL],
        [(r" OR min\(f\.holder\) IN \(SELECT author FROM equivocator\)\)", ")"),
         (r" AND min\(f\.holder\) NOT IN \(SELECT author FROM equivocator\)\)", ")")],
    ),
    "close-not-monotone-rt": (
        "close-monotone", "a close followed by a row of its author in that session is no equivocation (_dai_close_equivocated)", [CLOSESKIP, CLOSEDEL],
        [(r'WHERE \$\{writesAfter\d*\("k"\)\}\),', "WHERE 0),")],
    ),
    "parent-forward-shaped-rt": (
        "parent-forward", "a parent naming the row's own author at a seq at or above its own is the shape (wellFormedParents)", [FORWARD],
        [(r"!\(own !== null && seq !== void 0 && p\.slice\(0, 32\) === own && Number\(p\.slice\(33\)\) >= Number\(seq\)\)", "true")],
    ),
    "unheld-value-silent-rt": (
        "seat-not-held", "a row for a value nobody holds is reported only when someone else holds it (_unseated)", [UNASKED, OTHERROW, CVERSION],
        [(r"OR \(NOT \(\$\{holds\(\"r\"\)\}\) AND NOT \$\{waiting\(\"r\"\)\}",
          'OR (EXISTS (SELECT 1 FROM _dai_holder h WHERE h.session = r._r_session AND h.seat = r."${seatColumn}") AND NOT (${holds("r")}) AND NOT ${waiting("r")}')],
    ),
    "session-id-no-roster-rt": (
        "session-id-roster", "the session id hashes the author and the seq alone (sessionIdOf)", [GAP1],
        [(r"joined\.set\(roster, BYTES \+ 8\);", "")],
    ),
    # Branch review pass A, H1 (5 October): a roster value is never a store failure.
    "roster-seat-check-rt": (
        "seat-value-shape", "the roster tables' seat carries NOT NULL CHECK (length(seat) = 16), so a signed confirm with a short seat throws inside the merge", [CONFIRMSHORT],
        [(r"\(\n  seat BLOB,\n\$\{extra\}", "(\n  seat BLOB NOT NULL CHECK (length(seat) = 16),\n${extra}")],
    ),
    "roster-holder-check-rt": (
        "confirms", "_dai_confirm's holder carries NOT NULL CHECK (length(holder) = 16), so a signed confirm with a short holder throws inside the merge", [HOLDERSHORT],
        [(r'"  holder BLOB,\\n"', r'"  holder BLOB NOT NULL CHECK (length(holder) = 16),\\n"')],
    ),
    "header-integers-converted-rt": (
        "stored-header-integers", "a stored header's version and lc are read with Number(), so a one-byte blob 02 is version 2 (verifyBatches)", ["merge-header-integers"],
        [(r'const version = storedInteger\d*\(header\["version"\]\);', 'const version = Number(header["version"]);'),
         (r'const lc = storedInteger\d*\(header\["lc"\]\);', 'const lc = Number(header["lc"]);')],
    ),
    "dump-real-unclassed-rt": (
        "dump-real", "the dump writes a value without its storage class, so a whole REAL is written as an integer (dumpRows)", [DUMPREAL],
        [(r"(encodeValue\d*)\(row\[`v\$\{i\}`\], row\[`s\$\{i\}`\]\)", r"\1(row[`v${i}`])")],
    ),
    "filed-no-id-first-rt": (
        "equivocated-filed", "an author revealed both with a revealing header and without one is filed under no id", [FILEDNONE],
        [(r'\[\.\.\.ids\]\.filter\(\((\w+)\) => \1 !== ""\)\.sort\((plainOrder\d*)\)\[0\] \?\? ""', r"[...ids].sort(\2)[0]")],
    ),
    "holder-any-rt": (
        "confirms", "a confirm's holder is whatever it names, an author id or not (_dai_confirmed0)", [HOLDERSHORT],
        [(r"\n\s+AND typeof\(f\.holder\) = 'blob' AND length\(f\.holder\) = 16\n", "\n")],
    ),
    # A10, the seal orders (D178): what a seal records is the runtime's alone.
    "seal-takes-later-rows-rt": (
        # session-seal-hold-two-batch-last no longer witnesses it: with one seat row
        # per session (R14) its batches sign in another order, and the row written
        # during the hold is in the other session.
        "batch-seal", "a seal sets its header on the author's pending rows from the listed seq on, not on the rows it lists", HOLDS[:3],
        [(r"SET _r_batch = \? WHERE _r_replica = \? AND _r_seq = \? AND _r_batch IS NULL`", "SET _r_batch = ? WHERE _r_replica = ? AND _r_seq >= ? AND _r_batch IS NULL`")],
    ),
    # ------------------------------------------------ Branch review pass A, M3: the branch-new vectors without a hold-out (5 October).
    "seal-takes-session-rows-rt": (
        "batch-seal", "a seal sets its header on every pending row of the author's in the session it seals, in any table, not on the rows it lists (recordSeal)", HOLDS,
        [(r"for \(const \{ table, row \} of sealed\.entries\) \{\n",
          r'''\g<0>      if (row._r_session != null) for (const { name: t } of db.all("SELECT name FROM sqlite_schema WHERE type = 'table'")) if (db.all("SELECT 1 FROM pragma_table_info(?) WHERE name = '_r_session'", [t]).length > 0) db.run(`UPDATE "${t}" SET _r_batch = ? WHERE _r_replica = ? AND _r_session = ? AND _r_batch IS NULL`, [sealed.id, row._r_replica, row._r_session]);\n''')],
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
    shutil.copy(REPO / "scripts" / "sealer.mjs", root / "scripts")
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
    # Every vector named by some hold-out: a vector no hold-out names has teeth
    # nobody can rerun (branch review pass A, M3 found 32). Only when every
    # rule ran, since a subset names a subset.
    if set(wanted) == set(RULES) | set(RUNTIME):
        named = {n for table in (RULES, RUNTIME) for _a, _w, must, _e in table.values() for n in must}
        unnamed = [n for n in names if n not in named and n not in UNNAMED_FROM_MAIN]
        print(f"{len(UNNAMED_FROM_MAIN)} vector(s) from main still named by none (D193): {', '.join(UNNAMED_FROM_MAIN)}")
        if unnamed:
            print(f"{len(unnamed)} vector(s) named by no hold-out: {', '.join(unnamed)}")
            return 1
        print(f"Every other one of the {len(names)} vectors is named by a hold-out.")
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
