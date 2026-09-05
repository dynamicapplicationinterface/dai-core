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
import zlib
from pathlib import Path
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

# §9.1: the versions a reader accepts. Anything else is refused by name, before
# step 1, because the file is not damaged and the person can update the host.
SUPPORTED_MANIFEST_VERSIONS = (2, 3)

# §9.4: a writer emits an untagged COSE_Sign1; a reader accepts tag 18 around
# it as well, because standard COSE libraries emit one.
COSE_SIGN1_TAG = 18
COUNTERSIGNATURE_LABEL = 11

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


@dataclass(frozen=True)
class Tagged:
    """A CBOR tag (major type 6) around a value. Only the envelope uses one (§9.4)."""

    tag: int
    value: Any


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
    if major == 6:
        item, rest = _cbor_item(rest)
        return Tagged(argument, item), rest
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
    # The registry name (spec §7.2) for a refusal; empty when the container
    # may be mounted.
    code: str = ""


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


INLINE_RE = re.compile(r"[#&]a=([A-Za-z0-9_-]+)")
CARRIER_VERSION = 1
DICTIONARY_PATH = Path(__file__).resolve().parents[1] / "inline-dictionary.bin"

# P-256, for recovering a key sent as a compressed point (SEC 1 §2.3.3).
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_SPKI_PREFIX = bytes.fromhex("3059301306072a8648ce3d020106082a8648ce3d030107034200")

SHELL_ENTRY = "runtime/container.html"
KIT_ENTRY = "app/dai-kit.js"
ENGINE_ENTRIES = ("runtime/sqlite3.wasm", "runtime/sqlite3.mjs")
MAY_BE_ELIDED = (SHELL_ENTRY, KIT_ENTRY) + ENGINE_ENTRIES


def decompress_point(point: bytes) -> bytes:
    """A 33-byte compressed P-256 point to the 91-byte SubjectPublicKeyInfo.

    y² = x³ − 3x + b, and the prime is 3 mod 4, so y = (y²)^((p+1)/4). The tag
    byte picks which of the two roots.
    """
    if len(point) != 33 or point[0] not in (2, 3):
        raise ContainerError("This link carries a publisher key that is not a P-256 point.")
    x = int.from_bytes(point[1:], "big")
    if x >= _P:
        raise ContainerError("This link carries a publisher key that is not a P-256 point.")
    rhs = (pow(x, 3, _P) - 3 * x + _B) % _P
    y = pow(rhs, (_P + 1) // 4, _P)
    if (y * y) % _P != rhs:
        raise ContainerError("This link carries a publisher key that is not on the curve.")
    if (y & 1) != (point[0] == 3):
        y = _P - y
    return _SPKI_PREFIX + b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")


@dataclass
class InlineDocument:
    """What a link carries, before any host has rebuilt what it left out."""

    manifest: dict[str, Any]
    carried: dict[str, bytes]
    elided: dict[str, str]
    public_key: str | None


def from_inline_link(link: str) -> InlineDocument:
    """Take a document out of an inline link (§1.1).

    A carrier, not a form: the reader recomputes every carried entry's digest,
    takes every elided one's from the link, and rebuilds the manifest and the
    signature envelope — so nothing the link says about its bytes is believed,
    and the signature is checked over what actually arrived.

    Written from the specification like the rest of this file. It needed one
    thing the document did not have at first: the CBOR map's key table, which
    is now in §1.1.
    """
    found = INLINE_RE.search(link)
    if not found:
        raise ContainerError("This link carries no document.")
    value = found.group(1)
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except Exception as broken:
        raise ContainerError("This link is damaged.") from broken
    if len(raw) < 6:
        raise ContainerError("LINK_DAMAGED: This link is too short to carry a document.")
    if raw[0] != CARRIER_VERSION:
        raise ContainerError(f"LINK_UNSUPPORTED: carrier version {raw[0]}.")

    dictionary = DICTIONARY_PATH.read_bytes()
    if raw[1:5] != hashlib.sha256(dictionary).digest()[:4]:
        raise ContainerError("LINK_UNSUPPORTED: this link names a dictionary this reader does not hold.")

    try:
        inflater = zlib.decompressobj(-15, zdict=dictionary)
        inflated = inflater.decompress(raw[5:]) + inflater.flush()
        fields = cbor_decode(inflated)
    except Exception as broken:
        # Refused rather than acted on in part: a link that carries a document
        # can arrive half-present, because chat clients linkify up to a length
        # and mail wraps long lines.
        raise ContainerError(
            "LINK_DAMAGED: This link is damaged. It was probably shortened or wrapped on the way here."
        ) from broken

    if not isinstance(fields, dict) or not isinstance(fields.get(9), list):
        raise ContainerError("LINK_DAMAGED: This link does not describe a document.")

    uuid_bytes = fields.get(1)
    if not isinstance(uuid_bytes, bytes) or len(uuid_bytes) != 16:
        raise ContainerError("LINK_DAMAGED: This link does not describe a document.")
    h = uuid_bytes.hex()
    uuid = f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"

    public_key = None
    fingerprint = ""
    point = fields.get(7)
    if isinstance(point, bytes):
        spki = decompress_point(point)
        public_key = base64.b64encode(spki).decode("ascii")
        fingerprint = hashlib.sha256(spki).hexdigest()[:16]

    carried: dict[str, bytes] = {}
    elided: dict[str, str] = {}
    hashes: dict[str, str] = {}
    for entry in fields[9]:
        if not (isinstance(entry, list) and len(entry) == 3 and isinstance(entry[0], str) and isinstance(entry[2], bytes)):
            raise ContainerError("LINK_DAMAGED: This link does not describe a document.")
        name, flag, payload = entry
        if flag == 0:
            carried[name] = payload
            hashes[name] = sha256_hex(payload)
        elif flag == 1 and len(payload) == 32 and name in MAY_BE_ELIDED:
            elided[name] = payload.hex()
            hashes[name] = payload.hex()
        else:
            raise ContainerError(f"LINK_DAMAGED: This link leaves out {name}, which a link may not leave out.")

    # Label 12: `manifestVersion`, absent means 2 (§1.1). A version this reader
    # does not know is refused by name (§9.1), as it is for a file.
    version = fields.get(12, 2)
    if version not in SUPPORTED_MANIFEST_VERSIONS:
        raise ContainerError(f"UNSUPPORTED_MANIFEST_VERSION: manifestVersion {version!r}.")

    manifest: dict[str, Any] = {
        "manifestVersion": version,
        "documentUuid": uuid,
        "appName": fields.get(2, ""),
        "favicon": fields.get(3, ""),
        "createdAt": fields.get(4, ""),
        "algorithm": "SHA-256",
        "integrityPolicy": "required" if fields.get(5) == 1 else "advisory",
        "hashes": hashes,
    }
    if isinstance(fields.get(6), int):
        manifest["validUntil"] = fields[6]
    if isinstance(fields.get(10), str) and fields[10]:
        manifest["publisherName"] = fields[10]
    if isinstance(fields.get(11), bytes) and len(fields[11]) == 16:
        g = fields[11].hex()
        manifest["supersedes"] = f"{g[:8]}-{g[8:12]}-{g[12:16]}-{g[16:20]}-{g[20:]}"
    # Label 13: `generator` as `[tool, model, provider]`, empty strings for
    # absent (§1.1). The manifest's object carries only the keys that are set,
    # which is what §9.3 signs.
    #
    # SPEC GAP: §1.1 does not say what a reader does with a label 13 array of
    # the wrong length, or one whose entries are not strings, or one whose
    # three strings are all empty (§9.3 makes `tool` the one required key).
    # This reader treats the first two as LINK_DAMAGED and the third as no
    # `generator` at all. The document should say which.
    generator = fields.get(13)
    if generator is not None:
        if not (isinstance(generator, list) and len(generator) == 3 and all(isinstance(s, str) for s in generator)):
            raise ContainerError("LINK_DAMAGED: This link does not describe a document.")
        named = {k: v for k, v in zip(("tool", "model", "provider"), generator) if v}
        if named:
            manifest["generator"] = named
    raw_signature = fields.get(8)
    if public_key and isinstance(raw_signature, bytes):
        protected = cbor_encode({1: -7, 4: fingerprint.encode("ascii")})
        envelope = cbor_encode([protected, {}, None, raw_signature])
        manifest["signatureAlgorithm"] = "COSE-ES256"
        manifest["publicKeyFingerprint"] = fingerprint
        # The signed set by the version's rules (§1.1 label 12): never the
        # database; for version 3, not the sealed shell either (§9.2). The
        # shell's digest stays in `hashes`, where a host holds its rebuilt
        # shell to it.
        outside = {DATABASE_ENTRY} | ({SHELL_ENTRY} if version == 3 else set())
        manifest["signedEntries"] = {n: d for n, d in hashes.items() if n not in outside}
        manifest["signature"] = base64.b64encode(envelope).decode("ascii")

    return InlineDocument(manifest, carried, elided, public_key)


def verify_link(link: str, now: int) -> Report:
    """Decide what a reader can about a document carried in a link.

    Everything that is the document's is checked here: the carried bytes
    against digests that were recomputed from them, and the signature over the
    whole signed view including the elided digests. What cannot be checked
    here is what a host rebuilds — the shell, the kit, the engine — because
    this reader holds none of them; `report.shell` says `elided` and a host
    that runs it must rebuild each and match the digest first.
    """
    document = from_inline_link(link)
    report = Report()
    report.shell = "elided" if SHELL_ENTRY in document.elided else "absent"

    manifest = document.manifest
    signature, code = _check_signature(manifest, document.public_key, manifest["hashes"])
    report.signature = signature

    valid_until = manifest.get("validUntil")
    if isinstance(valid_until, int):
        report.expiry = "expired" if now > valid_until else "current"

    report.ok = report.shell == "elided" and report.expiry != "expired" and signature in ("valid", "unsigned")
    report.mount = False  # never from here: a host has to rebuild what was left out
    if not report.ok:
        report.code = "SHELL_MISSING" if report.shell != "elided" else ("KEY_EXPIRED" if report.expiry == "expired" else code or "UNVERIFIED_SIGNATURE")
    return report


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

    # §9.1. A version this reader does not know is refused before step 1. It is
    # routed through the Report rather than raised: run.py compares
    # `report.code` with the suite's stated name, and a ContainerError there
    # reads as "could not be read", which is the generic failure §9.1 says this
    # must not be. The file is not damaged; the host is behind.
    version = manifest.get("manifestVersion")
    if version not in SUPPORTED_MANIFEST_VERSIONS:
        report.code = "UNSUPPORTED_MANIFEST_VERSION"
        return report

    # 3. Entries, both directions. An unlisted entry is as much a failure as a
    #    modified one, or content could simply be appended.
    hashes: dict[str, str] = manifest.get("hashes", {})
    listed, exempt = _entry_list(manifest)
    for name, expected in sorted(listed.items()):
        if name not in archive:
            report.missing.append(name)
        elif sha256_hex(archive[name]) != expected:
            report.mismatched.append(name)
    # WAS A GAP, and the one that mattered. §7 step 3 said an unlisted entry is
    # as much a failure as a modified one and named no exceptions. There are
    # two: the database, which is unsigned and changes on every save, and the
    # manifest, which cannot appear in its own list of digests. This reader
    # refused all ten viewer-form cases on its first run, correctly, by the
    # document as written. Now §7 step 3. Version 3 adds the shell (§9.2).
    for name in sorted(archive):
        if name not in listed and name not in exempt:
            report.unlisted.append(name)

    # 4. Shell.
    sealed = archive.get(CONTAINER_ENTRY)
    if sealed is None:
        report.shell = "absent"
    elif sectioned:
        # There is no live shell in a binary to compare the sealed one against,
        # and comparing it with itself would always agree. Its entry digest is
        # the honest answer.
        #
        # SPEC GAP: §9.2 says the sealed shell "stays in the archive and in
        # `hashes`" for version 3, but with no MUST, and says nothing about a
        # version 3 sectioned container whose `hashes` omits the shell. There
        # is then no digest to hold it to. This reader reports it "ok" on the
        # grounds that `hashes` and the section table are both unsigned, so
        # the section digest already gives the shell everything `hashes`
        # would; the document should say whether that is the intended answer
        # or whether such a manifest is to be refused.
        report.shell = "mismatch" if CONTAINER_ENTRY in report.mismatched else "ok"
    else:
        report.shell = "ok" if sealed.decode("utf-8") == shell_text else "mismatch"

    # 5. Expiry.
    valid_until = manifest.get("validUntil")
    if valid_until is not None:
        report.expiry = "expired" if now > valid_until else "current"

    # 6. Signature, over §3.1.
    report.signature, signature_code = _check_signature(manifest, _key_from_shell(shell_text), hashes)

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

    # The name for the refusal, in the same priority the reference reader
    # uses, so both say the same word about the same file.
    if not report.ok:
        sections = report.sections or {"mismatched": [], "missing": [], "staleFooter": False}
        damaged = sections["mismatched"]
        only_data = all(sid == 3 for sid in damaged) and (damaged or sections["staleFooter"])
        if only_data:
            report.code = "DATA_DAMAGED"
        elif damaged:
            report.code = "SECTION_MISMATCH"
        elif sections["missing"]:
            report.code = "SECTION_MISSING"
        elif report.mismatched or report.missing or report.unlisted:
            report.code = "DIGEST_MISMATCH"
        elif report.shell == "absent":
            report.code = "SHELL_MISSING"
        elif report.shell == "mismatch":
            report.code = "SHELL_MISMATCH"
        elif report.expiry == "expired":
            report.code = "KEY_EXPIRED"
        else:
            report.code = signature_code or "UNVERIFIED_SIGNATURE"
    return report


def _entry_list(manifest: dict) -> tuple[dict[str, str], tuple[str, ...]]:
    """The entries step 3 holds the archive to, and the names exempt from the
    unlisted check.

    Version 2, and an unsigned version 3: `hashes` is the list (§7 step 3).
    A signed version 3: `signedEntries` is the sole authority (§9.2), with the
    database and the sealed shell taken from `hashes` because neither is
    signed — the database changes on every save, and the shell is a self-
    attesting part whose digest a host with its own shell cannot reproduce.
    """
    hashes: dict[str, str] = manifest.get("hashes", {})
    if manifest.get("manifestVersion") != 3 or not manifest.get("signature"):
        return dict(hashes), (DATABASE_ENTRY, MANIFEST_ENTRY)

    listed = dict(manifest.get("signedEntries", {}))
    for name in (DATABASE_ENTRY, CONTAINER_ENTRY):
        if name in hashes:
            listed[name] = hashes[name]
    # SPEC GAP: §9.2 makes `signedEntries` the authority and says `hashes` MAY
    # be present, but does not say what a reader does with a `hashes` entry
    # that `signedEntries` does not list and the archive does not carry. Where
    # the archive carries it, §9.2's unlisted rule refuses it. Where it does
    # not, this reader ignores it: `hashes` is untrusted, and an untrusted list
    # naming bytes that are not there is noise rather than damage. The
    # document should say so, or say it is a refusal.
    return listed, (DATABASE_ENTRY, MANIFEST_ENTRY, CONTAINER_ENTRY)


def _key_from_shell(shell_text: str | None) -> str | None:
    # WAS A GAP: §7 step 6 said the signature is checked "when the shell carries
    # a publisher key" and never said where, or in what encoding. Now §3.
    if not shell_text:
        return None
    found = re.search(META_RE.format("dai-public-key"), shell_text, re.IGNORECASE)
    return found.group(1) if found and found.group(1) else None


def _signed_payload(manifest: dict) -> bytes:
    """The detached payload of §3.1 (and §9.3 for version 3), rebuilt from the
    manifest. One code path: the publisher's Sig_structure and every
    countersigner's Countersign_structure (§9.4) carry these same bytes."""
    version = manifest.get("manifestVersion")
    signed_entries: dict[str, str] = manifest.get("signedEntries", {})
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
    # Present only when the publisher signed under a name (§3.1), so every
    # container signed before names existed still verifies unchanged.
    if manifest.get("publisherName"):
        fields["publisherName"] = manifest["publisherName"]
    if manifest.get("supersedes"):
        fields["supersedes"] = manifest["supersedes"]
    # §9.3: `generator` joins the signed set in version 3, after `supersedes`,
    # as a map of tool/model/provider with each key present only when set.
    # Absent from the manifest means absent from the bytes — never null, never
    # the empty string. (The map's keys are ordered by cbor_encode, which sorts
    # deterministically; the order §9.3 lists is the order of the field
    # list, which a sorted map does not depend on.)
    #
    # SPEC GAP: §9.3 is the version 3 section, and §3.1's version 2 field list
    # does not include `generator`. This reader therefore signs it only for
    # version 3; a version 2 manifest carrying one has it outside the signed
    # set. §9.3 also does not say whether keys beyond tool/model/provider are
    # signed; this reader drops them, since the bytes are defined as those
    # three. The document should state both.
    generator = manifest.get("generator")
    if version == 3 and isinstance(generator, dict):
        signed_generator = {
            k: generator[k] for k in ("tool", "model", "provider") if generator.get(k)
        }
        fields["generator"] = signed_generator

    return cbor_encode(fields)


def _parse_envelope(signature_b64: str):
    """The four parts of the COSE_Sign1 envelope, or a refusal code, or None.

    §9.4: tag 18 around the envelope is the same envelope. Any other tag is a
    signature format this reader does not implement.
    """
    try:
        envelope = cbor_decode(base64.b64decode(signature_b64))
    except (ContainerError, ValueError):
        return None
    if isinstance(envelope, Tagged):
        if envelope.tag != COSE_SIGN1_TAG:
            return "SIGNATURE_UNSUPPORTED"
        envelope = envelope.value
    if not isinstance(envelope, list) or len(envelope) != 4:
        return None
    protected, unprotected, carried, raw_signature = envelope
    if not isinstance(protected, bytes) or not isinstance(unprotected, dict) or not isinstance(raw_signature, bytes):
        return None
    return protected, unprotected, carried, raw_signature


def countersignatures(manifest: dict, key_b64: str | None, held_keys: dict[bytes, str]) -> list[dict[str, str]]:
    """Report on the countersignatures in the manifest's envelope (§9.4).

    `held_keys` maps a kid (bytes) to a base64 SPKI the host already holds (a
    root list's `countersigners`, §9.6). Each countersignature is verified over
    RFC 9338 §3.3's version 2 structure:

        ["CounterSignatureV2", body_protected, sign_protected, h'',
         payload, [publisher signature]]

    Returns one {"kid", "status"} per countersignature: "valid", "invalid", or
    "unheld" when no key is held for the kid — §9.4: treated as absent, never
    verified, never a refusal. Nothing here changes verify()'s verdict.

    SPEC GAP: §9.4 does not say whether a countersignature is reported when
    the publisher's own signature does not verify (or cannot be, with no key
    in the shell). The Countersign_structure covers the publisher's signature
    bytes, so a countersignature can be cryptographically valid over an
    invalid publisher signature. This reader verifies them independently and
    takes `key_b64` only so a caller can pass what it has; a host that wants
    to show a countersignature only under a valid publisher signature gates
    on verify() first. The document should say which.

    SPEC GAP: §9.4 does not say what a reader does with a label 11 value that
    is neither a 3-element array nor an array of them, nor with a kid that is
    not a byte string. This reader reports each such entry "invalid" with an
    empty kid, and a malformed slot as a whole as one "invalid" entry, so the
    person sees that something claimed to countersign and did not.
    """
    del key_b64  # see the first SPEC GAP above
    signature = manifest.get("signature")
    if not signature:
        return []
    parsed = _parse_envelope(signature)
    if parsed is None or isinstance(parsed, str):
        return []
    body_protected, unprotected, _carried, publisher_signature = parsed

    slot = unprotected.get(COUNTERSIGNATURE_LABEL)
    if slot is None:
        return []
    # One COSE_Countersignature is [bstr, map, bstr]; an array of them is a
    # list whose first element is itself a list. RFC 9338 leaves the two
    # distinguishable by shape, and so does §9.4.
    if isinstance(slot, list) and len(slot) == 3 and isinstance(slot[0], bytes):
        entries = [slot]
    elif isinstance(slot, list):
        entries = slot
    else:
        return [{"kid": "", "status": "invalid"}]

    try:
        payload = _signed_payload(manifest)
    except (KeyError, ContainerError):
        # A manifest so broken it has no signed bytes has nothing to
        # countersign; verify() has already refused it on its own grounds.
        return [{"kid": "", "status": "invalid"} for _ in entries]

    results = []
    for entry in entries:
        if not (isinstance(entry, list) and len(entry) == 3 and isinstance(entry[0], bytes)
                and isinstance(entry[1], dict) and isinstance(entry[2], bytes)):
            results.append({"kid": "", "status": "invalid"})
            continue
        sign_protected, _sign_unprotected, counter_signature = entry
        try:
            header = cbor_decode(sign_protected)
        except ContainerError:
            header = None
        kid = header.get(4) if isinstance(header, dict) else None
        kid_hex = kid.hex() if isinstance(kid, bytes) else ""
        # §9.4: the countersigner's protected header MUST carry alg and kid.
        # Either missing, and this is not a countersignature this version
        # defines. ES256 is the only algorithm it requires.
        if not isinstance(header, dict) or header.get(1) != -7 or not isinstance(kid, bytes):
            results.append({"kid": kid_hex, "status": "invalid"})
            continue
        held = held_keys.get(kid)
        if held is None:
            results.append({"kid": kid_hex, "status": "unheld"})
            continue
        structure = cbor_encode([
            "CounterSignatureV2",
            body_protected,
            sign_protected,
            b"",
            payload,
            [publisher_signature],
        ])
        try:
            good = verify_es256(base64.b64decode(held), counter_signature, structure)
        except ValueError:
            good = False
        results.append({"kid": kid_hex, "status": "valid" if good else "invalid"})
    return results


def _check_signature(manifest: dict, key: str | None, hashes: dict) -> tuple[str, str]:
    """Verify the manifest's signature with a base64 SPKI key, or say why not."""
    signature = manifest.get("signature")
    if not signature:
        return "unsigned", ""

    version = manifest.get("manifestVersion")
    signed_entries: dict[str, str] = manifest.get("signedEntries", {})

    if version == 3:
        # §9.2, both mandatory changes. Checked before the key, because they are
        # facts about the manifest that hold whether or not anyone can verify
        # the signature: a version 3 signed set that lists the shell is wrong
        # in itself.
        if CONTAINER_ENTRY in signed_entries:
            return "invalid", "SIGNED_SET_MISMATCH"
        # `hashes` MAY be present and MAY omit signed entries; where both list
        # an entry they MUST agree.
        for name, digest in signed_entries.items():
            if name in hashes and hashes[name] != digest:
                return "invalid", "SIGNED_SET_MISMATCH"

    if not key:
        # Signed, but nothing here can check it. Not the same as unsigned, and
        # reporting it as such would launder a claim nobody verified.
        return "unverifiable", "SIGNATURE_UNVERIFIABLE"

    if version != 3:
        # Version 2, unchanged. Reconciled before verifying, per §3.1: otherwise
        # a signature could be validated over digests other than the ones just
        # checked.
        for name, digest in signed_entries.items():
            if hashes.get(name) != digest:
                return "invalid", "SIGNED_SET_MISMATCH"
        # WAS A GAP, and a serious one. The rule above is one direction. `hashes`
        # is outside the signature, so an entry added to the archive and to
        # `hashes` with a matching digest passed integrity and passed signature
        # without touching the signed set — and runtime/schema.json, added that
        # way, has its migration SQL executed by a host under the pinned
        # publisher's badge. Every digested entry except the database must be in
        # the signed set. Now S3.1, and restated as a version 2 rule in §9.1.
        for name in hashes:
            if name != DATABASE_ENTRY and name not in signed_entries:
                return "invalid", "SIGNED_SET_MISMATCH"

    payload = _signed_payload(manifest)

    parsed = _parse_envelope(signature)
    if parsed is None:
        return "invalid", "UNVERIFIED_SIGNATURE"
    if isinstance(parsed, str):
        return "invalid", parsed
    protected, unprotected, carried, raw_signature = parsed
    # §9.4: the unprotected header MAY carry label 11, a countersignature or an
    # array of them. Never verified here: one this reader cannot verify is
    # treated as absent, never as a refusal, so its presence changes no
    # verdict. `countersignatures()` reports on them separately.
    if carried is not None:
        # The payload is detached. A second copy inside the envelope is one that
        # can disagree with the manifest, and it would be the one the signature
        # covered.
        return "invalid", "UNVERIFIED_SIGNATURE"

    header = cbor_decode(protected)
    if header.get(1) != -7:
        return "invalid", "UNVERIFIED_SIGNATURE"

    structure = cbor_encode(["Signature1", protected, b"", payload])
    if verify_es256(base64.b64decode(key), raw_signature, structure):
        return "valid", ""
    return "invalid", "UNVERIFIED_SIGNATURE"


# ---------------------------------------------------------------------------
# What a host remembers (§9.6)
# ---------------------------------------------------------------------------

import unicodedata


def load_confusables(path) -> dict[str, str]:
    """The UTS #39 prototype table as `confusables.json` carries it:
    {"unicode": "...", "map": {"<char>": "<prototype string>"}}."""
    return json.loads(Path(path).read_text(encoding="utf-8"))["map"]


def skeleton(name: str, table: dict[str, str]) -> str:
    """§9.6 rule 2: NFKC → case fold → drop Z* and P* → UTS #39 §4 skeleton.

    The UTS #39 skeleton is NFD, then each character replaced by its prototype
    (a character the table does not list maps to itself), then NFD again.
    """
    folded = unicodedata.normalize("NFKC", name).casefold()
    kept = "".join(ch for ch in folded if unicodedata.category(ch)[0] not in ("Z", "P"))
    decomposed = unicodedata.normalize("NFD", kept)
    replaced = "".join(table.get(ch, ch) for ch in decomposed)
    return unicodedata.normalize("NFD", replaced)


# Script names by unicodedata.name() prefix. Han, Hiragana and Katakana are one
# writing system: a Japanese name spells one word with all three.
_SCRIPT_PREFIXES = (
    ("LATIN", "latin"),
    ("CYRILLIC", "cyrillic"),
    ("GREEK", "greek"),
    ("ARMENIAN", "armenian"),
    ("HEBREW", "hebrew"),
    ("ARABIC", "arabic"),
    ("CJK", "cjk"),
    ("HAN", "cjk"),
    ("HIRAGANA", "cjk"),
    ("KATAKANA", "cjk"),
    ("HANGUL", "hangul"),
    ("THAI", "thai"),
    ("DEVANAGARI", "devanagari"),
)


def _script(ch: str) -> str | None:
    """The script of a letter, or None for a non-letter or a script §9.6 does
    not name.

    SPEC GAP: §9.6 says "letters from more than one script" and gives neither
    a letter test nor a script list. This reader takes "letter" as Unicode
    category L*, reads the script off the character name's first word, and
    counts only the scripts listed above; a letter of any other script never
    contributes, so it can neither cause nor prevent a conflict. Han with
    Hiragana and Katakana is one script here. The document should say all of
    this.
    """
    if not unicodedata.category(ch).startswith("L"):
        return None
    label = unicodedata.name(ch, "")
    for prefix, script in _SCRIPT_PREFIXES:
        if label.startswith(prefix + " ") or label.startswith(prefix + "-"):
            return script
    return None


def mixed_script(name: str) -> bool:
    """§9.6 rule 1: after NFKC and case fold, any whitespace-separated token
    whose letters come from more than one script."""
    folded = unicodedata.normalize("NFKC", name).casefold()
    for token in folded.split():
        scripts = {s for s in (_script(ch) for ch in token) if s}
        if len(scripts) > 1:
            return True
    return False


class KeyStore:
    """§9.6's two stores, in memory. `keys` is SPKI (base64) → record;
    `documents` is documentUuid → SPKI (or "unsigned")."""

    def __init__(self, roots: list[dict] | None = None):
        self.keys: dict[str, dict[str, Any]] = {}
        self.documents: dict[str, str] = {}
        # A root list entry's `name` is a host label for that key (§9.6).
        for entry in roots or []:
            self.keys[entry["spki"]] = {
                "name": "",
                "hostLabel": entry.get("name", ""),
                "skeletons": [],
                "documents": [],
                "root": True,
            }


def _held_names(store: KeyStore, table: dict[str, str]):
    """Every (name, skeleton) the host holds: asserted names and host labels."""
    for entry in store.keys.values():
        for name in (entry.get("name"), entry.get("hostLabel")):
            if name:
                yield name, skeleton(name, table)


def trust_state(store: KeyStore, manifest: dict, key_b64: str | None, table: dict[str, str]) -> dict[str, Any]:
    """The state a host reaches on opening this document (§9.6)."""
    if not manifest.get("signature") or not key_b64:
        return {"state": "unsigned"}

    # §9.6 conflict rule "document", decided before the name rules: the
    # document's UUID is already in the document store under a different key
    # (or as "unsigned"). This holds even when the new key is itself known;
    # the same UUID under two keys is a conflict by definition (§9.7).
    uuid = manifest.get("documentUuid")
    if uuid:
        holder = store.documents.get(uuid)
        if holder is not None and holder != key_b64:
            return {"state": "conflict", "rule": "document"}

    entry = store.keys.get(key_b64)
    if entry is not None:
        return {"state": "known", "count": len(entry["documents"])}

    name = manifest.get("publisherName", "")
    if not name:
        # SPEC GAP: §9.6 defines NEW and CONFLICT for an asserted name; a
        # signed document under an unseen key with no `publisherName` has
        # nothing to collide. Reported "anonymous" here.
        return {"state": "anonymous"}

    if mixed_script(name):
        return {"state": "conflict", "rule": "mixed-script"}
    own = skeleton(name, table)
    for other, other_skeleton in _held_names(store, table):
        if other_skeleton == own:
            return {"state": "conflict", "rule": "skeleton", "knownAs": other}
    return {"state": "new"}


def record(store: KeyStore, manifest: dict, key_b64: str | None, table: dict[str, str]) -> None:
    """Pin or update a key after the person proceeds (§9.6)."""
    uuid = manifest.get("documentUuid")
    if not manifest.get("signature") or not key_b64:
        if uuid:
            store.documents.setdefault(uuid, "unsigned")
        return
    entry = store.keys.setdefault(key_b64, {"name": "", "hostLabel": "", "skeletons": [], "documents": []})
    name = manifest.get("publisherName", "")
    if name:
        entry["name"] = name
    entry["skeletons"] = [skeleton(n, table) for n in (entry["name"], entry["hostLabel"]) if n]
    if uuid and uuid not in entry["documents"]:
        entry["documents"].append(uuid)
    if uuid:
        store.documents.setdefault(uuid, key_b64)


# ---------------------------------------------------------------------------
# Identity (§9.5): enough DER and X.509 to check a Sigstore bundle offline
# ---------------------------------------------------------------------------


class DerError(Exception):
    """A DER structure that is not what §9.5 needs it to be."""


def _der_item(data: bytes, at: int = 0) -> tuple[int, bytes, int]:
    """One TLV at `at`: (tag byte, content, index after it). Definite lengths only."""
    if at + 2 > len(data):
        raise DerError("DER value ended early.")
    tag, first = data[at], data[at + 1]
    at += 2
    if first < 0x80:
        length = first
    else:
        count = first & 0x7F
        if count == 0 or count > 4 or at + count > len(data):
            raise DerError("Unsupported DER length.")
        length = int.from_bytes(data[at : at + count], "big")
        at += count
    if at + length > len(data):
        raise DerError("DER value reaches past its container.")
    return tag, data[at : at + length], at + length


def _der_children(content: bytes) -> list[tuple[int, bytes, bytes]]:
    """Every TLV inside a constructed value, as (tag, content, whole encoding)."""
    items, at = [], 0
    while at < len(content):
        tag, body, after = _der_item(content, at)
        items.append((tag, body, content[at:after]))
        at = after
    return items


def _oid_bytes(dotted: str) -> bytes:
    arcs = [int(a) for a in dotted.split(".")]
    out = bytearray([arcs[0] * 40 + arcs[1]])
    for arc in arcs[2:]:
        chunk = [arc & 0x7F]
        arc >>= 7
        while arc:
            chunk.append(arc & 0x7F | 0x80)
            arc >>= 7
        out.extend(reversed(chunk))
    return bytes(out)


OID_SAN = _oid_bytes("2.5.29.17")
OID_FULCIO_ISSUER_V2 = _oid_bytes("1.3.6.1.4.1.57264.1.8")
OID_FULCIO_ISSUER_V1 = _oid_bytes("1.3.6.1.4.1.57264.1.1")
OID_ECDSA_SHA256 = _oid_bytes("1.2.840.10045.4.3.2")


def _der_time(tag: int, content: bytes) -> int:
    """UTCTime (0x17) or GeneralizedTime (0x18), Z-suffixed, to unix seconds."""
    import calendar

    text = content.decode("ascii")
    if not text.endswith("Z"):
        raise DerError("Certificate time is not in UTC.")
    digits = text[:-1]
    if tag == 0x17:
        if len(digits) != 12:
            raise DerError("Malformed UTCTime.")
        year = int(digits[:2])
        year += 1900 if year >= 50 else 2000
        digits = f"{year:04d}" + digits[2:]
    elif tag != 0x18 or len(digits) < 14:
        raise DerError("Malformed certificate time.")
    digits = digits[:14]  # GeneralizedTime MAY carry fractional seconds; DER forbids them
    parts = [int(digits[i : i + 2]) for i in range(4, 14, 2)]
    return calendar.timegm((int(digits[:4]), *parts))


@dataclass
class Certificate:
    tbs: bytes
    spki: bytes
    not_before: int
    not_after: int
    names: list[str]
    issuer: str | None
    signature: bytes  # raw r||s, 64 bytes, for verify_es256


def _ecdsa_der_to_raw(signature: bytes) -> bytes:
    tag, body, _ = _der_item(signature)
    if tag != 0x30:
        raise DerError("ECDSA signature is not a SEQUENCE.")
    parts = _der_children(body)
    if len(parts) != 2 or any(t != 0x02 for t, _, _ in parts):
        raise DerError("ECDSA signature is not two INTEGERs.")
    r = int.from_bytes(parts[0][1], "big")
    s = int.from_bytes(parts[1][1], "big")
    if r.bit_length() > 256 or s.bit_length() > 256:
        raise DerError("ECDSA signature integer too large for P-256.")
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def parse_certificate(der: bytes) -> Certificate:
    """The parts of an X.509 certificate §9.5 consults, and nothing else."""
    tag, body, after = _der_item(der)
    if tag != 0x30 or after != len(der):
        raise DerError("Certificate is not a single SEQUENCE.")
    outer = _der_children(body)
    if len(outer) != 3:
        raise DerError("Certificate does not have three parts.")
    (tbs_tag, tbs_body, tbs_whole), (_, alg_body, _), (sig_tag, sig_body, _) = outer
    if tbs_tag != 0x30 or sig_tag != 0x03 or not sig_body or sig_body[0] != 0:
        raise DerError("Certificate parts have the wrong tags.")
    alg = _der_children(alg_body)
    if not alg or alg[0][0] != 0x06 or alg[0][1] != OID_ECDSA_SHA256:
        raise DerError("Certificate is not signed with ecdsa-with-SHA256.")
    signature = _ecdsa_der_to_raw(sig_body[1:])

    fields = _der_children(tbs_body)
    if fields and fields[0][0] == 0xA0:  # [0] EXPLICIT version
        fields = fields[1:]
    if len(fields) < 6:
        raise DerError("tbsCertificate is too short.")
    # serial, signature algorithm, issuer, validity, subject, SPKI, [extensions]
    validity = _der_children(fields[3][1])
    if len(validity) != 2:
        raise DerError("Validity is not two times.")
    not_before = _der_time(validity[0][0], validity[0][1])
    not_after = _der_time(validity[1][0], validity[1][1])
    spki = fields[5][2]

    names: list[str] = []
    issuer: str | None = None
    issuer_v1: str | None = None
    for tag, body, _ in fields[6:]:
        if tag != 0xA3:  # [3] EXPLICIT extensions
            continue
        seq = _der_children(body)
        if len(seq) != 1:
            raise DerError("Malformed extensions.")
        for _, ext_body, _ in _der_children(seq[0][1]):
            parts = _der_children(ext_body)
            if not parts or parts[0][0] != 0x06:
                continue
            oid = parts[0][1]
            value = parts[-1][1] if parts[-1][0] == 0x04 else None
            if value is None:
                continue
            if oid == OID_SAN:
                san_tag, san_body, _ = _der_item(value)
                if san_tag == 0x30:
                    for name_tag, name_body, _ in _der_children(san_body):
                        if name_tag in (0x81, 0x86):  # [1] rfc822Name, [6] uniformResourceIdentifier
                            names.append(name_body.decode("utf-8"))
            elif oid == OID_FULCIO_ISSUER_V2:
                inner_tag, inner_body, _ = _der_item(value)
                if inner_tag == 0x0C:
                    issuer = inner_body.decode("utf-8")
            elif oid == OID_FULCIO_ISSUER_V1:
                issuer_v1 = value.decode("utf-8")
    return Certificate(tbs_whole, spki, not_before, not_after, names, issuer or issuer_v1, signature)


def certificate_signed_by(cert: Certificate, signer_spki: bytes) -> bool:
    return verify_es256(signer_spki, cert.signature, cert.tbs)


def _pem_to_der(pem: str) -> bytes:
    lines = [l.strip() for l in pem.strip().splitlines() if l.strip() and not l.startswith("-----")]
    return base64.b64decode("".join(lines))


def _canonical_json(value: Any) -> bytes:
    """RFC 8785 for the shape §9.5 signs: ASCII keys, strings and integers."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def verify_identity(bundle: Any, manifest_key_b64: str | None, manifest_signature_b64: str | None, roots: list[dict]) -> dict[str, Any]:
    """§9.5's four checks, in order, offline. Never raises: any failure, and any
    bundle whose roots are not held, is {"status": "absent", "reason"}.

    `roots` is a §9.6 `sigstore` list: [{name, fulcioRoots: [PEM], rekorKeys: [b64 SPKI]}].
    """
    try:
        return _verify_identity(bundle, manifest_key_b64, manifest_signature_b64, roots)
    except Exception as broken:  # a bad bundle is a document with no binding
        return {"status": "absent", "reason": f"malformed bundle: {type(broken).__name__}: {broken}"}


def _verify_identity(bundle, manifest_key_b64, manifest_signature_b64, roots) -> dict[str, Any]:
    if not isinstance(bundle, dict):
        return {"status": "absent", "reason": "no bundle"}
    if not manifest_key_b64 or not manifest_signature_b64:
        return {"status": "absent", "reason": "manifest is unsigned"}
    material = bundle.get("verificationMaterial")
    if not isinstance(material, dict):
        return {"status": "absent", "reason": "no verificationMaterial"}

    # The leaf, and any intermediates, as §9.5 names them.
    chain_b64: list[str] = []
    cert = material.get("certificate")
    if isinstance(cert, dict) and cert.get("rawBytes"):
        chain_b64 = [cert["rawBytes"]]
    else:
        x509 = material.get("x509CertificateChain", {})
        chain_b64 = [c["rawBytes"] for c in x509.get("certificates", []) if isinstance(c, dict) and c.get("rawBytes")]
    if not chain_b64:
        return {"status": "absent", "reason": "no certificate"}
    chain = [parse_certificate(base64.b64decode(c)) for c in chain_b64]
    leaf = chain[0]

    # 1. The certificate chains to a Fulcio root the host holds. Walked leaf-
    #    first: each link is signed either by a held root's key or by the next
    #    certificate in the chain.
    root_name = None
    root_keys: list[tuple[str, bytes]] = []
    for root in roots:
        for pem in root.get("fulcioRoots", []):
            root_keys.append((root["name"], parse_certificate(_pem_to_der(pem)).spki))
    for index, link in enumerate(chain):
        found = next((name for name, spki in root_keys if certificate_signed_by(link, spki)), None)
        if found is not None:
            root_name = found
            break
        if index + 1 >= len(chain) or not certificate_signed_by(link, chain[index + 1].spki):
            break
    if root_name is None:
        return {"status": "absent", "reason": "certificate does not chain to a held Fulcio root"}
    root = next(r for r in roots if r["name"] == root_name)

    # 2. The leaf's subject public key is the manifest's key.
    if leaf.spki != base64.b64decode(manifest_key_b64):
        return {"status": "absent", "reason": "certificate key is not the manifest's key"}

    # 3. The first log entry's signed entry timestamp verifies against a held
    #    Rekor key named by logId.keyId, and its time lies in the leaf's validity.
    entries = material.get("tlogEntries")
    if not isinstance(entries, list) or not entries or not isinstance(entries[0], dict):
        return {"status": "absent", "reason": "no log entry"}
    entry = entries[0]
    key_id = entry.get("logId", {}).get("keyId")
    rekor_spki = None
    for k in root.get("rekorKeys", []):
        der = base64.b64decode(k)
        if base64.b64encode(hashlib.sha256(der).digest()).decode("ascii") == key_id:
            rekor_spki = der
            break
    if rekor_spki is None:
        return {"status": "absent", "reason": "log key is not held"}
    # SPEC GAP: §9.5 says `integratedTime` and `logIndex` "are numbers" in the
    # signed JSON, but the bundle's protobuf-JSON form carries both as decimal
    # strings (int64 in proto3 JSON). The document should say the reader
    # converts them; this reader does.
    integrated = int(entry["integratedTime"])
    log_index = int(entry["logIndex"])
    body_b64 = entry["canonicalizedBody"]
    signed = _canonical_json({
        "body": body_b64,
        "integratedTime": integrated,
        "logID": hashlib.sha256(rekor_spki).hexdigest(),
        "logIndex": log_index,
    })
    set_der = base64.b64decode(entry["inclusionPromise"]["signedEntryTimestamp"])
    if not verify_es256(rekor_spki, _ecdsa_der_to_raw(set_der), signed):
        return {"status": "absent", "reason": "signed entry timestamp does not verify"}
    if not (leaf.not_before <= integrated <= leaf.not_after):
        return {"status": "absent", "reason": "log time lies outside the certificate's validity"}

    # 4. The logged signature is the manifest's signature bytes.
    logged = None
    try:
        body = json.loads(base64.b64decode(body_b64))
        logged = body["spec"]["signature"]["content"]
    except (ValueError, KeyError, TypeError):
        logged = bundle.get("messageSignature", {}).get("signature")
    if not isinstance(logged, str) or base64.b64decode(logged) != base64.b64decode(manifest_signature_b64):
        return {"status": "absent", "reason": "logged signature is not the manifest's signature"}

    if not leaf.names:
        return {"status": "absent", "reason": "certificate carries no subject alternative name"}
    result: dict[str, Any] = {"status": "shown", "identity": leaf.names[0], "root": root_name}
    if leaf.issuer:
        result["issuer"] = leaf.issuer
    return result


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
