# Wikidata entry — proposed schema

Status: **draft, and not yet notable.** Creating this item today would most
likely see it deleted; the schema is prepared so it can be filed the moment the
criterion is met.

---

## Notability, first

Wikidata's notability policy (WD:N) admits an item on any of three grounds. The
relevant one here is the second: the item must be **a clearly identifiable
conceptual or material entity described by at least one serious and publicly
available reference**, where the reference must not be the subject's own
material. A project's own repository, documentation and website are all the
subject's own material.

DAI has none of that today. An item created now would be nominated for deletion,
and a deleted item makes a later, better-supported submission harder rather than
easier.

What would satisfy it, in rough order of attainability:

- Coverage in a technical publication, trade press, or a conference proceeding
  that is not written by the project.
- An IANA media type registration. This is a serious, publicly available
  reference maintained by a third party, and it is the strongest reason to do
  the media type work *first* — the registration is itself the citation that
  makes the Wikidata item admissible.
- Inclusion in a curated third-party format registry: PRONOM (The National
  Archives), the Library of Congress Sustainability of Digital Formats, or
  Wikidata-adjacent format databases.

**Recommended order: IANA, then a format registry, then Wikidata.** Each step
supplies the citation the next one needs.

## Proposed statements

Item label: **DAI Protocol cartridge**
Description: *self-contained offline application file format*
Also known as: DAI cartridge, `.dai`

| Property | Value | Note |
|---|---|---|
| `P31` instance of | `Q235557` (file format) | The core classification |
| `P279` subclass of | `Q188725` (HTML) *or* omit | Defensible either way; a cartridge is a valid HTML document, but "subclass of HTML" overstates the relationship. Prefer omitting until discussed. |
| `P1195` file extension | `dai` | Without the dot, per convention |
| `P1163` media type | `application/vnd.dai` | **Only once IANA registration completes.** An unregistered value here will be challenged. |
| `P178` developer | Item for the organisation, if one exists | Needs its own notability; a string is not accepted for this property |
| `P571` inception | `2026` | Precision: year |
| `P275` copyright license | `Q334661` (MIT License) | For the reference implementation |
| `P856` official website | Project site, when one exists | |
| `P1324` source code repository | `https://github.com/dynamicapplicationinterface/dai-core` | |
| `P348` software version identifier | `0.1.0` | Qualify with `P577` publication date |
| `P2669` discontinued date | — | Leave empty |
| `P1687` Wikidata property | — | Not applicable |

Every statement should carry a reference (`P248` stated in, or `P854` reference
URL). Statements sourced only to the project's own repository are weak, and a
reviewer will treat them as such — which is another reason the IANA registration
comes first.

## Structured template (QuickStatements v1)

Do not run this until notability is established and the media type is registered.
`LAST` refers to the item created by the preceding `CREATE`.

```
CREATE
LAST|Len|"DAI Protocol cartridge"
LAST|Den|"self-contained offline application file format"
LAST|Aen|"DAI cartridge"
LAST|Aen|".dai"
LAST|P31|Q235557
LAST|P1195|"dai"
LAST|P571|+2026-00-00T00:00:00Z/9
LAST|P275|Q334661
LAST|P1324|"https://github.com/dynamicapplicationinterface/dai-core"
LAST|P348|"0.1.0"
```

Statements deliberately omitted from the template above, and why:

- **`P1163` media type** — add only after IANA registration, with the
  registration page as its reference.
- **`P178` developer** — requires an item for the developer, which has its own
  notability bar. Creating a thin organisation item purely to satisfy this
  property is the kind of edit that attracts deletion of both.
- **`P279` subclass of** — see the table. Worth raising on the item's talk page
  rather than asserting unilaterally.

## What a good description says

The description field is short and load-bearing, and it is where an inaccurate
claim will do the most damage. Two things to avoid:

- Do not describe cartridges as *encrypted*. They are signed and digest-sealed;
  the payload is compressed and base64-encoded, not encrypted, and anyone can
  read it.
- Do not describe the signature as establishing publisher identity. It
  establishes that the payload was signed by the key the file carries — which an
  attacker may substitute. The distinction is documented in the specification and
  should not be lost in a one-line summary.

*self-contained offline application file format* is accurate, short, and claims
nothing that cannot be supported.
