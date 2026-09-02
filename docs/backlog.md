# Backlog

Known gaps, with enough context to act on them later. Each records what is
wrong, why it matters, and what a fix has to account for — not just a title.

---

## 1. The desktop shell verifies less than the runner

**Status:** done. The reader moved to `src/container.ts`, exported at
`dai-core/container`, and both hosts call `verifyContainer` before mounting.
Signature verification moved with it, so a container that carries a publisher
key must now satisfy it rather than merely advertise one. Kept below as the
record of why it was built this way. **Affects:** `apps/desktop`.

`apps/runner/src/cartridge.ts` performs three checks before it will mount a
container:

1. every payload entry matches its digest in `runtime/manifest.json`;
2. every manifest entry is present in the payload — the reverse direction,
   without which content could simply be appended;
3. the outer shell matches the sealed copy at `runtime/container.html`.

The desktop shell performs none of them. `openFile` checks only that a non-empty
payload tag exists, then mounts. A container that the runner refuses will open
in the desktop host.

Check 3 is the one that cannot be skipped safely. A container's own verification
runs inside its own bootloader, so an attacker who rewrites the shell — setting
`dai-integrity` to `advisory`, or deleting the check outright — is audited by the
code they just replaced. Only something holding the sealed copy can catch it, and
in the desktop host nothing does.

### What a fix has to account for

The obvious move is to import the runner's reader into the desktop app, but the
two are separate Vite projects and a cross-app import would couple them. The
reader belongs in `dai-core` instead, beside `buildContainer`: it is pure, it
already depends only on `fflate` and WebCrypto, and both hosts would then share
one implementation rather than two that can drift.

Two constraints on the move:

- **It must stay isomorphic.** The core runs in Node, in a browser tab, and
  inside a Tauri webview. No `node:` imports.
- **Verification needs a secure context.** `crypto.subtle` is undefined
  otherwise, and the bootloader already reports this rather than dying in the
  digest call. A shared reader needs the same guard, with a message naming the
  origin.

Signature verification could move too — the bootloader's `verifySignature` is
already independent of the DOM apart from reading the public key from a `<meta>`.
Splitting "read the key from a document" from "verify a manifest against a key"
would let a host verify authenticity before mounting anything at all.

---

## 3. One app instance per cartridge

**Status:** done. `tauri-plugin-single-instance` forwards a second launch's
arguments to the running process, which raises its window and opens the
cartridge through the same verification and trust path as any other route. The
registry race is closed because there is only ever one writer.

The trade it makes: one window, showing one cartridge at a time. A second
double-click replaces what is mounted rather than opening beside it. For a
document application, windows per document would be the better shape, and it is
what a future version should offer — but not at the cost of concurrent writers
to an unlocked registry.

---

## 2. Publisher identity has no trust model

**Status:** partly addressed. The desktop host now pins a document's key on
first use and refuses a later copy signed by a different one — see "What TOFU
does and does not close" below. The runner has no equivalent yet, and first
sightings remain unprotected. **Affects:** the protocol.

Signature verification works: a container signed with an ECDSA P-256 key is
checked on boot, and a payload altered by anyone lacking that key is refused.

What it does not establish is *who* signed it. A container is self-contained, so
an attacker can replace `<meta name="dai-public-key">` in the shell, re-sign the
payload with their own key, and produce a file that is internally consistent and
mounts without complaint. Every check passes, because every check is made
against the key the file itself carries.

`window.dai.publicKeyFingerprint` is therefore only meaningful when compared
against a fingerprint obtained **out of band** — from a website, a registry, a
printed card. Nothing in the protocol does that comparison today, and nothing
prompts a user to.

### Options, roughly in order of cost

**Trust on first use.** A host remembers the fingerprint the first time it opens
a given `documentUuid`, and warns if a later revision of that document is signed
by a different key. Cheap, and catches the realistic attack: a substituted
update. It does not help the first time a document is seen, which is exactly
when a user is least able to judge.

**Explicit pinning.** The user records a publisher's fingerprint deliberately,
and containers claiming that publisher are checked against it. Stronger, but it
only protects users who did the work, which in practice is few.

**A registry.** Fingerprints published somewhere fetchable. This buys real
identity and costs the property the project is built on: a host that consults a
network to decide whether a document may open is no longer offline software. If
it is ever built it belongs in the host, never in the container, and it must
degrade to one of the options above when there is no network.

### What TOFU does and does not close

Implemented in `apps/desktop/src/trust.ts` with the registry in Rust at
`app_config_dir()/trusted-keys.json`.

Keyed on `documentUuid`, and it pins the **full SPKI** rather than the
fingerprint — a 64-bit truncation is a weaker thing to compare, for no saving.
The unsigned state is pinned too: the application in a container is immutable,
so the only legitimate change to a document is its database, never who signed
it. Signature stripped, signature added, and key substituted are all refused.

**Closed:** someone takes a known document, tampers with it, re-signs with their
own key, and passes it off as the same document.

**Still open:** a malicious *new* document with a new UUID. That is a first use
with nothing to compare against. Per spec §1 a changed application is a new
document with a new UUID, so a legitimate update also arrives as a first
sighting — which means TOFU cannot distinguish "publisher shipped v2" from
"attacker shipped a lookalike". Closing that needs a publisher identity separate
from the key, and the manifest has none: `publicKeyFingerprint` *is* the key.
`appName` is attacker-controlled, so keying on it would produce a check that
reads as protection and is trivially evaded.

**Also still open:** the runner. It has the same exposure and no registry.
IndexedDB is the obvious store, and `checkTrust` already takes its `invoke` as a
parameter so the decision logic can be reused against a different backend.

**Escape hatch:** `forget_pinned_key` exists because a publisher may rotate keys
legitimately, and a permanently unopenable document would push users toward
something worse than an explicit reset.

### What must not happen

The UI currently reports `signed 7cd4a122 · sig valid`. "Valid" is accurate
about the mathematics and misleading about the meaning: it reads as *this is
who it claims to be*, which the signature does not establish. Whatever model is
chosen, the wording should not imply verified identity until something actually
verifies identity.

`docs/spec-v0.1.md` §6 documents the limitation. This is the plan to remove it.
