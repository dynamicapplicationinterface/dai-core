# DAI container format, v0.2

Supersedes [spec-v0.1.md](spec-v0.1.md), which describes a design that no longer
matches the implementation. Where the two disagree, this document is correct and
v0.1 is kept only as a record of what changed.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted
as described in RFC 2119. They mark the requirements a conforming implementation
has to meet; prose without them is explanation, and no implementation is bound
by it.

---

## 1. What a container is

A single file holding an application, the runtime that executes it, a SQLite
engine, and the application's own database. It runs with no network access of
any kind, from a filesystem, with nothing installed.

Two encodings exist.

**`.dai` — the canonical form.** A sectioned binary (§2). This is what a
document handler registers, what mail systems pass without quarantining, and
what supports saving without rewriting the whole file.

**`.dai.html` — the viewer form.** A polyglot HTML document carrying the same
content base64-encoded inside a `<script>` tag. It opens in any browser with
nothing installed, which is the property that makes the format demonstrable. A
save from this form rewrites the entire file.

An implementation MUST determine the form from the leading bytes (§2.1), and
MUST NOT determine it from a file extension.

---

## 2. The sectioned form

All integers are little-endian. Offsets and lengths are 64-bit.

```
offset 0   magic          4 bytes    0x44 0x41 0x49 0x00  ("DAI\0")
offset 4   formatVersion  u16        2
offset 6   flags          u16        reserved, MUST be 0
offset 8   sectionCount   u32
offset 12  section table  sectionCount × 56 bytes

  each entry:
    +0   id       u8    1 manifest, 2 payload, 3 data
    +1   padding  3 bytes, MUST be 0
    +4   offset   u64
    +12  length   u64
    +20  digest   32 bytes, SHA-256 of the section's bytes

then, each aligned to 4096:
  §1 MANIFEST   JSON, UTF-8 (§3)
  §2 PAYLOAD    zip: the application, the shell, the engine
  §3 DATA       the SQLite database, verbatim

last 64 bytes  footer
    +0   generation  u64
    +8   dataDigest  32 bytes, SHA-256 of §3
    +40  reserved    20 bytes, MUST be 0
    +60  magic       4 bytes  0x00 0x49 0x41 0x44
```

A container MUST carry all three sections. A reader MUST refuse a file missing
any of them, and MUST distinguish that refusal from an empty database: a file
with no data section is incomplete, not a document whose data is gone.

Sections MUST begin on a 4096-byte boundary. SQLite's page size is pinned at
4096 (§6), so a section boundary and a page boundary coincide, which is what
permits a positioned write.

### 2.1 Identifying the form

A reader MUST treat bytes beginning with the four magic bytes as the sectioned
form. Anything else is parsed as the viewer form.

### 2.2 What a reader can establish cheaply

The footer sits at a fixed distance from the end. A reader MAY establish that a
file is structurally intact and current by reading the header, the section table
and the last 64 bytes — without reading the sections themselves. It MUST NOT
report a container as verified on that basis alone; §7 defines verification.

---

## 3. The manifest

JSON, UTF-8, in §1 of the sectioned form and at `runtime/manifest.json` in the
viewer form's payload.

```jsonc
{
  "manifestVersion": 1,
  "documentUuid": "…",          // v4 UUID, the document's identity
  "appName": "…",
  "favicon": "…",
  "createdAt": "…",             // ISO 8601
  "algorithm": "SHA-256",
  "integrityPolicy": "required" | "advisory",
  "hashes": { "<entry>": "<hex digest>" },
  "signatureAlgorithm": "COSE-ES256",
  "publicKeyFingerprint": "…",
  "signedEntries": { "<entry>": "<hex digest>" },
  "signature": "…",             // base64, IEEE P1363
  "validUntil": 1234567890      // optional, Unix seconds
}
```

`integrityPolicy` here is informational. The shell decides whether verification
is enforced, and a reader MUST take the policy from the shell rather than from
the manifest — a policy stored inside the archive it governs could be switched
off by the same edit that alters the archive.

In the sectioned form the manifest MUST NOT carry a digest for the database. The
footer records it, and the footer is rewritten by the same act that changes the
database. This is what allows a save to leave the manifest untouched (§5).

### 3.1 What the signature covers

The signature is a `COSE_Sign1` envelope (RFC 9052), base64-encoded into
`signature`. `signatureAlgorithm` MUST be `COSE-ES256`.

The protected header MUST carry `alg` (label 1) as `-7`, ES256. It SHOULD carry
`kid` (label 4) as the publisher key fingerprint. `alg` is in the *protected*
header because it is covered by the signature: an attacker able to rewrite it
could otherwise talk a verifier down to something weaker.

The payload MUST be detached — encoded as `nil` in the envelope. A verifier
rebuilds it from the manifest it already holds, so there is exactly one copy of
what was signed. Carrying a second inside the envelope would mean two that can
disagree, and the one inside the signature would win unnoticed.

The payload is a deterministic CBOR map (RFC 8949 §4.2.1) with these keys:

```
manifestVersion, documentUuid, appName, favicon, createdAt,
algorithm, integrityPolicy, signatureAlgorithm, publicKeyFingerprint,
entries            — a map of signed entry name to hex digest
validUntil         — present only when set
```

Keys MUST be sorted by their encoded bytes, lengths MUST use the shortest form
that fits, and indefinite lengths MUST NOT be used. Two encoders that agree on
the values and disagree on the bytes produce signatures that do not verify.

`validUntil` MUST be omitted entirely when unset, not encoded as null or zero.

The signature is computed over `Sig_structure` as RFC 9052 §4.4 defines it:

```
[ "Signature1", protected: bstr, external_aad: bstr, payload: bstr ]
```

`external_aad` MUST be empty. The context string is what stops a signature made
for one purpose being replayed as another.

`signedEntries` MUST exclude the database. A container carries no private key
and cannot re-sign after a save, so a signature covering the database would be
invalidated by the first save.

An implementation MUST reconcile `signedEntries` against `hashes` before
verifying the signature, and MUST refuse where they disagree. Otherwise a
signature could be validated over digests other than the ones just checked.

`savedAt`, if present, is outside the signed set.

---

## 4. Isolation

### 4.1 The frame

The application MUST run in an iframe whose sandbox attribute is exactly:

```
allow-scripts allow-forms
```

`allow-same-origin` MUST NOT be granted. With it the application shares an
origin with the shell that contains it, and can read the publisher key from the
DOM and rewrite the bootloader that a save seals into the next copy — which
makes every other guarantee here decorative.

`allow-popups` MUST NOT be granted: `window.open` carries a URL, a URL carries
data, and no CSP directive governs it. `allow-downloads` and `allow-modals` MUST
NOT be granted by default.

An implementation MUST NOT pass `blob:` URLs into the frame. A blob URL belongs
to the origin that minted it and is unreachable from an opaque origin; passing
them is what previously forced `allow-same-origin`. The frame MUST mint its own
from bytes it receives.

### 4.2 Content Security Policy

Carried in the shell, in a `<meta http-equiv>` that MUST precede everything in
`<head>` except `<meta charset>`.

```
default-src 'none';
script-src 'nonce-<nonce>' 'wasm-unsafe-eval' blob:;
style-src 'self' 'unsafe-inline' blob:;
img-src 'self' data: blob:;
font-src 'self' data: blob:;
media-src 'self' data: blob:;
frame-src 'self' blob:;
worker-src blob:;
connect-src 'none';
form-action 'none';
base-uri 'none';
object-src 'none';
```

`script-src` MUST NOT include `'unsafe-inline'`. The nonce is fixed at compile
time — a container is a static file, so there is no response to vary and the
value is legible to anyone who opens it. That is not what does the work: a nonce
never authorises an inline event handler or a `javascript:` URL whatever its
value, and those are the sinks a value stored in the database can reach.

A compiler MUST stamp the nonce on every script it seals, including the
application's own inline scripts. Anything introduced afterwards has no nonce
and does not execute. `'unsafe-eval'` MUST NOT be granted.

`connect-src 'none'` is the invariant. An implementation MUST NOT add any scheme
that can reach a network host.

**Residual channels.** `connect-src` does not govern top-level navigation, DNS
prefetch, speculation rules, or WebRTC. The sandbox flags above close navigation
and popups. A native host SHOULD disable WebRTC and DNS prefetch at the webview
layer; a browser-based runner cannot, and MUST document them as residual.

### 4.3 Checking a host

The requirements in §4 are properties of a host, not of a file, so no container
can carry a verdict about them. [`conformance/isolation-probe.dai.html`](../conformance/README.md)
is a container that tests them from the inside and reports what got through. An
implementation claiming to host this format SHOULD mount it and reach
"blocked" on every check.

A host MUST NOT treat a failed request as evidence of a boundary. A request
fails identically when the policy blocked it and when there was no network; only
a violation report distinguishes them.

### 4.4 Mounting

Because the frame has no shared origin, the payload is handed to it as bytes.

1. The shell mounts a frame containing only a loader.
2. The loader posts `{ type: "dai:frame-hello" }` to its parent.
3. The shell replies once with the payload, transferring the buffers.
4. The loader mints its own blob URLs, builds an import map, writes the
   application's document, and stops listening.

The loader MUST verify that the payload arrived from its parent, and MUST stop
accepting payloads once one has been handled. Otherwise any window holding a
reference to the frame can replace a running application's document.

The shell MUST answer only one hello. The buffers are transferred and therefore
detached after the first reply.

---

## 5. Saving

A save in the sectioned form MUST rewrite only §3 and the footer, MUST leave §1
and §2 byte-identical, and MUST increment `generation`.

This is what allows a document to be saved by somebody holding no key: the
publisher's signature covers the manifest, the manifest is untouched, and the
signature therefore still holds.

A host that has seen a later generation for a document MAY treat an earlier one
as a rollback.

An in-place save cannot be atomic, and a host MUST NOT pretend otherwise. It
MUST write and flush the data section before it writes the table entry and the
footer, so that a crash between the two leaves a file whose recorded digest does
not match its contents — which §7 reports as a damaged database. The ordering
rules out the dangerous failure rather than every failure: a file that reports
itself intact while holding a half-written database.

A host MUST refuse to save in place when the data section is not the last
section, because moving it would move sections the signature covers. It SHOULD
zero the padding between the end of the database and the section boundary; a
shorter database otherwise leaves the tail of its predecessor inside a file
whose owner believes those rows were deleted.

A save in the viewer form rewrites the entire file, and the manifest with it.

---

## 6. SQLite

The engine and its Emscripten glue are packaged in the payload. They MUST be
handed to the application as bytes rather than as URLs.

`PRAGMA page_size` MUST be 4096 for a database created by the runtime. The
pragma only takes effect while a database is empty, so it MUST run before
anything creates a table. A seeded database keeps whatever page size its bytes
declare.

At an opaque origin `window.localStorage` throws rather than returning null, and
sqlite3ApiBootstrap reads it. A runtime MUST provide an in-memory stand-in for
`localStorage` and `sessionStorage`, which also matches what the format
promises: data belongs in the file, and anything in browser storage would not
travel with it.

---

## 7. Verification

A host MUST perform these checks, in this order, and MUST NOT mount anything
until all of them pass.

1. **Structure.** The container parses, and carries every required section.
2. **Sections** (sectioned form only). Every section matches the digest in the
   table, and the footer matches the database it describes.
3. **Entries.** Every entry matches its manifest digest, and every manifest
   entry is present. Both directions: an unlisted entry is as much a failure as
   a modified one, or content could simply be appended.
4. **Shell.** The shell matches the sealed copy inside the payload.
5. **Expiry.** `validUntil`, when present, has not passed.
6. **Signature.** When the shell carries a publisher key, the signature verifies
   over §3.1.

A host MUST report a refusal with a reason a person can act on, and SHOULD
report it to whatever is hosting it, not only to the screen. A container that
refuses inside a frame shows its reason to nobody.

### 7.1 Conformance

[`conformance/`](../conformance/README.md) carries containers whose verdicts are
stated in advance — one for each failure this section describes, and several
that must be accepted. An implementation claiming to read this format SHOULD
run them and reach the stated verdict for each, including the reason and not
only the accept-or-refuse.

The suite is where this document stops being a description of one program.

---

## 8. What this format does not address

Stated plainly, because a specification that omits its limits is worse than one
that has them.

**Who a publisher is.** A signature proves the file has not changed since it was
signed by whoever holds the key it carries. It does not say who that is: a
container is self-contained, so an attacker can substitute the key and re-sign.
Identity requires something from outside the file — a key pinned on first use, a
directory, a transparency log.

**A malicious application.** The sandbox bounds the damage; it does not make the
code benign. An application can still present a form that asks for a password
and store the answer in its own database.

**Host compromise.** Every claim here rests on the host performing the checks in
§7 honestly. A compromised host can report anything.

**Clock rollback.** `validUntil` is checked against a clock the host controls.

**Self-attestation.** A container cannot detect its own bootloader being
rewritten, because that check would run inside the code an attacker replaced.
Only a separate reader holding the sealed copy can find it, and that finding
belongs to the host.
