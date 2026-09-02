# IANA media type registration — draft

Status: **draft, not submitted.** Read the blocking issue below before sending
anything to IANA.

---

## Blocking issue: `+html` is not a registered suffix

The requested name, `application/vnd.dai+html`, cannot be registered as written.

RFC 6838 §4.2.8 permits a `+suffix` only when that suffix appears in IANA's
*Structured Syntax Suffixes* registry. That registry contains `+xml`, `+json`,
`+ber`, `+der`, `+fastinfoset`, `+wbxml`, `+zip`, `+cbor`, `+jwt`, `+sqlite3`,
`+tlv`, `+gzip`, `+yaml` and a handful of others. **`+html` is not among them.**
A registration using it would be rejected, or would first require registering
`+html` itself — a separate submission needing a specification that defines the
generic HTML-based syntax and how a parser should treat it.

Three ways forward:

1. **`application/vnd.dai`** — no suffix, valid today, one submission. What this
   draft uses.
2. **Register `+html` first**, then `application/vnd.dai+html`. Two submissions,
   the first of which is a general-purpose piece of standards work that outlives
   this project and invites scrutiny far beyond it.
3. **Don't register at all.** See the next section, which argues this is more
   defensible than it sounds.

## Second issue: this type must not be used when serving

A cartridge *is* an HTML document. A browser renders it because the server said
`text/html`. Serving one as `application/vnd.dai` makes the browser download it
instead of running it — which defeats the format.

So the media type has a narrower job than it first appears:

| Context | Type to use | Why |
|---|---|---|
| HTTP response for a cartridge to run in a browser | `text/html` | Anything else stops it rendering |
| Operating system file association | `application/vnd.dai` | The desktop host claims `.dai`, not all HTML |
| A file manager, an email attachment, a package index | `application/vnd.dai` | Identity, not execution |

Registering is still worth doing — the type is what lets a system distinguish a
cartridge from an arbitrary web page without opening it — but the registration
should say plainly that it is **not** the type to serve over HTTP for execution.
Reviewers will ask; the answer is better volunteered.

---

## Registration template (RFC 6838 §5.6)

Submit to `media-types@iana.org`, using the form at
<https://www.iana.org/form/media-types>. Vendor-tree registrations are reviewed
by the media types reviewer with a two-week comment period on the mailing list;
they do not require an RFC.

```
Type name: application

Subtype name: vnd.dai

Required parameters: N/A

Optional parameters: N/A

Encoding considerations:
  binary.

  A cartridge is an HTML document encoded in UTF-8, and is 8-bit clean text in
  practice. It is registered as binary because a single document routinely
  exceeds one megabyte and carries a base64 payload on one line; transports that
  fold long lines or rewrite line endings corrupt it. A corrupted cartridge does
  not degrade — it fails its own integrity check and refuses to run.

Security considerations:

  A cartridge is executable content. It contains an application, a WebAssembly
  build of SQLite, and its own bootloader, and opening one runs all three. It
  should be treated with the caution due to any downloaded program, not the
  caution due to a document.

  The format is designed to run without network access. Every cartridge carries
  a Content Security Policy in its own markup, including `connect-src 'none'`,
  which denies fetch, XHR, WebSocket, EventSource and beacon. `script-src` and
  `style-src` permit `blob:` sources, which are origin-local URLs minted from the
  embedded payload and cannot reach a remote host. A conforming implementation
  MUST NOT relax `connect-src`.

  Integrity is self-contained. `runtime/manifest.json` inside the payload carries
  a SHA-256 digest of every other entry, and verification is bidirectional: an
  entry present in the payload but absent from the manifest is a failure, or
  content could be appended freely. Verification MUST complete before any
  packaged code is executed.

  A cartridge cannot fully verify itself. Its integrity check runs inside its own
  bootloader, so an attacker who rewrites that bootloader is audited by the code
  they replaced. The payload therefore contains a sealed copy of the shell at
  `runtime/container.html`, which allows a *separate* reader — a desktop host, a
  player application — to compare the outer document against it. An
  implementation that opens a cartridge directly, with nothing outside it, cannot
  make this check.

  Signatures establish integrity, not identity. A cartridge may carry an ECDSA
  P-256 public key and a signature over its application and runtime entries. The
  signature proves the payload was signed by whoever holds the key *that the file
  itself carries*, and that nothing has changed since. It does not establish who
  that is: the file is self-contained, so an attacker may substitute the key and
  re-sign, producing a document that is internally consistent and verifies.
  Implementations MUST NOT present a valid signature as verified publisher
  identity. Establishing identity requires comparing the key fingerprint against
  a value obtained out of band, or remembering the key a document was first seen
  with.

  The mutable database is deliberately outside the signed set, because a
  cartridge rewrites its own database as it is used and carries no private key to
  re-sign with. Consumers MUST NOT infer that database contents are attested by
  the signature.

  Cartridges are large and self-modifying. A host that overwrites one in place
  destroys the previous contents; the data has no copy elsewhere.

Interoperability considerations:

  A cartridge is a valid HTML document and will render in any browser, which is
  the intended baseline. Features degrade rather than fail: an implementation
  that ignores the manifest still runs the application, and one that cannot
  verify a signature still runs an unsigned document. Implementations that skip
  verification are conforming readers of HTML but not conforming DAI hosts, and
  the distinction matters to a user deciding whether to trust what they opened.

  WebAssembly and, for verification, WebCrypto are required. WebCrypto is
  available only in secure contexts, so a cartridge served over plain HTTP from a
  non-loopback origin cannot verify itself.

Published specification:
  https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/spec-v0.1.md

Applications that use this media type:
  DAI Desktop (Tauri host), the DAI Runner (an installable web player), and
  general-purpose web browsers, which open cartridges directly from the
  filesystem.

Fragment identifier considerations:
  Identical to text/html: a fragment identifies an element within the rendered
  document. It does not address entries inside the payload, which are not
  URL-addressable from outside the document.

Restrictions on usage:
  Should not be used as the Content-Type of an HTTP response intended to be
  rendered by a browser; use text/html. See "when serving", above.

Additional information:
  Deprecated alias names for this type: N/A
  Magic number(s):
    Begins with the ASCII sequence "<!DOCTYPE html>". A cartridge is
    distinguished from an ordinary HTML document by the presence of an element
    matching:
      <script type="application/octet-stream" id="dai-payload">
    whose content is base64. The accompanying markers
      <meta name="dai-integrity" ...> and <meta name="dai-public-key" ...>
    appear in cartridges produced by the reference compiler.
  File extension(s): dai
  Macintosh file type code(s): TEXT

Person & email address to contact for further information:
  [NAME] <[EMAIL]>

Intended usage: COMMON

Author: Dynamic Application Interface

Change controller: Dynamic Application Interface
```

## Before submitting

- [ ] Decide between `application/vnd.dai` and registering `+html` first.
- [ ] Fill in a real contact name and address. IANA publishes it.
- [ ] Confirm the specification URL is stable. A moving `main` link is weak;
      a tag or a release asset is better.
- [ ] Be ready to answer why the format needs its own type when it is HTML. The
      answer is file identity for operating systems and tooling, and the
      registration should say so before a reviewer has to ask.
