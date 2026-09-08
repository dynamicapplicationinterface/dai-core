# The capability registry

A document may name what it depends on. `requires` is a list of capability
names in the manifest, in the signed set, and a reader opens the document only
if it implements every name on the list. Anything else is refused by name.

There is no degraded mode, and that is the whole point. For rosters, sessions
and confidentiality, opening a document without the feature it declares is the
vulnerability the feature was added to close, so a reader that quietly ignored
`requires` would be exactly that hole. A refusal names what is missing, because
"this app cannot open it" sends somebody looking for damage that is not there.

`broadcast` and `open` are the base behaviour every reader has. They are never
listed.

## The names

| Name | What a reader must do to claim it |
| --- | --- |
| `session` | Hold a bounded, revocable session between named participants, and end it when it is revoked. |
| `shared-dataset` | Give participants a common set of rows, distinct from any one participant's own. |
| `replicated` | Merge concurrent edits from several replicas into one convergent state. |
| `passphrase` | Derive the document's key from a passphrase supplied by the reader. |
| `recipient-bound` | Open only for a named recipient, on a key that recipient holds. |
| `relay` | Move updates between replicas through a store that cannot read them. |

None is implemented yet. Track 0 shipped the gate before any of the
capabilities, so today every document lists nothing and is unaffected, and a
document listing anything is refused. Each track adds its own name to the
reader as it lands.

## The rules

**A name never changes meaning.** If what a reader must do to claim a name
changes, that is a new name, not a redefinition. A document signed years ago
says what it needs in the words that were true when it was signed, and there is
no way for it to find out that a word moved.

**A reader refuses on what it implements, not on what is registered here.** An
unregistered name is refused like any other name the reader lacks. This
document exists so the next capability is added to a list rather than invented
twice — it is not a gate, and a reader must not treat a name's absence from it
as permission to open the document anyway.

**Registered before emitted.** A name is added here, with its row in the table
above, before any writer emits it. A document in the wild naming something
undescribed cannot be reasoned about by anyone.

**Adding one.** Propose the name and the row: what a reader must actually do to
claim it, in a sentence, written so two implementations can be checked against
it. If the sentence needs a paragraph, the capability is more than one
capability. A new name also needs a conformance case that a reader lacking it
refuses, in a file and carried in a link, because those are two different code
paths and one has already diverged from the other.

## Where this lives in the code

`CAPABILITY_REGISTRY` in `src/container.ts` and `dai_read.py` is this table.
`IMPLEMENTED_CAPABILITIES` beside it is what that reader will actually open,
and the two are deliberately separate: the first is documentation, the second
decides.
