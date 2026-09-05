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

**The reference link.** Reserved. An address that names a document rather than
carrying it, for documents too large for the fragment. The grammar is not
frozen here and no implementation should assume one.

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
  "validUntil": 1234567890      // optional, Unix seconds
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
```

Keys MUST be sorted by their encoded bytes, lengths MUST use the shortest form
that fits, and indefinite lengths MUST NOT be used. Two encoders that agree on
the values and disagree on the bytes produce signatures that do not verify.

`validUntil` MUST be omitted entirely when unset, not encoded as null or zero.

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
