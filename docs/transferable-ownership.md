# Transferable ownership — the decision

A design decision recorded ahead of any build, in the form
`docs/replicated-tables.md` uses: what was settled, and why. **No code, no
capability registered, no table, no change to `IMPLEMENTED_CAPABILITIES`.** Issue
[#1](https://github.com/dynamicapplicationinterface/dai-core/issues/1) and PR #2
propose the protocol; PR #2 stays open and unmerged — it is thinking, not a
commitment. This is the decision that thinking settled on, parked in
`docs/backlog.md` behind the dependency it names.

**TO-D1 — transfer is re-encryption plus a signed transfer row; ownership is a
chain verifiable offline, and only that chain is cryptographic.**

*The model.* Transfer is not a database edit and not a manifest change. The
holder's opener decrypts the payload with the holder's key, re-encrypts it to the
recipient's key, and appends a **signed transfer row** — *A transferred to B at
this point*. The rows form a chain: anyone holding the file verifies the whole
chain offline, each row signed by the key the previous row handed to. The
recipient's copy opens, because it is encrypted to the recipient's key; the
sender's copies do not, because they remain encrypted to the sender's key at a
version the chain has superseded. Nothing is deleted and nothing is reached — the
sender's old copies simply no longer open under a compliant opener, and were
never readable by anyone but their key-holder in the first place.

*Two tiers, stated as distinct claims — because conflating them is how products
in this space fail.*

- **Cryptographic, and absolute.** A holder without the key cannot open the
  document. No offline act and no online service changes that. This is the only
  guarantee the cryptography makes, and it makes it completely.
- **Social, and conditional.** That *only one party holds* an openable copy is
  not a cryptographic fact. Offline, a double transfer — the same holder handing
  the same prior state to two recipients — is **detectable when the two chains
  meet, and never prevented**. A **witnessed** tier moves detection from collision
  time to transfer time: the relay records each transfer, and a holder checks that
  its chain is the one the relay saw. That tier is opt-in, and it is a **service**
  — a property of a subscription, never a property of the file.

*What cannot be done — stated plainly, because the design does not pretend
otherwise.* A stale copy cannot be corrupted or reached; there is no call-home
that disables it. A compliant opener *refuses* a superseded version — but "refuse"
is a policy the opener runs, not a force applied to the file: a holder with an old
opener and no network keeps reading what they already had. That is true of any
file ever sent. **Note what this rests on, honestly:** today the only
time-bounded refusal an opener has is the container's own expiry (`validUntil`,
refused as `KEY_EXPIRED`). Refusing a *superseded* version is machinery that does
**not exist on `main`** — a revocation-by-policy check, bounded by a maximum
offline age so an offline holder is not stranded forever, that would have to be
built. It is named here as work, not cited as present. The analogy to keep: a
spent key on a thumb drive still reads and still buys nothing — the file is both
the instrument and the evidence, and the **issuer** is what makes a transfer
*mean* something.

*The dependency — this cannot be built first.* Transfer sits on two things that
do not exist yet:

- **`recipient-bound`** — registered in `docs/capabilities.md`, unimplemented,
  Track 4. A document must open only for a named recipient before ownership can
  move *between* recipients. `docs/replicated-tables.md` already anticipates
  Track 4 making a document recipient-bound.
- **A key-holder identity** — there is no enrollment, no passkey-derived key in
  use, and no way for one opener to learn another opener's public key. Re-encrypting
  the payload *to the recipient* means knowing the recipient's key, and nothing
  today establishes or exchanges one.

Neither is built. Track 4 (`recipient-bound`) is the enterprise demo's floor
regardless, so it earns its place on its own merits; transferable ownership is the
layer above it. This decision is parked behind both.
