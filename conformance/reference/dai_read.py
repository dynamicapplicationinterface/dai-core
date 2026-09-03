"""A second reader for the DAI container format, written from the specification.

This exists to test the specification rather than the implementation. Everything
else in this repository shares one reader, so "the format is portable" has until
now rested on the claim that the document describes what the code does. This is
the experiment that can falsify it: a different language, a different author's
reading, no shared code, and the same conformance suite.

Deliberately small and deliberately stdlib-only, including the elliptic curve
arithmetic. A reader that needs a package to be installed proves the format is
portable to environments that have that package.

It is a *reader*: it decides whether a container may run and says why. It does
not run one, save one, or write one.

    python dai_read.py <file>            # report on one container
    python -m run                        # run the conformance suite

Where this file says WAS A GAP, the specification did not say what an implementer
needs, and writing this found it. Each is now in the document — the note stays so
the next person can see what the exercise was worth, and so a rewrite of the
document has a list of what it must not drop again.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import struct
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any

# ---------------------------------------------------------------------------
# The sectioned form (§2)
# ---------------------------------------------------------------------------

MAGIC = b"DAI\x00"
FOOTER_MAGIC = b"\x00IAD"
FORMAT_VERSION = 2
HEADER_BYTES = 12
TOC_ENTRY_BYTES = 56
FOOTER_BYTES = 64
SECTION_MANIFEST, SECTION_PAYLOAD, SECTION_DATA = 1, 2, 3
REQUIRED_SECTIONS = (SECTION_MANIFEST, SECTION_PAYLOAD, SECTION_DATA)

# WAS A GAP: §2 named none of the entries inside the payload archive, and a
# reader cannot find the manifest or the sealed shell without them. Now §2.1.
MANIFEST_ENTRY = "runtime/manifest.json"
CONTAINER_ENTRY = "runtime/container.html"
DATABASE_ENTRY = "document.sqlite"

# WAS A GAP: §1 said the viewer form carried its content "base64-encoded inside
# a <script> tag" and stopped there — no id, no statement that the content is
# the payload archive. Both are needed to read one. Now §1.
PAYLOAD_RE = re.compile(
    r'(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(</script>)', re.IGNORECASE
)
PAYLOAD_PLACEHOLDER = "<!--DAI_PAYLOAD-->"

# WAS A GAP: §4.2 and §7 referred to the policy and the publisher key as being
# carried "in the shell" without saying how either is found. Now §3.
META_RE = '<meta[^>]*name="{}"[^>]*content="([^"]*)"'


class ContainerError(Exception):
    """The file cannot be read far enough to be judged."""


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# CBOR, enough of it for COSE (§3.1)
# ---------------------------------------------------------------------------


def cbor_decode(data: bytes) -> Any:
    value, rest = _cbor_item(data)
    if rest:
        raise ContainerError("Trailing bytes after the end of a CBOR value.")
    return value


def _cbor_item(data: bytes) -> tuple[Any, bytes]:
    if not data:
        raise ContainerError("CBOR value ended early.")
    major, extra = data[0] >> 5, data[0] & 0x1F
    rest = data[1:]

    if extra < 24:
        argument = extra
    elif extra == 24:
        argument, rest = rest[0], rest[1:]
    elif extra == 25:
        argument, rest = struct.unpack(">H", rest[:2])[0], rest[2:]
    elif extra == 26:
        argument, rest = struct.unpack(">I", rest[:4])[0], rest[4:]
    elif extra == 27:
        argument, rest = struct.unpack(">Q", rest[:8])[0], rest[8:]
    else:
        # Indefinite lengths are legal CBOR and never produced here. Accepting
        # them would mean decoding shapes nothing tests.
        raise ContainerError("Unsupported CBOR length encoding.")

    if major == 0:
        return argument, rest
    if major == 1:
        return -1 - argument, rest
    if major == 2:
        return rest[:argument], rest[argument:]
    if major == 3:
        return rest[:argument].decode("utf-8"), rest[argument:]
    if major == 4:
        items = []
        for _ in range(argument):
            item, rest = _cbor_item(rest)
            items.append(item)
        return items, rest
    if major == 5:
        pairs = {}
        for _ in range(argument):
            key, rest = _cbor_item(rest)
            item, rest = _cbor_item(rest)
            pairs[key] = item
        return pairs, rest
    if major == 7:
        if argument == 22:
            return None, rest
        if argument in (20, 21):
            return argument == 21, rest
    raise ContainerError(f"Unsupported CBOR major type {major}.")


def _cbor_head(major: int, argument: int) -> bytes:
    if argument < 24:
        return bytes([major << 5 | argument])
    if argument < 0x100:
        return bytes([major << 5 | 24, argument])
    if argument < 0x10000:
        return bytes([major << 5 | 25]) + struct.pack(">H", argument)
    if argument < 0x100000000:
        return bytes([major << 5 | 26]) + struct.pack(">I", argument)
    return bytes([major << 5 | 27]) + struct.pack(">Q", argument)


def cbor_encode(value: Any) -> bytes:
    """Deterministic encoding, RFC 8949 §4.2.1.

    Shortest-form lengths, and map keys sorted by their *encoded bytes*. Bytewise
    order is not the same as ordering the values: a shorter key sorts first
    whatever its characters, because its length prefix is smaller. Two encoders
    that disagree here produce signatures that do not verify, and the
    disagreement is invisible until somebody else's verifier says no.
    """
    if value is None:
        return b"\xf6"
    if isinstance(value, bool):
        return b"\xf5" if value else b"\xf4"
    if isinstance(value, int):
        if value >= 0:
            return _cbor_head(0, value)
        return _cbor_head(1, -1 - value)
    if isinstance(value, bytes):
        return _cbor_head(2, len(value)) + value
    if isinstance(value, str):
        encoded = value.encode("utf-8")
        return _cbor_head(3, len(encoded)) + encoded
    if isinstance(value, list):
        return _cbor_head(4, len(value)) + b"".join(cbor_encode(item) for item in value)
    if isinstance(value, dict):
        pairs = sorted(
            ((cbor_encode(key), cbor_encode(item)) for key, item in value.items()),
            key=lambda pair: pair[0],
        )
        return _cbor_head(5, len(pairs)) + b"".join(key + item for key, item in pairs)
    raise ContainerError(f"Cannot encode {type(value).__name__} as CBOR.")


# ---------------------------------------------------------------------------
# ECDSA over P-256, by hand (§3.1)
# ---------------------------------------------------------------------------

P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5


def _add(p: tuple[int, int] | None, q: tuple[int, int] | None):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] - 3) * pow(2 * p[1], -1, P) % P
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, P) % P
    x = (lam * lam - p[0] - q[0]) % P
    return (x, (lam * (p[0] - x) - p[1]) % P)


def _multiply(k: int, point: tuple[int, int] | None):
    result = None
    while k:
        if k & 1:
            result = _add(result, point)
        point = _add(point, point)
        k >>= 1
    return result


def verify_es256(public_key_der: bytes, signature: bytes, message: bytes) -> bool:
    """Verify an IEEE P1363 signature against an SPKI key.

    The point sits in the last 65 bytes of a P-256 SPKI structure, uncompressed
    and introduced by 0x04. Parsing the DER properly would be more code and no
    more correct for a key whose shape the format fixes.
    """
    if len(signature) != 64:
        return False
    if len(public_key_der) < 65 or public_key_der[-65] != 0x04:
        return False

    x = int.from_bytes(public_key_der[-64:-32], "big")
    y = int.from_bytes(public_key_der[-32:], "big")
    if (y * y - (x * x * x - 3 * x + B)) % P != 0:
        return False

    r = int.from_bytes(signature[:32], "big")
    s = int.from_bytes(signature[32:], "big")
    if not (0 < r < N and 0 < s < N):
        return False

    z = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, N)
    point = _add(_multiply(z * w % N, (GX, GY)), _multiply(r * w % N, (x, y)))
    return point is not None and point[0] % N == r


# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------


@dataclass
class Report:
    """What a host needs in order to decide, and to say why."""

    mount: bool = False
    ok: bool = False
    shell: str = "absent"
    signature: str = "unsigned"
    expiry: str = "none"
    mismatched: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    unlisted: list[str] = field(default_factory=list)
    sections: dict[str, Any] | None = None
    refused: str = ""


def _read_sectioned(data: bytes) -> tuple[dict[str, bytes], bytes, dict[str, Any]]:
    if len(data) < HEADER_BYTES + FOOTER_BYTES:
        raise ContainerError("Too short to be a container.")

    version, _flags, count = struct.unpack_from("<HHI", data, 4)
    if version != FORMAT_VERSION:
        raise ContainerError(f"Format version {version} is not {FORMAT_VERSION}.")
    if count == 0 or count > 16:
        raise ContainerError(f"A section count of {count} is not credible.")

    sections = {}
    mismatched = []
    for index in range(count):
        at = HEADER_BYTES + index * TOC_ENTRY_BYTES
        identifier = data[at]
        offset, length = struct.unpack_from("<QQ", data, at + 4)
        digest = data[at + 20 : at + 52].hex()
        if offset + length > len(data):
            raise ContainerError(f"Section {identifier} reaches past the end of the file.")
        body = data[offset : offset + length]
        if sha256_hex(body) != digest:
            mismatched.append(identifier)
        sections[identifier] = body

    footer = data[-FOOTER_BYTES:]
    if footer[60:64] != FOOTER_MAGIC:
        raise ContainerError("The footer is missing or damaged.")
    generation = struct.unpack_from("<Q", footer, 0)[0]
    database = sections.get(SECTION_DATA, b"")
    stale = SECTION_DATA in sections and sha256_hex(database) != footer[8:40].hex()

    payload = sections.get(SECTION_PAYLOAD, b"")
    archive = {}
    if payload:
        with zipfile.ZipFile(BytesIO(payload)) as zipped:
            archive = {name: zipped.read(name) for name in zipped.namelist()}

    report = {
        "mismatched": sorted(mismatched),
        "missing": [s for s in REQUIRED_SECTIONS if s not in sections],
        "staleFooter": stale,
        "generation": generation,
    }
    return archive, sections.get(SECTION_MANIFEST, b""), report


def _read_viewer(text: str) -> tuple[dict[str, bytes], str]:
    match = PAYLOAD_RE.search(text)
    if not match:
        raise ContainerError("This document carries no container payload.")

    payload = base64.b64decode(match.group(2))
    with zipfile.ZipFile(BytesIO(payload)) as zipped:
        archive = {name: zipped.read(name) for name in zipped.namelist()}

    # WAS A GAP: §7 said the shell "matches the sealed copy inside the payload"
    # without saying that the live document carries the payload while the sealed
    # copy carries a placeholder. Compared as they stand the two are never
    # equal, so a reader written from the old text refused every valid
    # container. Now §7 step 4.
    stripped = PAYLOAD_RE.sub(
        lambda m: m.group(1) + PAYLOAD_PLACEHOLDER + m.group(3), text, count=1
    )
    return archive, stripped


def verify(data: bytes, now: int) -> Report:
    """Read a container and decide whether a host may run it (§7)."""
    report = Report()
    sectioned = data[:4] == MAGIC

    if sectioned:
        archive, manifest_bytes, sections = _read_sectioned(data)
        report.sections = sections
        shell_text = None
    else:
        archive, shell_text = _read_viewer(data.decode("utf-8", errors="replace"))
        manifest_bytes = archive.get(MANIFEST_ENTRY, b"")

    if not manifest_bytes:
        raise ContainerError("This container has no manifest.")
    manifest = json.loads(manifest_bytes)

    # 3. Entries, both directions. An unlisted entry is as much a failure as a
    #    modified one, or content could simply be appended.
    hashes: dict[str, str] = manifest.get("hashes", {})
    for name, expected in sorted(hashes.items()):
        if name not in archive:
            report.missing.append(name)
        elif sha256_hex(archive[name]) != expected:
            report.mismatched.append(name)
    # WAS A GAP, and the one that mattered. §7 step 3 said an unlisted entry is
    # as much a failure as a modified one and named no exceptions. There are
    # two: the database, which is unsigned and changes on every save, and the
    # manifest, which cannot appear in its own list of digests. This reader
    # refused all ten viewer-form cases on its first run, correctly, by the
    # document as written. Now §7 step 3.
    for name in sorted(archive):
        if name not in hashes and name not in (DATABASE_ENTRY, MANIFEST_ENTRY):
            report.unlisted.append(name)

    # 4. Shell.
    sealed = archive.get(CONTAINER_ENTRY)
    if sealed is None:
        report.shell = "absent"
    elif sectioned:
        # There is no live shell in a binary to compare the sealed one against,
        # and comparing it with itself would always agree. Its entry digest is
        # the honest answer.
        report.shell = "mismatch" if CONTAINER_ENTRY in report.mismatched else "ok"
    else:
        report.shell = "ok" if sealed.decode("utf-8") == shell_text else "mismatch"

    # 5. Expiry.
    valid_until = manifest.get("validUntil")
    if valid_until is not None:
        report.expiry = "expired" if now > valid_until else "current"

    # 6. Signature, over §3.1.
    report.signature = _check_signature(manifest, shell_text, hashes)

    section_failure = bool(
        report.sections
        and (
            report.sections["mismatched"]
            or report.sections["missing"]
            or report.sections["staleFooter"]
        )
    )

    report.ok = (
        not report.mismatched
        and not report.missing
        and not report.unlisted
        and not section_failure
        and report.shell != "mismatch"
        and report.expiry != "expired"
        and report.signature in ("valid", "unsigned")
    )
    report.mount = report.ok
    return report


def _check_signature(manifest: dict, shell_text: str | None, hashes: dict) -> str:
    # WAS A GAP: §7 step 6 said the signature is checked "when the shell carries
    # a publisher key" and never said where, or in what encoding. Now §3.
    key = None
    if shell_text:
        found = re.search(META_RE.format("dai-public-key"), shell_text, re.IGNORECASE)
        key = found.group(1) if found and found.group(1) else None

    signature = manifest.get("signature")
    if not signature:
        return "unsigned"
    if not key:
        # Signed, but nothing here can check it. Not the same as unsigned, and
        # reporting it as such would launder a claim nobody verified.
        return "unverifiable"

    signed_entries: dict[str, str] = manifest.get("signedEntries", {})
    # Reconciled before verifying, per §3.1: otherwise a signature could be
    # validated over digests other than the ones just checked.
    for name, digest in signed_entries.items():
        if hashes.get(name) != digest:
            return "invalid"

    fields: dict[str, Any] = {
        "manifestVersion": manifest["manifestVersion"],
        "documentUuid": manifest["documentUuid"],
        "appName": manifest["appName"],
        # WAS A GAP: the payload's field list did not say what an absent
        # optional field encodes as. It is the empty string, not omission and
        # not null — a verifier that guesses differently rebuilds different
        # bytes and rejects every signature ever made, with nothing to say why.
        # Now §3.1.
        "favicon": manifest.get("favicon", ""),
        "createdAt": manifest["createdAt"],
        "algorithm": manifest["algorithm"],
        "integrityPolicy": manifest["integrityPolicy"],
        "signatureAlgorithm": manifest.get("signatureAlgorithm", ""),
        "publicKeyFingerprint": manifest.get("publicKeyFingerprint", ""),
        "entries": signed_entries,
    }
    if manifest.get("validUntil") is not None:
        fields["validUntil"] = manifest["validUntil"]

    payload = cbor_encode(fields)

    envelope = cbor_decode(base64.b64decode(signature))
    if not isinstance(envelope, list) or len(envelope) != 4:
        return "invalid"
    protected, _unprotected, carried, raw_signature = envelope
    if carried is not None:
        # The payload is detached. A second copy inside the envelope is one that
        # can disagree with the manifest, and it would be the one the signature
        # covered.
        return "invalid"

    header = cbor_decode(protected)
    if header.get(1) != -7:
        return "invalid"

    structure = cbor_encode(["Signature1", protected, b"", payload])
    return "valid" if verify_es256(base64.b64decode(key), raw_signature, structure) else "invalid"


def main(argv: list[str]) -> int:
    import time

    if len(argv) != 2:
        print(__doc__)
        return 2

    with open(argv[1], "rb") as handle:
        data = handle.read()

    try:
        report = verify(data, int(time.time()))
    except (ContainerError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"refused: {error}")
        return 1

    print(f"mount: {'yes' if report.mount else 'no'}")
    print(f"shell: {report.shell}    signature: {report.signature}    expiry: {report.expiry}")
    for label, names in (
        ("modified", report.mismatched),
        ("missing", report.missing),
        ("unlisted", report.unlisted),
    ):
        if names:
            print(f"{label}: {', '.join(names)}")
    if report.sections:
        print(f"sections: {report.sections}")
    return 0 if report.mount else 1


if __name__ == "__main__":
    import sys

    raise SystemExit(main(sys.argv))
