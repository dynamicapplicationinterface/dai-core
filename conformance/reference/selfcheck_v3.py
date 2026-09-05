"""A small check of the version 3 rules (§9) until the suite carries version 3 cases.

Takes a valid signed version 2 case, rewrites its manifest, and reads the result.
The signature was made over version 2 bytes, so it cannot verify here; what this
checks is the version gate (§9.1) and the entry-listing rules (§9.2), which are
decided before any signature is.

    python conformance/reference/selfcheck_v3.py
"""

from __future__ import annotations

import base64
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dai_read import CONTAINER_ENTRY, MANIFEST_ENTRY, PAYLOAD_RE, verify  # noqa: E402

SUITE = Path(__file__).resolve().parents[1]
NOW = 1767225600


def rewrite(text: str, change) -> bytes:
    """The same viewer-form file with its manifest altered by `change`."""
    match = PAYLOAD_RE.search(text)
    with zipfile.ZipFile(BytesIO(base64.b64decode(match.group(2)))) as zipped:
        entries = [(info, zipped.read(info.filename)) for info in zipped.infolist()]
    out = BytesIO()
    with zipfile.ZipFile(out, "w") as zipped:
        for info, body in entries:
            if info.filename == MANIFEST_ENTRY:
                manifest = json.loads(body)
                change(manifest)
                body = json.dumps(manifest).encode("utf-8")
            zipped.writestr(info, body)
    encoded = base64.b64encode(out.getvalue()).decode("ascii")
    return PAYLOAD_RE.sub(lambda m: m.group(1) + encoded + m.group(3), text, count=1).encode("utf-8")


def to_v3(manifest):
    manifest["manifestVersion"] = 3
    manifest["signedEntries"].pop(CONTAINER_ENTRY, None)


def to_v3_shell_listed(manifest):
    manifest["manifestVersion"] = 3  # shell left in signedEntries


def to_v4(manifest):
    manifest["manifestVersion"] = 4


def main() -> int:
    text = (SUITE / "cases/valid-signed.dai.html").read_text(encoding="utf-8")
    checks = [
        ("version-4 is refused by name", to_v4, "UNSUPPORTED_MANIFEST_VERSION", None),
        ("version-3 listing the shell is SIGNED_SET_MISMATCH", to_v3_shell_listed, "SIGNED_SET_MISMATCH", None),
        # Entries pass from signedEntries + the shell from hashes; only the
        # signature, made over version 2 bytes, fails.
        ("version-3 entry list holds, signature over v2 bytes does not", to_v3, "UNVERIFIED_SIGNATURE", True),
    ]
    failures = 0
    for name, change, code, entries_clean in checks:
        report = verify(rewrite(text, change), NOW)
        ok = report.code == code and not report.mount
        if entries_clean:
            ok = ok and not (report.mismatched or report.missing or report.unlisted) and report.shell == "ok"
        failures += not ok
        print(f"{'ok' if ok else 'FAILED':>7}  {name}  (code={report.code!r}, unlisted={report.unlisted})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
