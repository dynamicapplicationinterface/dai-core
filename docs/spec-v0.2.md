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
payload archive, base64-encoded, inside a single element:

```html
<script type="application/octet-stream" id="dai-payload">…</script>
```

A reader MUST locate it by the `id`, MUST NOT assume an attribute order, and
MUST treat the decoded bytes as the payload archive of §2. It opens in any
browser with nothing installed, which is the property that makes the format
demonstrable. A save from this form rewrites the entire file.

An implementation MUST determine the form from the leading bytes (§2.1), and
MUST NOT determine it from a file extension.

### 1.1 Carriers

A **form** is how a document is encoded. A **carrier** is how it reaches
somebody. They are independent: any form may travel by any carrier, and a
reader MUST verify what arrives by §7 regardless of which carrier brought it.
Where bytes came from says nothing about what they are.

Three carriers are defined.

**The file.** The document as a file: attached, copied, handed over on a disk.
This is the carrier the rest of this document assumes, and the only one that
needs nothing but the file.

**The inline link.** The document in the address itself:

```
<opener>/#a=<base64url( version | dictionary-id | deflate )>
```

`a` for the application, in the fragment and nowhere else. The fragment is the
whole of it, which is the point: a fragment is not sent to a server, so a
document carried this way is in the link and in no log, on no host, and behind
nothing that can expire.

The value is base64url (RFC 4648 §5) without padding over three parts: one byte
of carrier version, currently `1`; four bytes identifying the preset
dictionary; and a raw DEFLATE stream (RFC 1951) compressed against that
dictionary. A reader MUST refuse a version or a dictionary id it does not hold,
by name, rather than inflate against the wrong one.

The stream inflates to one CBOR map (RFC 8949) with integer keys:

| key | value |
|---|---|
| 1 | `documentUuid`, 16 bytes |
| 2 | `appName` |
| 3 | `favicon` |
| 4 | `createdAt` |
| 5 | 1 for `integrityPolicy: required`, 0 for advisory |
| 6 | `validUntil`, when set |
| 7 | the publisher key as a compressed P-256 point (SEC 1 §2.3.3), 33 bytes, when signed |
| 8 | the raw ECDSA signature, 64 bytes, when signed |
| 9 | entries, in archive order: `[name, 0, bytes]` carried or `[name, 1, digest]` elided |
| 10 | `publisherName`, when the publisher signed under one |
| 11 | `supersedes`, 16 bytes, when this document replaces another |
| 12 | `manifestVersion`, when it is not 2. Absent means 2. A reader rebuilds the signed set by that version's rules (§9.2): for 3, the shell is not in it. |
| 13 | `generator` as `[tool, model, provider]`, empty strings for absent, when set (§9.3). Exactly three strings; anything else is `LINK_DAMAGED`. All three empty means no `generator`. |

An entry MAY be elided only when it is the sealed shell, the kit, or the
engine and its glue — the things a host has of its own. The manifest is not
carried: a reader recomputes the digest of every carried entry, takes the
digest of every elided one from the link, rebuilds the manifest and the COSE
envelope (protected header `alg: ES256`, `kid` the key's fingerprint) and
verifies by §7. Each elided entry MUST be rebuilt by the host and MUST match
the digest the link named before it is used for anything; a mismatch is
`LINK_UNRECONSTRUCTABLE` and the document does not run. Nothing a link says
about its bytes is believed: the digests are recomputed and the signature is
checked over them.

A sender MUST NOT elide an entry it cannot itself rebuild to the sealed digest,
so a link is never made that the same software could not open. When sender and
receiver hold the same host, the unpacked file is byte for byte the one the
complete build produced.

A reader MUST refuse a fragment it cannot decode rather than acting on part of
one, and SHOULD say that the link was probably cut in transit — chat clients
linkify up to a length and mail wraps long lines, so a link carrying a document
is a link that can arrive half-present.

A sender SHOULD cap what it will put in a link and MUST NOT emit one over its
cap, because a link cut in transit arrives as a document that will not open and
nothing to say why. No cap is normative: what truncates a long link is
everything between the two people, not the format.

**The reference link.** An address that names a document rather than carrying
it, for documents too large for the fragment:

```
<opener>/d/<id>#h=<sha256>&k=<key>
<opener>/#h=<sha256>&u=<url>&k=<key>
```

The document is sealed with AES-256-GCM under a fresh 256-bit key. The stored
blob is the 12-byte IV followed by the ciphertext and tag; `h` is the SHA-256
of that blob, hex; `k` is the key, base64url without padding; `id` is `h`. The
first form names a store the opener knows; the second names any URL, so a
store needs nothing from anyone but a bucket that serves files. Both keep the
key in the fragment, which a browser never sends, so the store holds
ciphertext it cannot read under a name it cannot connect to a link.

A reader MUST compare the blob's digest with `h` before importing the key, and
MUST refuse a mismatch as `BLOB_MISMATCH` without decrypting. A key that does
not open the blob is `BLOB_UNDECRYPTABLE`. What decrypts is a container in the
viewer form, and MUST be verified by §7 as though it were a file.

A store is three operations — `put(hash, blob, sidecar)`, `get(href)`,
`head(href)` — and a conforming store holds only what it can check is a
document: the sidecar's manifest signature verifies under the key it names,
and the blob is the size the sidecar states. A blob is at most 5 MB. Beside
each blob the store keeps a sidecar in the clear — manifest, name, icon — for
the parts of the world that cannot open the document and only need to know
what it is called. A store MUST serve blobs with `Access-Control-Allow-Origin:
*`, an immutable `Cache-Control`, and `Content-Type: application/octet-stream`.

Nothing about a carrier is recorded in a document. A document that travelled as
a link and a document that arrived as a file are the same bytes and the same
document, and an implementation MUST NOT treat them differently.

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

### 2.1 Entry names

Three names in the payload archive are fixed, because a reader has to find them
before it has anything to read:

| Entry | What it is |
|---|---|
| `runtime/container.html` | The sealed copy of the shell (§7 step 4) |
| `runtime/manifest.json` | The manifest (§3), in the viewer form |
| `document.sqlite` | The database, in the viewer form |

In the sectioned form the manifest is §1 and the database is §3; neither appears
in the archive. Everything else in the archive is the application, and its names
are the publisher's business.

### 2.2 Identifying the form

A reader MUST treat bytes beginning with the four magic bytes as the sectioned
form. Anything else is parsed as the viewer form.

### 2.3 What a reader can establish cheaply

The footer sits at a fixed distance from the end. A reader MAY establish that a
file is structurally intact and current by reading the header, the section table
and the last 64 bytes — without reading the sections themselves. It MUST NOT
report a container as verified on that basis alone; §7 defines verification.

---

## 3. The manifest

This section describes `manifestVersion: 2`. Version 3 changes what the
signature covers and adds fields; the differences are in §9, which wins for
version 3.

JSON, UTF-8, in §1 of the sectioned form and at `runtime/manifest.json` in the
viewer form's payload.

```jsonc
{
  "manifestVersion": 2,
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
  "signature": "…",             // base64 COSE_Sign1 (§3.1)
  "validUntil": 1234567890,     // optional, Unix seconds
  "publisherName": "Acme Finance", // optional; the name the publisher signs under
  "supersedes": "<uuid>"          // optional; the document this one replaces (§5.1)
}
```

`integrityPolicy` here is informational. The shell decides whether verification
is enforced, and a reader MUST take the policy from the shell rather than from
the manifest — a policy stored inside the archive it governs could be switched
off by the same edit that alters the archive.

The shell carries both in meta elements:

```html
<meta name="dai-integrity" content="required">
<meta name="dai-public-key" content="…">   <!-- base64 SPKI, P-256 -->
```

`dai-public-key` is the key §7 step 6 verifies against. Absent or empty means
the container carries no publisher key, and a signature that cannot be checked
MUST NOT be reported as an absent one: `unverifiable` and `unsigned` are
different answers, and collapsing them launders a claim nobody checked.

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
publisherName      — present only when set
supersedes         — present only when set
```

Keys MUST be sorted by their encoded bytes, lengths MUST use the shortest form
that fits, and indefinite lengths MUST NOT be used. Two encoders that agree on
the values and disagree on the bytes produce signatures that do not verify.

`validUntil` MUST be omitted entirely when unset, not encoded as null or zero.
So MUST `supersedes` when the document replaces nothing, and so MUST
`publisherName` when the publisher gave none: it joined the signed set
after containers existed, and its absence is what keeps every earlier signature
verifying. A name is a claim the key makes about itself and nothing more. A
host MUST NOT present it as verified; what a host can establish is whether it
has seen this key before, and under what name — which is how a host shows it.

Every other field in that list is always present in the payload. Where the
manifest omits an optional one — `favicon`, `signatureAlgorithm`,
`publicKeyFingerprint` — the payload MUST carry the empty string in its place,
not omit it and not encode null. A verifier that guesses differently rebuilds
different bytes and rejects every signature ever made, with nothing to say why.

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
verifying the signature, in **both directions**, and MUST refuse where they
disagree:

1. every entry in `signedEntries` MUST appear in `hashes` with the same
   digest — otherwise a signature could be validated over digests other than
   the ones just checked;
2. every entry in `hashes` other than the database MUST appear in
   `signedEntries` — otherwise an entry can be *added*, to the archive and to
   `hashes` with a matching digest, without touching the signed list or the
   signature. Integrity passes, the signature passes, and the addition runs
   under the publisher's badge. `runtime/schema.json` added this way has its
   migration SQL executed by a conforming host.

`hashes` is outside the signature and MUST be treated as untrusted; at mount,
`signedEntries` is the authority over what the application contains. The
conformance cases `signed-extra-entry` and `signed-schema-injected` are the
second direction.

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

When rewriting references so they resolve inside the frame, an implementation
MUST rewrite only module specifiers — the quoted string after `from`, in a bare
`import`, inside `import()`, and as the first argument of `new URL(…,
import.meta.url)` — and MUST leave every other byte of a script as it was
sealed. A rewrite that touches string literals, comments or regular expressions
executes bytes other than the ones that were signed.

#### The shell frame

A host that embeds a shell — the outer document carrying the bootloader — in
a frame of its own is embedding the bootloader, not the application. That
frame is a second layer, outside the boundary this section defines. It MAY
grant `allow-same-origin` where the host's own storage or bridge needs it, and
`allow-downloads` where the shell's export fallback needs it. It MUST NOT grant
`allow-popups`, which the shell has no use for and which is an exfiltration
channel no policy governs, and SHOULD NOT grant `allow-modals`.

Because that frame shares the host's origin, **a host MUST NOT execute the
container's own shell.** The sealed shell is verified only against its own
sealed copy, which proves the publisher wrote it and nothing more; a hostile
publisher's bootloader would run with the host's origin, storage and keys in
reach. A host MUST assemble a shell of its own — from the template and
bootloader it ships — around the archive it has verified, and mount that. The
container's `runtime/container.html` remains in the archive, checked and
inert. A host-built shell carries `<meta name="dai-shell" content="host">`.
The container's own shell is executed only where there is no host: the
`file://` double-click path.

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

A host MUST say what it applied. The handshake acknowledgement (§4.5) carries
`applied`: the list of §4 clauses the host holds, named by the probe's check
ids — `origin`, `shell`, `popup`, `network`, `socket`, `evaluation`, `inline`,
`handler`, `storage`. The claim is not evidence and MUST NOT be acted on by
the container; it exists to be checked. A conforming host mounts the probe in
itself and every clause it claimed comes back blocked. A host that claims a
clause the probe finds open, or a clause the probe cannot check, is not
conforming. A host MAY hold more than it claims.

The shell MUST pass the probe's report up to the window that hosts it, with
the host's claim attached, so a harness outside the container can hold the one
against the other.

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

More generally, **every message either side acts on MUST be bound to the window
it can only have come from.** A shell MUST ignore anything but
`DAI_HOST_HANDSHAKE_ACK` unless `event.source` is the frame it mounted, and
MUST ignore that one unless the source is its own parent. An application MUST
ignore a schema verdict, a save result or a host-state push whose source is not
its parent. A page that opens a container keeps a handle to it and to the
frames inside it; without these checks it can ask for a save nobody requested,
answer a question about whether somebody's data may be overwritten, or report
that boundaries held when it never tested them.

The shell MUST answer only one hello. The buffers are transferred and therefore
detached after the first reply.

### 4.5 Talking to a host

A container announces itself to the window it is embedded in, and everything
that follows — a save, a refusal — is a message that window acts on.

The container MUST invent an unpredictable value at boot and send it with its
first message. A host MUST echo that value on its acknowledgement, and the
container MUST NOT treat a host as present unless the acknowledgement came from
its own parent and carried the value back. Every later message the container
sends MUST carry it, and a host MUST ignore one that does not.

This does not authenticate a host. An embedder can echo a value as easily as an
honest host, and a container has no way to know which it is talking to. What it
establishes is that a message came from the party the handshake completed with,
rather than from a third window holding a reference — which is what stops an
uninvolved page announcing itself as a host, receiving a document's data, or
telling an application its work was written to disk.

### 4.6 Host classes

Not every host can write a document in place. A browser has no filesystem to
write back to outside one engine's picker; a native host has. Rather than let
every host claim the same thing, a host declares which of two classes it is
when it answers the handshake, as `hostClass` on the acknowledgement:

- **`viewer`** — verifies, mounts, keeps a copy of the database on the device,
  and can export a file. It MUST NOT report a save as having written the
  document it was given. This is what a browser opener is.
- **`editor`** — writes the document in place under §5's lock and generation
  check. This is what a native host is.

A host that omits `hostClass` MUST be treated as a viewer. The container MUST
report the class's consequence to the application on every save the host
handled, as `inPlace`, so an application can say "saved" or "saved a copy"
truthfully. A site or document describing a viewer MUST NOT say it saves in
place.

---

## 5. Saving

A save in the sectioned form MUST rewrite only §3 and the footer, MUST leave §1
and §2 byte-identical, and MUST increment `generation`.

This is what allows a document to be saved by somebody holding no key: the
publisher's signature covers the manifest, the manifest is untouched, and the
signature therefore still holds.

A host that has seen a later generation for a document MAY treat an earlier one
as a rollback.

A host that read a document at one generation and is asked to save on top of a
different one MUST refuse with `GENERATION_CONFLICT`, and MUST NOT present the
refusal as a failure of the application: another window saved first, and the
work in hand is still in hand.

The generation check detects a lost update; it does not prevent one. An
editing host MUST therefore hold an exclusive lock over the document for the
whole of a save — from reading the current generation to flushing the footer —
and MUST keep the generation check inside the lock as the backstop for a host
that took none. A browser host takes a Web Lock keyed on the document's
identity; a native host takes an OS advisory lock on the file. A host that
cannot obtain the lock MUST refuse with `LOCK_UNAVAILABLE` rather than wait
indefinitely or proceed, and MUST NOT present that as a failure of the
application either. Both codes are recoverable: the person's work is still in
hand, and the save can be asked for again.

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

### 5.1 Succession

A document MAY name the document it replaces in `supersedes`. A host that holds
data for the named document MAY start the new document from that data, so that
the next version of an application is the same application with the same
records rather than a stranger with an empty database. Three rules make that
safe rather than a way to walk off with somebody's data:

- A host MUST adopt only when the new document is signed and its key is the
  key the host pinned for the document it names. An unsigned document, or one
  under another key, is not honoured, and the host SHOULD say so.
- The data is *copied*, never moved. The named document and its data stay as
  they were, so a successor that turns out to be wrong has cost nothing.
- The adopted data passes through the new document's schema gate (§6.3)
  exactly as its own would: migrated where a chain reaches, refused as
  `SCHEMA_INCOMPATIBLE` where none does. A host MUST surface that refusal.
  Silent loss — a successor that opens empty over data it could not read —
  is the failure this section exists to prevent.

A compiler that is told which container a build upgrades MUST record it here,
since it already holds the identity; a build that changed the schema with no
migration to match is refused before it is signed.

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

### 6.1 Substituting a runtime

**A container MUST carry its runtime. A host MAY substitute its own copy of any
runtime entry whose digest it already holds.**

The first sentence is the property everything else rests on: a file that arrives
on a machine with nothing installed still runs, because the engine came with it.
Nothing a host does may erode that, and a container that expects a host to
supply an engine is not a container.

The second is what a host is allowed to do about the cost. The engine is the
largest thing in most containers by an order of magnitude — roughly 850 kB
against 60 kB for everything else — and a host that has already loaded that
exact engine, byte for byte, gains nothing by loading the copy in the file.
Substitution is permitted only on an exact digest match against an entry the
manifest covers, so it can change nothing about what runs.

A host MUST NOT substitute an entry whose digest it does not hold, MUST NOT
treat a substitution as satisfying the entry check in §7, and MUST verify the
container exactly as though it had loaded every byte.

Substitution is not a saving in time — measurement says the engine is compiled
after the application is on screen, because an application asks for its
database once it has painted. It is a saving in what has to travel, which is
what §6.2 is built on: a container that need not carry an engine can be small
enough to be a link. See [performance.md](performance.md).

### 6.2 Containers published without an engine

A container MAY be published without the engine and its glue, for a host that
already holds those exact bytes. Nothing else may be left out.

The manifest does not change. Every entry is listed with its digest, including
the ones whose bytes are absent, and the signature is the one the complete
build carries — the two forms are one build, not two, and a reader can check
that by completing one and comparing it with the other. Only bytes are absent.

The entries that MAY be absent are exactly:

```
runtime/sqlite3.wasm
runtime/sqlite3.mjs
```

**By name, and no others.** A reader has to be able to tell a container
published this way from one somebody removed an entry from, and the names are
all it has: nothing marks the form, because a mark would be a claim the file
makes about itself and this is a fact about the file. An entry absent from the
archive and listed in the manifest is a container to be completed when it is
one of those two, and damage otherwise — reported as `DIGEST_MISMATCH` like any
other missing entry. A build that renames its engine cannot use this form.

A host completing a container:

- MUST match on digest, never on name. The bytes it supplies are bytes it
  already held, and it puts them only where the manifest says those exact bytes
  belong, so completing one can change nothing about what runs.
- MUST then verify the container by §7 exactly as though every byte had
  arrived in the file. A supplied entry satisfies nothing on its own; it is
  hashed against the manifest with everything else.
- MUST refuse with `RUNTIME_UNAVAILABLE` when it cannot supply what is absent,
  and MUST NOT report that as modification. Nothing was modified: the file
  arrived as published, and this host is not one it can run on.

This is not the default and MUST NOT be presented as one. A container published
this way is not portable in the sense the rest of this document means, and the
difference has to be visible to whoever is handed one.

#### Completing one

A host MAY write out the complete form, and the result MUST be the file the
complete build produced, byte for byte. Two things make that reachable: zip
entries carry a fixed timestamp rather than the clock (§2), and the order the
compiler wrote them in is recoverable from the manifest — `hashes` is filled
entry by entry as the archive is assembled, so its keys are the archive's
order, with the manifest, which cannot hash itself, absent from the end.

The compression level is the compiler's default. A build that changes it
cannot use this form, because the bytes could not be reproduced.

### 6.3 Declared schemas

A container MAY declare the shape of the data its application expects, at
`runtime/schema.json` — an ordinary entry, so the digests and the signature
cover it like any other.

```jsonc
{
  "digest": "…",            // SHA-256 of the normalised schema
  "migrations": [
    { "version": 1, "from": "…", "to": "…", "sql": "…" }
  ]
}
```

A database records what last wrote it in a table named `_dai_meta`, as the row
`('schema', <digest>)`.

Where a container declares a schema, a host MUST reconcile the two before the
application is given a handle to the database:

- **Equal digests.** Open.
- **No recorded digest.** Stamp the declared one and open. A database with no
  record is one written before the application declared a schema, and refusing
  it would discard data over a row that was never written.
- **A migration chain from the recorded digest to the declared one.** Run it in
  a single transaction, stamp, and open. A chain that stops half way MUST be
  rolled back.
- **Anything else.** Refuse, and do not open the database.

There is no case in which a host opens a database it cannot account for. SQLite
does not object to a schema mismatch — it creates what is missing, ignores what
it does not recognise, and reports nothing — so this is the only point at which
the disagreement is visible, and an application that never receives a handle
cannot write over data it does not understand.

A compiler MUST refuse to build a container whose declared schema differs from
the one it is replacing without a migration reaching the new digest. That is the
last moment the problem costs nothing.

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

   Two entries are exempt from the unlisted check, and only these two:
   `document.sqlite`, which is not signed and changes on every save, and
   `runtime/manifest.json`, which cannot appear in its own list of digests. A
   reader that treats them as unlisted refuses every valid container.
4. **Shell.** The shell matches the sealed copy at `runtime/container.html`.
   The live document carries the payload and the sealed copy carries
   `<!--DAI_PAYLOAD-->` in its place, so a reader MUST substitute the
   placeholder for the payload element's content before comparing — the two are
   otherwise never equal, and a reader that compares them as they stand refuses
   every valid container.

   In the sectioned form there is no live shell to compare against, and a
   comparison of the sealed copy with itself cannot fail. Its status there is
   the status of its own entry digest.
5. **Expiry.** `validUntil`, when present, has not passed.
6. **Signature.** When the shell carries a publisher key, the signature verifies
   over §3.1.

For `manifestVersion: 3`, step 3 takes its list from `signedEntries` when the
container is signed, and the shell is exempt from it; see §9.2. A version a
reader does not know is refused before step 1 (§9.1).

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

### 7.2 Refusals

An implementation that refuses MUST say why with one of these names, so that
two implementations can be held to the same answer about the same file. The
conformance suite states the name for every refused case, and a reader is
conforming only if it emits that name.

The bootloader's names came first and are read by hosts over the bridge, so
they are kept; the reader-only names sit beside them. `recoverable` means the
person's work is still in hand.

| Code | Recoverable | Means |
|---|---|---|
| `NO_PAYLOAD` | no | No payload: probably not a container |
| `PAYLOAD_UNREADABLE` | no | The payload did not decode or unzip |
| `MANIFEST_MISSING` | no | No manifest, so nothing can be verified |
| `MANIFEST_UNREADABLE` | no | The manifest is not valid JSON |
| `UNSUPPORTED_ALGORITHM` | no | A digest algorithm this reader does not implement |
| `UNSUPPORTED_CRYPTO` | no | No WebCrypto: not a secure context |
| `SECTION_MISSING` | no | A required section is absent; the file is incomplete |
| `DIGEST_MISMATCH` | no | An entry does not match its digest, is missing, or is unlisted |
| `SECTION_MISMATCH` | no | The manifest or application section does not match its digest |
| `DATA_DAMAGED` | no | Only the database disagrees with its record: an interrupted save; the application is intact |
| `SHELL_MISSING` | no | No sealed copy of the shell |
| `SHELL_MISMATCH` | no | The shell does not match the sealed copy inside it |
| `SIGNATURE_UNVERIFIABLE` | no | A publisher key is present but there is nothing usable to check |
| `SIGNATURE_UNSUPPORTED` | no | A signature format this reader does not implement |
| `SIGNED_SET_MISMATCH` | no | The signed list and the digest list disagree, in either direction (§3.1) |
| `UNVERIFIED_SIGNATURE` | no | The signature does not verify against the key the file carries |
| `KEY_EXPIRED` | no | The expiry has passed |
| `PUBLISHER_MISMATCH` | no | Signed by a different key than the host pinned for this document |
| `NO_APPLICATION` | no | Verified, but no `index.html` to run |
| `SCHEMA_INCOMPATIBLE` | no | The data's shape is not one the application declared and no migration reaches it |
| `SCHEMA_AHEAD` | yes | The data is newer than the application; a host MUST NOT migrate backwards |
| `GENERATION_CONFLICT` | yes | Another window saved first (§5) |
| `LOCK_UNAVAILABLE` | yes | Another program is saving now (§5) |
| `MOUNT_TIMEOUT` | no | The application never reported that it started |
| `BOOT_FAILED` | no | The bootloader threw |
| `HOST_REFUSED` | no | The host declined for a reason of its own; see the message |

When more than one applies, an implementation MUST report the first in this
order: unsupported crypto or algorithm; a section that is missing, damaged or
mismatched; an entry; the shell; expiry; the signature. A section digest covers
every byte of a section and an entry digest only what unzipped out of one, so
the section is the more precise account when both fail.

A refusal SHOULD also carry the document's identity and generation when they
could be read, so a host can say which document, and which save of it.

---

## 8. What this format does not address

Stated plainly, because a specification that omits its limits is worse than one
that has them.

**Who a publisher is.** A signature proves the file has not changed since it was
signed by whoever holds the key it carries. It does not say who that is: a
container is self-contained, so an attacker can substitute the key and re-sign.
Identity requires something from outside the file — a key pinned on first use, a
directory, a transparency log. Version 3 (§9) gives a container a place to
carry such a proof and a host the rules for what it may say about one; it does
not change this limit.

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

---

## 9. manifestVersion 3

One deliberate change to the identity model, made before a second independent
implementation exists, so that no reader ever has to carry two. Everything in
this section is normative for `manifestVersion: 3`. Where it differs from the
sections above, this section wins for version 3; the sections above remain the
description of version 2.

### 9.1 Versions a reader accepts

A reader MUST accept `manifestVersion` 2 and 3, and MUST refuse any other value
with `UNSUPPORTED_MANIFEST_VERSION` and a message telling the person to update
the host — not a generic failure, because the file is not damaged and the
person can do something about it.

A version 2 container is verified by the rules of §7 with one correction that
was always a reader bug and never a format rule: every digested entry other
than `document.sqlite` MUST be in `signedEntries` when a signature is present
(§3.1). "Version 2 remains verified" does not mean "version 2 keeps the hole".

### 9.2 The signed set

Two mandatory changes. A compiler MUST apply both to emit version 3; a reader
MUST require both of a version 3 container.

**The shell leaves the signed set.** `signedEntries` MUST NOT contain
`runtime/container.html`. The sealed shell MUST stay in the archive and MUST be
listed in `hashes` — a version 3 manifest whose `hashes` omits it is refused as
`SHELL_MISSING`, because there is then no digest to hold the shell to — and §7
step 4 still compares the live shell with it: that is an
integrity check on an unsigned part, which is what the shell always was — the
viewer form's top document is self-attesting (§8) whether or not a digest of it
was signed. What changes is that a host with its own shell (§4.4) no longer
has to reproduce the publisher's byte for byte to verify a signature, and a
compiler's template can change without every signature it ever made becoming
uncheckable.

**`signedEntries` is the sole authority.** When a container is signed, a reader
MUST take the set of entries and their digests from `signedEntries`, and MUST
refuse with `DIGEST_MISMATCH` any archive entry that is neither listed there
nor one of the three exemptions: `document.sqlite`, `runtime/manifest.json`,
and `runtime/container.html`. `hashes` MAY be present; where it lists an entry
that `signedEntries` also lists, the two MUST agree, and a disagreement is
`SIGNED_SET_MISMATCH`. An entry that `hashes` lists, `signedEntries` does not,
and the archive does not carry is noise: a reader MUST ignore it, since the
archive rule above already refuses the case where the bytes are present. When
a container is unsigned, `hashes` is the list, as in version 2.

### 9.3 Fields

All of the following are OPTIONAL. A version 3 manifest carrying none of them
is valid; only §9.2 is required to emit version 3.

| field | in the signed set | meaning |
|---|---|---|
| `publisherName` | yes | The name the publisher signs under. A claim the key makes about itself; a host MUST NOT present it as verified. |
| `supersedes` | yes | The document this one replaces (§5.1). Honoured only under the same key. |
| `generator` | yes | `{ "tool": string, "model"?: string, "provider"?: string }`. What produced the application. Asserted, never verified, and never the prompt. Exactly these three keys: a writer MUST NOT add others, and a reader signs only these, so an extra key would be an unsigned field wearing a signed name. Version 3 only; a version 2 manifest carrying one has it outside the signed set. |
| `identity` | **no** | A Sigstore bundle binding the signing key to an identity (§9.5). Outside the signed set because its transparency-log entry records the signature, which covers the manifest; a field that contains a proof of the signature cannot itself be signed by it. |

The signed bytes (§3.1) gain the signed fields in this order after `entries`,
each present only when set: `validUntil`, `publisherName`, `supersedes`,
`generator` (a CBOR map with the keys `tool`, `model`, `provider`, each present
only when set). A field that is absent from the manifest MUST be absent from
the signed bytes; a reader that encodes an absent one as null or the empty
string rebuilds different bytes and rejects every signature ever made.

### 9.4 The envelope, and who else may sign

The signature is an **untagged** `COSE_Sign1` (RFC 9052 §4.2), detached
payload. A writer MUST NOT emit CBOR tag 18 around it. A reader MUST accept an
envelope with tag 18 as well, because standard COSE libraries emit one and a
reader that refused it would refuse a correct signature over a correct
container. Any other tag is `SIGNATURE_UNSUPPORTED`.

A countersignature slot exists whether or not anything is in it. The
`COSE_Sign1` unprotected header MAY carry label **11** (`countersignature`,
RFC 9338 §3) holding one `COSE_Countersignature` or an array of them. Each is
computed over the version 2 countersignature structure of RFC 9338 §3.3:

```
Countersign_structure = [
  context:        "CounterSignatureV2",
  body_protected: <the publisher's protected header bytes>,
  sign_protected: <the countersigner's protected header bytes>,
  external_aad:   h'',
  payload:        <the signed bytes of §3.1>,
  other_fields:   [ <the publisher's signature bytes> ]
]
```

The countersigner's protected header MUST carry `alg` (ES256 is the only
algorithm this version requires) and `kid`, a byte string naming the key. A
host verifies a countersignature only against keys it already holds (§9.6,
roots); one it cannot verify is treated as absent — never as verified, and
never as a refusal. A countersignature that verifies against a held key is
reported to the person as what it is: a second party who signed the same
document. Its meaning is that party's to define.

A host reports countersignatures only on a document whose publisher signature
verified; a document that fails §7 is refused before anybody asks who else
signed it. A label 11 value that is not a three-element array or an array of
them, or a countersignature whose `kid` is not a byte string, is reported as
one invalid countersignature with an empty kid. Wherever this document writes a
kid as text — root lists, vectors, reports — it is the kid's bytes in lowercase
hex.

Because it is in the unprotected header, adding or removing a countersignature
changes no signed byte and no digest. The manifest's `signature` field is the
base64 of the whole envelope, countersignatures included.

### 9.5 Identity

A signature proves a key. `identity` binds the key to a name somebody else
vouched for, in a way an offline reader can check.

The principle: the publisher is online at build time; the recipient may be
offline at open time. Every network-dependent step therefore happens at build,
and the artifact carries a proof that verifies against a root the host already
holds. A host MUST NOT fetch anything to verify an identity, and MUST hold its
trust roots in the host itself, refreshed with the host.

`identity` is a Sigstore bundle (the `application/vnd.dev.sigstore.bundle`
JSON form, version 0.3 or later), obtained at build by signing in to an OpenID
provider, having a Fulcio instance issue a short-lived certificate binding that
identity to **the publisher's own signing key**, and logging the manifest
signature to a Rekor instance. The bundle carries the certificate chain, the
log entry with its signed timestamp, and nothing about the document that is
not already in the manifest.

A reader consults these bundle fields and no others: the leaf certificate,
`verificationMaterial.certificate.rawBytes` or the first entry of
`verificationMaterial.x509CertificateChain.certificates` (DER, base64), with
any further chain entries as intermediates; the first of
`verificationMaterial.tlogEntries`, taking `logIndex`, `logId.keyId` (the
base64 SHA-256 of the log's public key), `integratedTime`,
`inclusionPromise.signedEntryTimestamp` (a DER ECDSA signature, base64) and
`canonicalizedBody`; and, as the logged signature, `spec.signature.content`
inside the decoded `canonicalizedBody` (a `hashedrekord`), or failing that
`messageSignature.signature`. The signed entry timestamp is verified over the
RFC 8785 canonical JSON of `{"body", "integratedTime", "logID", "logIndex"}`,
where `body` is the base64 canonicalized body as carried, `integratedTime` and
`logIndex` are JSON numbers — the bundle carries both as decimal strings, in
the protobuf JSON form, and a reader converts them — and `logID` is the log
key's SHA-256 in lowercase hex.
The identity shown is the leaf's first subject alternative name (an
rfc822Name or a URI), and the issuer is Fulcio's extension
1.3.6.1.4.1.57264.1.8 (a DER UTF8String) or, failing that, 1.3.6.1.4.1.57264.1.1.

A host holding a root for the bundle's Fulcio and Rekor MUST check, offline:

1. the certificate chains to a Fulcio root the host holds;
2. the certificate's subject public key equals the manifest's key (the SPKI
   in the shell, §3);
3. the log entry's signed timestamp verifies against a Rekor key the host
   holds, and its time lies within the certificate's validity;
4. the logged signature equals the manifest's `signature` bytes.

Any failure, and a bundle whose roots the host does not hold, MUST be treated
as **absent**: the document is then trusted by continuity alone (§9.6), and the
host MUST NOT show the identity. Identity never causes a refusal; a document
with a broken binding is a document with no binding.

The identity a host shows is the certificate's subject identity (a GitHub
handle, an email, an issuer-scoped claim), and the host SHOULD show the issuer
beside it. Three roots are anticipated and all use this one verifier: the
public Sigstore instance, whose log is public — a publisher choosing it is
choosing to be listed, and SHOULD use a handle rather than an email; a
self-hosted Fulcio and Rekor, whose roots arrive by the root list of §9.6; and
a countersigner of §9.4 whose key the host holds.

The inline carrier (§1.1) omits `identity` and countersignatures. A bundle is
most of a small link's budget, and continuity carries the binding forward: once
a key is bound on this device, every later document under it shows the
identity by being KNOWN.

### 9.6 What a host remembers, and what it may say

A conforming host keeps two stores.

**Documents:** `documentUuid → SPKI` (or "unsigned"), recorded on first
sighting and never replaced by opening a file (§4.5 rollback and generation
need it, and so does `supersedes`).

**Keys:** `SPKI → { firstSeen, documentCount, lastAssertedName, hostLabel,
identity? }`. `hostLabel` is a name the person gave this key on this device.
It is local, MUST NOT be exported or carried in any document, and MUST take
precedence over `lastAssertedName` wherever a name is displayed.

A host MUST distinguish three trust states for a signed document, and MUST NOT
present any of them with the word "verified":

- **KNOWN** — the key is in the key store, or in a root list (below).
- **NEW** — the key is unseen and the asserted name collides with nothing.
- **CONFLICT** — by one of three rules, named `document`, `mixed-script` and
  `skeleton` in reports and vectors: the document's UUID is in the document
  store under a different key; or the key is unseen and the asserted name
  collides with a name in the key store, a host label, or a root list entry,
  by either collision rule below. A host MUST show a
  conflict as a warning and MUST NOT offer to install, pin, or adopt data on
  that open.

A name collides when either rule fires:

1. **Mixed script.** After NFKC and case folding, any single whitespace-
   separated token of the asserted name contains letters from more than one
   script (Latin and Cyrillic, Latin and Greek, and so on) is a conflict by
   itself. No table is needed; a name that needs two alphabets to spell one
   word is not a name.
2. **Skeleton match.** `skeleton(name)` equals `skeleton(other)` for any name
   the host holds, where `skeleton` is NFKC → case fold → remove whitespace and
   punctuation (Unicode categories Z and P) → the UTS #39 §4 confusable
   skeleton, computed with Unicode 16.0 data or later.

A host SHOULD store the skeleton beside each name at pin time, so a first
sighting is one comparison per stored name, and recompute them when its table
changes. The conformance vectors of §9.7 are normative; the table is not, and a
host MAY use newer Unicode data.

**Root lists.** An organisation MAY provision keys a host is to treat as KNOWN
without a first sighting, and roots for §9.4 and §9.5. The file is JSON:

```json
{
  "formatVersion": 1,
  "name": "Acme Corp publishers",
  "publishers": [
    { "spki": "<base64 SPKI>", "name": "Acme Finance", "org": "Acme Corp" }
  ],
  "countersigners": [
    { "kid": "<kid bytes, lowercase hex>", "spki": "<base64 SPKI>", "name": "Acme release signer" }
  ],
  "sigstore": [
    { "name": "Acme Fulcio", "fulcioRoots": ["<PEM>"], "rekorKeys": ["<base64 SPKI>"] }
  ]
}
```

How a host obtains a root list — MDM, a config directory, a setting — is
outside this specification. A root list entry's `name` is a host label for
that key.

### 9.7 Conformance

The suite gains, in addition to the version 2 cases, which remain:

- **version-3-minimal** — a version 3 container with no optional field;
  mounts.
- **version-3-shell-unsigned** — `signedEntries` omitting the shell, as
  required; mounts. And **version-3-shell-listed** — a version 3 container
  whose `signedEntries` lists the shell; refused, `SIGNED_SET_MISMATCH`.
- **version-2-signed-extra-entry** — an entry added to a version 2 container
  and to `hashes` but not to `signedEntries`; refused, `SIGNED_SET_MISMATCH`.
- **version-4** — `manifestVersion: 4`; refused,
  `UNSUPPORTED_MANIFEST_VERSION`.
- **envelope-tagged** — the same valid signature wrapped in tag 18; verifies.
- **countersignature-valid** — a countersignature under the suite's second
  key; reported present and valid when that key is held, absent when it is not.
- **trust-vectors.json** — a sequence of signed containers with the state a
  host MUST reach after each, starting from an empty key store and recording
  each one marked to be recorded: same key, second document → KNOWN with a
  count of one; a Cyrillic а inside a Latin word → CONFLICT (mixed script);
  whole-script Cyrillic "Асе Ѕрасе" against a pinned Latin "Ace Space" →
  CONFLICT (skeleton) — chosen because every letter of it is a UTS #39
  prototype of a Latin one, which is not true of "Асме" for "Acme", where
  Cyrillic м is not a confusable of m; a fullwidth variant → CONFLICT (NFKC);
  an all-CJK name against every pinned name → NEW; and the first document
  again under the stranger's key → CONFLICT (document). Every other step is
  its own document: the vectors carry distinct UUIDs, because the same UUID
  under two keys is rule 3's conflict by definition. The table the vectors
  were computed with is `confusables.json` beside them.
- **identity-vectors.json** — a bundle that verifies against the suite's test
  root → identity shown; timestamp outside the certificate window, certificate
  key not the manifest's key, root not held → absent, never a refusal.
