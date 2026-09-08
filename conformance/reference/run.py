"""Runs the conformance suite against the reference reader.

This is what the suite is for: an implementation that shares no code with the
one that wrote the cases, reaching the stated verdict on each. If this passes,
the specification carried enough to build a reader from. Where it did not, the
places are marked SPEC GAP in `dai_read.py`.

    python conformance/reference/run.py

Exits non-zero on the first disagreement, and prints what it expected.
"""

from __future__ import annotations

import base64
import hashlib
import json
import struct
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import dai_read  # noqa: E402
from dai_read import ContainerError, countersignatures, verify, verify_link  # noqa: E402

SUITE = Path(__file__).resolve().parents[1]

# The suite is fixed, so the clock must be too. A case that expires in 2033
# would otherwise start failing in 2033, and the failure would look like a bug
# in whatever reader ran it that day.
NOW = 1767225600  # 2026-01-01T00:00:00Z


def _sign_es256(private: int, message: bytes) -> bytes:
    """A test-only ES256 signer over dai_read's curve arithmetic.

    The nonce is derived from the key and the message, so the self-check is
    repeatable; nothing here signs anything a person will keep.
    """
    z = int.from_bytes(hashlib.sha256(message).digest(), "big")
    k = int.from_bytes(hashlib.sha256(private.to_bytes(32, "big") + message).digest(), "big") % dai_read.N or 1
    r = dai_read._multiply(k, (dai_read.GX, dai_read.GY))[0] % dai_read.N
    s_ = pow(k, -1, dai_read.N) * (z + r * private) % dai_read.N
    return r.to_bytes(32, "big") + s_.to_bytes(32, "big")


def _test_key(seed: bytes) -> tuple[int, str]:
    private = int.from_bytes(hashlib.sha256(seed).digest(), "big") % dai_read.N or 1
    x, y = dai_read._multiply(private, (dai_read.GX, dai_read.GY))
    spki = dai_read._SPKI_PREFIX + b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")
    return private, base64.b64encode(spki).decode("ascii")


def _countersign(manifest: dict, body_protected: bytes, publisher_sig: bytes, private: int, header: dict) -> list:
    sign_protected = dai_read.cbor_encode(header)
    structure = dai_read.cbor_encode([
        "CounterSignatureV2", body_protected, sign_protected, b"",
        dai_read._signed_payload(manifest), [publisher_sig],
    ])
    return [sign_protected, {}, _sign_es256(private, structure)]


def countersignature_selfcheck(failures: list) -> None:
    """§9.4 exercised without a case file: a synthetic version 3 manifest,
    signed under one test key and countersigned under others.

    A held key with a good countersignature is `valid`; a held key with a
    signature over other bytes is `invalid`; a kid nobody holds is `unheld`;
    a protected header without a kid is `invalid` whatever it signs. The
    publisher's own verdict is unchanged throughout, and a tag 18 envelope
    reads the same as an untagged one.
    """
    publisher, publisher_spki = _test_key(b"publisher")
    counter_a, spki_a = _test_key(b"countersigner-a")
    counter_b, spki_b = _test_key(b"countersigner-b")
    kid_a, kid_b = b"release-a", b"release-b"

    manifest = {
        "manifestVersion": 3,
        "documentUuid": "00000000-0000-4000-8000-000000000000",
        "appName": "Self-check",
        "createdAt": "2026-01-01T00:00:00Z",
        "algorithm": "SHA-256",
        "integrityPolicy": "required",
        "signatureAlgorithm": "COSE-ES256",
        "publicKeyFingerprint": "",
        "signedEntries": {"app/index.html": "00" * 32},
        "hashes": {"app/index.html": "00" * 32},
    }
    body_protected = dai_read.cbor_encode({1: -7})
    payload = dai_read._signed_payload(manifest)
    publisher_sig = _sign_es256(publisher, dai_read.cbor_encode(["Signature1", body_protected, b"", payload]))

    good_a = _countersign(manifest, body_protected, publisher_sig, counter_a, {1: -7, 4: kid_a})
    good_b = _countersign(manifest, body_protected, publisher_sig, counter_b, {1: -7, 4: kid_b})
    tampered = list(good_a)
    tampered[2] = bytes([tampered[2][0] ^ 1]) + tampered[2][1:]
    no_kid = _countersign(manifest, body_protected, publisher_sig, counter_a, {1: -7})
    wrong_alg = _countersign(manifest, body_protected, publisher_sig, counter_a, {1: -8, 4: kid_a})

    held = {kid_a: spki_a}
    checks = [
        ("one countersignature, held key", good_a, [{"kid": kid_a.hex(), "status": "valid"}]),
        ("array of countersignatures, one key held", [good_a, good_b],
         [{"kid": kid_a.hex(), "status": "valid"}, {"kid": kid_b.hex(), "status": "unheld"}]),
        ("tampered countersignature", tampered, [{"kid": kid_a.hex(), "status": "invalid"}]),
        ("protected header without kid", no_kid, [{"kid": "", "status": "invalid"}]),
        ("protected header with another alg", wrong_alg, [{"kid": kid_a.hex(), "status": "invalid"}]),
    ]
    for tagged in (False, True):
        for name, slot, expect in checks:
            envelope = [body_protected, {11: slot}, None, publisher_sig]
            encoded = dai_read.cbor_encode(envelope)
            if tagged:
                encoded = b"\xd2" + encoded  # tag 18
                name += ", tag 18 envelope"
            case = dict(manifest, signature=base64.b64encode(encoded).decode("ascii"))
            got = countersignatures(case, publisher_spki, held)
            verdict, code = dai_read._check_signature(case, publisher_spki, case["hashes"])
            wrong = []
            if got != expect:
                wrong.append(f"expected {expect!r}, read {got!r}")
            if (verdict, code) != ("valid", ""):
                wrong.append(f"publisher verdict changed to {verdict!r} {code!r}")
            label = f"countersignature self-check: {name}"
            if wrong:
                failures.append((label, "; ".join(wrong)))
            print(f"{'ok' if not wrong else 'FAILED':>7}  {label}")

    # The empty slot, and no slot at all: nothing to report.
    for name, unprotected in (("no label 11", {}), ("empty array", {11: []})):
        encoded = dai_read.cbor_encode([body_protected, unprotected, None, publisher_sig])
        case = dict(manifest, signature=base64.b64encode(encoded).decode("ascii"))
        got = countersignatures(case, publisher_spki, held)
        label = f"countersignature self-check: {name}"
        if got != []:
            failures.append((label, f"expected [], read {got!r}"))
        print(f"{'ok' if got == [] else 'FAILED':>7}  {label}")



def byte_vectors(failures: list) -> None:
    """docs/cddl.md's frozen vectors, recomputed here from the vector's own
    inputs and compared byte for byte.

    Everything else in this suite agrees about verdicts. This is the one hook
    that makes two independent encoders agree about *bytes*: the signed payload
    above all, which is what every signature in the format is computed over. A
    reader that reaches the right verdict on the suite's own files and encodes
    the payload differently would still reject every signature anyone else made.
    """
    vectors_file = SUITE / "vectors.json"
    if not vectors_file.exists():
        print(f"{'skip':>7}  no conformance/vectors.json; run `npm run conformance`")
        return
    vectors = json.loads(vectors_file.read_text(encoding="utf-8"))

    def check(label: str, wrong: list) -> None:
        name = f"{label} — byte vector"
        if wrong:
            failures.append((name, "; ".join(wrong)))
        print(f"{'ok' if not wrong else 'FAILED':>7}  {name}")

    def compare(label: str, got: bytes, expected_hex: str) -> None:
        check(label, [] if got.hex() == expected_hex else [
            f"expected {expected_hex}, encoded {got.hex()}"
        ])

    # 1. The signed payload (§3.1, §9.3). Built through the reader's own
    #    field-selection path rather than by encoding the view directly, so the
    #    rules about which optional fields are present are under test too.
    view = vectors["signedPayload"]["view"]
    rebuilt = {k: v for k, v in view.items() if k != "entries"}
    rebuilt["signedEntries"] = view["entries"]
    try:
        payload = dai_read._signed_payload(rebuilt)
        compare("signedPayload", payload, vectors["signedPayload"]["cbor"])
    except (ContainerError, KeyError) as error:
        payload = b""
        check("signedPayload", [f"could not be encoded: {error}"])

    # 2. The protected header: alg ES256, kid as ASCII bytes (§3.1).
    protected = dai_read.cbor_encode(
        {1: -7, 4: vectors["protectedHeader"]["kid"].encode("ascii")}
    )
    compare("protectedHeader", protected, vectors["protectedHeader"]["cbor"])

    # 3. Sig_structure, RFC 9052 §4.4. Uses the header just rebuilt, not the
    #    vector's, so a disagreement about either shows up here.
    compare(
        "sigStructure",
        dai_read.cbor_encode(["Signature1", protected, b"", payload]),
        vectors["sigStructure"]["cbor"],
    )

    # 5. The envelope, first because 4 needs its parts. §9.4: untagged on write,
    #    tag 18 accepted on read, and the two are the same value.
    envelope_bytes = bytes.fromhex(vectors["envelope"]["cbor"])
    tagged_bytes = bytes.fromhex(vectors["envelope"]["tagged"])
    envelope = dai_read.cbor_decode(envelope_bytes)
    tagged = dai_read.cbor_decode(tagged_bytes)
    wrong = []
    if envelope_bytes[0] >> 5 != 4:
        wrong.append(f"the untagged form begins with 0x{envelope_bytes[0]:02x}, not an array head")
    if not isinstance(tagged, dai_read.Tagged) or tagged.tag != dai_read.COSE_SIGN1_TAG:
        wrong.append("the tagged form is not tag 18")
    elif tagged.value != envelope:
        wrong.append("the tagged and untagged forms decode to different values")
    if not (isinstance(envelope, list) and len(envelope) == 4 and envelope[2] is None):
        wrong.append(f"not a four-element COSE_Sign1 with a detached payload: {envelope!r}")
    check("envelope", wrong)

    # 4. Countersign_structure, RFC 9338 §3.3 version 2 (§9.4). body_protected
    #    and the publisher signature come out of the envelope above.
    body_protected, _unprotected, _detached, publisher_signature = envelope
    compare(
        "countersignStructure",
        dai_read.cbor_encode([
            "CounterSignatureV2",
            body_protected,
            bytes.fromhex(vectors["countersignStructure"]["protectedHeader"]),
            b"",
            payload,
            [publisher_signature],
        ]),
        vectors["countersignStructure"]["cbor"],
    )

    # 6. The fixed byte layouts of §2. Not CBOR, and the one place a reader can
    #    disagree about endianness rather than about encoding.
    header = bytes.fromhex(vectors["header"]["hex"])
    magic, format_version, flags, section_count = struct.unpack("<4sHHI", header[:12])
    wrong = []
    if len(header) != dai_read.HEADER_BYTES:
        wrong.append(f"header is {len(header)} bytes, not {dai_read.HEADER_BYTES}")
    if magic != dai_read.MAGIC:
        wrong.append(f"magic {magic!r}, not {dai_read.MAGIC!r}")
    if format_version != dai_read.FORMAT_VERSION:
        wrong.append(f"formatVersion {format_version}, not {dai_read.FORMAT_VERSION}")
    if flags != 0:
        wrong.append(f"flags {flags}, not 0")
    if section_count != len(dai_read.REQUIRED_SECTIONS):
        wrong.append(f"sectionCount {section_count}, not {len(dai_read.REQUIRED_SECTIONS)}")
    check("header", wrong)

    footer = bytes.fromhex(vectors["footer"]["hex"])
    wrong = []
    if len(footer) != dai_read.FOOTER_BYTES:
        wrong.append(f"footer is {len(footer)} bytes, not {dai_read.FOOTER_BYTES}")
    else:
        generation = struct.unpack_from("<Q", footer, 0)[0]
        if generation != vectors["footer"]["generation"]:
            wrong.append(f"generation {generation}, not {vectors['footer']['generation']}")
        if footer[8:40] == bytes(32):
            wrong.append("dataDigest is all zero")
        if footer[40:60] != bytes(20):
            wrong.append(f"reserved is {footer[40:60].hex()}, not zero")
        if footer[60:64] != dai_read.FOOTER_MAGIC:
            wrong.append(f"trailing magic {footer[60:64].hex()}, not {dai_read.FOOTER_MAGIC.hex()}")
    check("footer", wrong)

    # 7. The inline carrier (§1.1): the header bytes by hand, and the whole
    #    fragment back through the reader to the document it carries.
    carrier = vectors["inlineCarrier"]
    head = bytes.fromhex(carrier["head"])
    wrong = []
    if head[0] != carrier["version"]:
        wrong.append(f"version byte {head[0]}, not {carrier['version']}")
    if head[1:5].hex() != carrier["dictionaryId"]:
        wrong.append(f"dictionaryId {head[1:5].hex()}, not {carrier['dictionaryId']}")
    try:
        carried = dai_read.from_inline_link(carrier["fragment"])
        got_uuid = carried.manifest["documentUuid"]
        if got_uuid != view["documentUuid"]:
            wrong.append(f"documentUuid {got_uuid!r}, not the payload's {view['documentUuid']!r}")
    except (ContainerError, ValueError, KeyError) as error:
        wrong.append(f"the fragment could not be read: {error}")
    check("inlineCarrier", wrong)


def _manifest_and_key(data: bytes) -> tuple[dict, str | None]:
    """The manifest object and the shell's publisher key from a case file, by
    the same readers verify() uses."""
    if data[:4] == dai_read.MAGIC:
        archive, manifest_bytes, _sections = dai_read._read_sectioned(data)
        key = None
    else:
        archive, shell_text = dai_read._read_viewer(data.decode("utf-8", errors="replace"))
        manifest_bytes = archive.get(dai_read.MANIFEST_ENTRY, b"")
        key = dai_read._key_from_shell(shell_text)
    if not manifest_bytes:
        raise ContainerError("This container has no manifest.")
    return json.loads(manifest_bytes), key


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
            "code": report.code,
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

    # The carrier (§1.1), from links the conformance build packed with the
    # reference implementation. A carrier is not a form: the same document in a
    # link has to reach the same verdict on everything a reader can check
    # without a host — the signature over the recomputed digests above all.
    links_file = SUITE / "inline-links.json"
    if links_file.exists():
        for case in json.loads(links_file.read_text(encoding="utf-8"))["links"]:
            name = f"{case['name']} — carried in a link"
            # A case may expect a refusal rather than a reading. A document
            # naming a capability this reader lacks is intact and correctly
            # packed; refusing it at the far end is the whole purpose of
            # carrying `requires` in the link, so reading it is the failure.
            refuse = case.get("refuse")
            try:
                report = verify_link(case["link"], NOW)
                if refuse:
                    wrong = [f"expected a refusal ({refuse}), was read"]
                else:
                    wrong = [
                        f"{key}: expected {value!r}, read {getattr(report, key)!r}"
                        for key, value in case["expect"].items()
                        if getattr(report, key) != value
                    ]
            except ContainerError as error:
                wrong = [] if refuse and refuse in str(error) else [f"refused: {error}"]
            if wrong:
                failures.append((name, "; ".join(wrong)))
            print(f"{'ok' if not wrong else 'FAILED':>7}  {name}")

        first = json.loads(links_file.read_text(encoding="utf-8"))["links"][0]["link"]

        # Cut in transit: refused, never read in part.
        try:
            verify_link(first[: len(first) * 2 // 3], NOW)
            failures.append(("a link cut in transit", "was read rather than refused"))
            print(f"{'FAILED':>7}  a link cut in transit is refused")
        except ContainerError as error:
            ok = "LINK_DAMAGED" in str(error)
            if not ok:
                failures.append(("a link cut in transit", f"refused for the wrong reason: {error}"))
            print(f"{'ok' if ok else 'FAILED':>7}  a link cut in transit is refused")

        # A dictionary this reader does not hold: refused by name, never inflated.
        head, value = first.split("#a=", 1)
        raw = bytearray(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        raw[1] ^= 0xFF
        foreign = head + "#a=" + base64.urlsafe_b64encode(bytes(raw)).decode("ascii").rstrip("=")
        try:
            verify_link(foreign, NOW)
            failures.append(("a link naming another dictionary", "was read rather than refused"))
            print(f"{'FAILED':>7}  a link naming another dictionary is refused")
        except ContainerError as error:
            ok = "LINK_UNSUPPORTED" in str(error)
            if not ok:
                failures.append(("a link naming another dictionary", f"refused for the wrong reason: {error}"))
            print(f"{'ok' if ok else 'FAILED':>7}  a link naming another dictionary is refused")
    else:
        print(f"{'skip':>7}  no conformance/inline-links.json; run `npm run conformance`")

    # §9.4: countersignatures, verified against keys the suite says a host
    # holds. Never a verdict: the vectors say what is reported, and verify()
    # is checked above to say the same thing about the same file regardless.
    countersignature_selfcheck(failures)
    vectors_file = SUITE / "countersign-vectors.json"
    if vectors_file.exists():
        for vector in json.loads(vectors_file.read_text(encoding="utf-8"))["vectors"]:
            name = f"{vector['name']} — countersignatures"
            held = {bytes.fromhex(k): v for k, v in vector.get("heldKeys", {}).items()}
            try:
                data = (SUITE / vector["file"]).read_bytes()
                manifest_json, key = _manifest_and_key(data)
                got = countersignatures(manifest_json, key, held)
                wrong = [] if got == vector["expect"] else [f"expected {vector['expect']!r}, read {got!r}"]
            except (ContainerError, ValueError, KeyError, zipfile.BadZipFile) as error:
                wrong = [f"could not be read: {error}"]
            if wrong:
                failures.append((name, "; ".join(wrong)))
            print(f"{'ok' if not wrong else 'FAILED':>7}  {name}")
    else:
        print(f"{'skip':>7}  no conformance/countersign-vectors.json; run `npm run conformance`")

    # §9.6: the trust states, reached in sequence from an empty key store.
    trust_file = SUITE / "trust-vectors.json"
    if trust_file.exists():
        vectors = json.loads(trust_file.read_text(encoding="utf-8"))
        table = dai_read.load_confusables(SUITE / vectors["table"])
        store = dai_read.KeyStore()
        for step in vectors["sequence"]:
            name = f"{step['name']} — trust state"
            try:
                data = (SUITE / step["file"]).read_bytes()
                manifest_json, key = _manifest_and_key(data)
                got = dai_read.trust_state(store, manifest_json, key, table)
                wrong = [
                    f"{k}: expected {v!r}, read {got.get(k)!r}"
                    for k, v in step["expect"].items()
                    if got.get(k) != v
                ]
                if step.get("record"):
                    dai_read.record(store, manifest_json, key, table)
            except (ContainerError, ValueError, KeyError, zipfile.BadZipFile) as error:
                wrong = [f"could not be read: {error}"]
            if wrong:
                failures.append((name, "; ".join(wrong)))
            print(f"{'ok' if not wrong else 'FAILED':>7}  {name}")
    else:
        print(f"{'skip':>7}  no conformance/trust-vectors.json; run `npm run conformance`")

    # §9.5: identity bundles, checked offline against the suite's own Fulcio
    # root and Rekor key. Never a verdict: shown, or absent with a reason.
    identity_file = SUITE / "identity-vectors.json"
    if identity_file.exists():
        vectors = json.loads(identity_file.read_text(encoding="utf-8"))
        for vector in vectors["vectors"]:
            name = f"{vector['name']} — identity"
            path = SUITE / vector["file"]
            if not path.exists():
                print(f"{'skip':>7}  {name}: no {vector['file']}")
                continue
            try:
                manifest_json, key = _manifest_and_key(path.read_bytes())
                got = dai_read.verify_identity(
                    manifest_json.get("identity"), key, manifest_json.get("signature"), vectors["roots"]
                )
                wrong = [
                    f"{k}: expected {v!r}, read {got.get(k)!r}"
                    for k, v in vector["expect"].items()
                    if got.get(k) != v
                ]
                if wrong and got.get("reason"):
                    wrong.append(f"reason: {got['reason']}")
            except (ContainerError, ValueError, KeyError, zipfile.BadZipFile) as error:
                wrong = [f"could not be read: {error}"]
            if wrong:
                failures.append((name, "; ".join(wrong)))
            print(f"{'ok' if not wrong else 'FAILED':>7}  {name}")
    else:
        print(f"{'skip':>7}  no conformance/identity-vectors.json; run `npm run conformance`")

    # docs/cddl.md: the frozen byte vectors. Not a verdict about any file —
    # the check that this reader's encoder and the one that built the vectors
    # produce the same bytes, which is what a signature actually depends on.
    byte_vectors(failures)

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
