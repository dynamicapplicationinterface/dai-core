"""Runs the conformance suite against the reference reader.

This is what the suite is for: an implementation that shares no code with the
one that wrote the cases, reaching the stated verdict on each. If this passes,
the specification carried enough to build a reader from. Where it did not, the
places are marked SPEC GAP in `dai_read.py`.

    python conformance/reference/run.py

Exits non-zero on the first disagreement, and prints what it expected.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dai_read import ContainerError, verify  # noqa: E402

SUITE = Path(__file__).resolve().parents[1]

# The suite is fixed, so the clock must be too. A case that expires in 2033
# would otherwise start failing in 2033, and the failure would look like a bug
# in whatever reader ran it that day.
NOW = 1767225600  # 2026-01-01T00:00:00Z


def main() -> int:
    manifest = json.loads((SUITE / "cases.json").read_text(encoding="utf-8"))
    failures = []

    for case in manifest["cases"]:
        expected = case["expect"]
        data = (SUITE / case["file"]).read_bytes()

        try:
            report = verify(data, NOW)
            parsed = True
        except (ContainerError, ValueError, KeyError, zipfile.BadZipFile) as error:
            report, parsed = None, False
            detail = str(error)

        if expected.get("parses") is False:
            status = "ok" if not parsed else "FAILED"
            if parsed:
                failures.append((case["name"], "expected this not to parse, and it did"))
            print(f"{status:>7}  {case['name']}")
            continue

        if not parsed:
            failures.append((case["name"], f"could not be read: {detail}"))
            print(f"{'FAILED':>7}  {case['name']}")
            continue

        seen = {
            "mount": report.mount,
            "ok": report.ok,
            "entries": {
                "mismatched": report.mismatched,
                "missing": report.missing,
                "unlisted": report.unlisted,
            },
            "shell": report.shell,
            "signature": report.signature,
            "expiry": report.expiry,
        }
        if report.sections is not None:
            seen["sections"] = {
                "mismatched": report.sections["mismatched"],
                "missing": report.sections["missing"],
                "staleFooter": report.sections["staleFooter"],
            }

        wrong = [
            f"{key}: expected {value!r}, read {seen.get(key)!r}"
            for key, value in expected.items()
            if key != "parses" and seen.get(key) != value
        ]
        if wrong:
            failures.append((case["name"], "; ".join(wrong)))
        print(f"{'ok' if not wrong else 'FAILED':>7}  {case['name']}")

    print()
    if failures:
        for name, detail in failures:
            print(f"  {name}: {detail}")
        print(f"\n{len(failures)} of {len(manifest['cases'])} cases disagree.")
        return 1

    print(f"{len(manifest['cases'])} cases, all as specified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
