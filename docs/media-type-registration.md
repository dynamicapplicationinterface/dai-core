# Media type registration: `application/vnd.dai`

A vendor-tree registration under RFC 6838 §3.2. It is a form, not a standard:
submit it at <https://www.iana.org/form/media-types>. IANA reviews vendor-tree
registrations lightly and usually answers within a few weeks. The `.dai.html`
viewer form is `text/html` by nature and is not registered.

Fill in the two bracketed fields and paste the rest as it stands.

---

**Type name:** application

**Subtype name:** vnd.dai

**Required parameters:** none

**Optional parameters:** none

**Encoding considerations:** binary. The file is a sectioned container: a
header, a section table, page-aligned sections holding a JSON manifest, a zip
archive of the application, and a SQLite database, and a 64-byte footer.

**Security considerations:** A DAI container carries executable content (an
HTML application) intended to run inside a host that applies the isolation in
the format's specification §4: an opaque-origin sandboxed frame with a Content
Security Policy that permits no network connection of any kind. A host that
does not apply that isolation MUST NOT execute the content. The manifest
carries SHA-256 digests of every entry and MAY carry an ECDSA P-256 signature
over them in a COSE_Sign1 envelope; a host MUST verify digests before running
anything and MUST verify the signature when a key is present. Verification
proves the file is unchanged since signing, not who signed it; the
specification §8 and §9.6 describe what a host may and may not claim about a
publisher. The container includes a SQLite database, which the application may
read and write; it includes no capability to reach the network, the filesystem
beyond the file itself, or other origins. The format does not use active
content in the manifest. Privacy: the file may contain personal data the
application stored; it contains no tracking, and the format specifies that a
host sends nothing on open.

**Interoperability considerations:** The format is versioned by
`manifestVersion` in the manifest. Readers accept versions 2 and 3 and refuse
others by name. A conformance suite and an independent reference reader in
Python are published with the specification.

**Published specification:** DAI Container Format v0.2, §2 (the sectioned
form) and §9 (manifestVersion 3):
<https://github.com/dynamicapplicationinterface/dai-core/blob/main/docs/spec-v0.2.md>

**Applications that use this media type:** The DAI opener
(<https://opendai.app>), the DAI desktop application, and the `dai` command
line tool; any host implementing the specification.

**Fragment identifier considerations:** none.

**Additional information:**

- Deprecated alias names for this type: none
- Magic number(s): the first four bytes are `DAI1` (0x44 0x41 0x49 0x31)
- File extension(s): `.dai`
- Macintosh file type code(s): none

**Person & email address to contact for further information:** [name],
[email]

**Intended usage:** COMMON

**Restrictions on usage:** none

**Author:** [name]

**Change controller:** [name / organisation]

**Provisional registration?** No
