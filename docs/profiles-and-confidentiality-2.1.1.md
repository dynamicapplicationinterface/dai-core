> **What this document is.** The design record for profiles and
> confidentiality, draft 2.1.1, committed as it was written — before any of
> the implementation existed. It is cited as "2.1.1" by
> `docs/replicated-tables.md` and `src/container.ts`, and it is here so those
> citations resolve.
>
> **It is not current authority.** The numbered decisions in
> `docs/replicated-tables.md` (T1-D1 onward) record what changed once the
> building started, and where a numbered decision and this document disagree,
> **the decision wins**. This file is deliberately not edited to agree with
> them: it records what was decided and when, and the decisions record what
> changed since. Read the two together.
>
> Known points where what shipped differs, checked against `main` on 13
> September 2026. Not exhaustive — verify anything you rely on against the
> code:
>
> - **D2, the version.** Here: `manifestVersion: 4` for any document declaring
>   a profile or a confidentiality level. Shipped: a build emits 4 when its
>   schema declares a replicated table, with a `requires` registry; a plain
>   build still emits 3 (T1-D5, reversed by T1-D24, restored by **T1-D25**).
> - **§5.2, the session roster.** Here: a `_sessions` table with an ordered
>   roster filled by first signed row. Shipped: the creator mints seats and a
>   joiner binds one (`_dai_seat`, `_dai_binding`, the `_dai_member` view); a
>   seat two replicas bind is contested and admits neither (**T1-D29**). A
>   copy binds a seat when it opens an invite, never because rows arrived
>   (T1-D34).
> - **§5.2 rule 2, non-member rows.** Here: dropped on merge. Shipped: kept,
>   and excluded from the `_heads` views, which are where admission is enforced
>   (T1-D29).
> - **§3.3, the `_current` tiebreak.** Shipped adds `_r_seq` as the final
>   tiebreak (T1-D6).
> - **§3.1, signatures.** `_r_sig` existed and was always NULL at Level 1
>   (T1-D7); since signed authorship a row names its signed batch instead
>   (`_r_batch`, `_dai_batch`; docs/identity.md).
> - **Not implemented at all:** the `data-validate` hook (§5.2 rule 6), the
>   bridge messages of §5.4, `shared-dataset` (§5.3), every confidentiality
>   level (§6), and mailbox-key rotation (§8.3). What a reader implements is
>   `IMPLEMENTED_CAPABILITIES` in `src/container.ts` — `replicated` and
>   `session`.

# DAI Profiles and Confidentiality — Specification

Status: draft 2.1.1. Targets manifestVersion 4. Roadmap v3 R1–R8 amendments marked *(2.1)*; editorial and privacy-vector round marked *(2.1.1)*. Supersedes draft 1 and the reducer/mutation-log sync design in the earlier Relay Roadmap. Companion to spec-v0.2, the replicated-tables draft, DAI Roadmap v2, and the enterprise deployment spec. Everything here is part of the open format and is implemented in `dai-core`.

---

## 0. Decisions this draft locks

These were the open contradictions in Roadmap v2. Each is resolved here by cutting, not compromising.

| # | Decision | Resolution |
|---|---|---|
| D1 | Sync model | **Replicated rows, union merge.** The reducer, mutation classes, determinism lint, replay test, and the relay's ordering role are deleted. |
| D2 | How a reader refuses what it doesn't implement | **manifestVersion 4** for any document declaring `profile` or `confidentiality`, plus a `requires` list so this is the last version bump a feature needs. |
| D3 | Key loss | **Two keys, two rules.** Authorship keys have no recovery (loss costs attribution of future rows only). Confidentiality keys recover only through an additional recipient (escrow). |
| D4 | Session export | Export **only the session being shared**. Enforced by a same-session parents rule. |
| D5 | Heads and current | `_r_superseded` flag maintained at write; `_current` shows a **deterministic pick with the conflict surfaced**, never an omission. |
| D6 | Compaction | **Deferred, instrumented from the first build.** |
| D7 | Revocation reaches the relay | **Mailbox key rotates** on every roster revocation. |
| D8 | Card | Gains a **document line** for sync state; the app line ("Can't go online") is unchanged. |

Trade-offs accepted with these decisions are listed in §11. They are part of the spec so nobody rediscovers them.

## 1. Purpose

Every DAI app that involves more than one person has the same three problems: who may write, how copies reconcile, and who may open. This document moves them into the format as two declarations an author makes once:

- **Profile** — the *shape*: how many parties, who writes, how copies meet.
- **Confidentiality level** — *who can open* the file.

App authors never implement rosters, merge rules, key handling, or authentication. The kit exposes them as declarations and bridge calls, the way `dai-form` exposes a database write.

Governing line: anything that determines whether a file opens, verifies, merges, or decrypts identically on two conforming hosts is in this document and in `dai-core`.

## 2. Versioning and compatibility

### 2.1 manifestVersion 4 and `requires`

```json
{
  "manifestVersion": 4,
  "requires": ["session", "recipient-bound"],
  "profile": "session",
  "confidentiality": "recipient-bound"
}
```

- Any document declaring `profile` or `confidentiality` MUST be manifestVersion 4. Documents with neither MAY remain version 3 (today's broadcast behaviour).
- `requires` is in the signed set and lists every capability the document depends on. Version 4 defines the initial registry: `session`, `shared-dataset`, `replicated`, `passphrase`, `recipient-bound`, `relay`. `broadcast` and `open` are the base and are never listed.
- A version-4 reader opens a document only if it implements every entry in `requires`; otherwise it refuses with `UNSUPPORTED_CAPABILITY` naming the missing entries. A pre-4 reader refuses with `UNSUPPORTED_MANIFEST_VERSION`, which every shipped reader already does.
- New capabilities are added to the registry without a version bump. A version bump is reserved for a change to the container itself.

### 2.2 Read down, never up

- A conforming reader MUST open every valid document of any version at or below its own, at that document's level. An old document makes no new claims; the reader applies nothing it doesn't declare. This is a hard rule, with a conformance vector per historical version.
- A reader MUST NOT open a document that declares a capability it does not implement. There is no degraded mode. For capabilities that carry safety rules — rosters, sessions, confidentiality — "open without the feature" is the vulnerability the feature exists to close.

### 2.3 Capabilities are immutable

A capability name, once shipped in the registry, means the same rules forever. A behaviour change is a new name, never a redefinition, because a reader somewhere will honour the old name literally. The registry only grows.

### 2.4 Readers before writers

*(2.1)* The conformance pair is TypeScript and Python; there is no Rust reader (`crates/sectioned` is file I/O, and the desktop host verifies through the TypeScript reader, so it is a host, not an independent implementation). Both readers ship version-4 support in one release before any writer emits version 4, with the Python reader implemented from spec text. Same discipline used for version 3.

## 3. Foundation: replicated rows

The sync model for every multi-party profile is the replicated-tables draft: append-only rows keyed `(_r_replica, _r_seq)`, Lamport clocks, a parents DAG per entity, union merge. Union merge is commutative, associative, and idempotent, needs no ordering authority, and works with no server. This section records only the changes to that draft.

### 3.1 Authorship is a key

Every host holds one P-256 replica key per document in OS-protected storage. It never enters the app frame and never leaves the host except as a signature. Names are labels the app attaches to keys; keys are what the merge trusts.

**Key source.** Where the platform supports the WebAuthn PRF extension, the replica key is derived: `HKDF-SHA256(PRF(credential, documentUuid), "dai-replica")`. Because passkeys sync through the platform keychain, the authorship key then survives device loss with no recovery scheme of its own. *(2.1)* Derivation is used only for a platform passkey on the same device; hybrid (cross-device) and hardware-key credentials are excluded until measured stable, because a flow that returns a different PRF value would silently mint a second replica for the same person — a data-model corruption, not a compatibility gap. Where PRF is unavailable or excluded the host generates a random key and stores it; loss means continuing as a new replica (D3). The source is recorded in the row signature header so readers know which to expect. G0's device persistence test decides the default per platform.

### 3.2 Heads without a scan (D5)

Each replicated row carries `_r_superseded INTEGER NOT NULL DEFAULT 0`. When a row is inserted (locally or by merge) the trigger sets `_r_superseded = 1` on every row named in its `_r_parents`. Then:

- `T_heads` = rows where `_r_superseded = 0` — indexed, no DAG walk.
- `T_conflicts` = entities with more than one head.
- Merge sets the flag identically on every host, so it converges.

### 3.3 `_current` under conflict (D5)

`T_current` shows one row per live entity always. Under conflict it shows the head with the highest `_r_lc`, tiebreak lexicographic `_r_replica`, and exposes `_r_conflicted = 1` on that row. The entity is never omitted; omission is a silent resolution to nothing and reads to a person as lost data. The app resolves by writing a row with multiple parents, as before. Conformance vector `current-conflict-deterministic-pick` requires identical output across readers.

### 3.4 Growth (D6)

No compaction in this draft. From the first build, hosts record rows and bytes per document in the details panel and in host reports (§9). The defined exit, reserved but not built: compaction is a successor document, owner-signed, whose data section is a snapshot of heads plus tombstones, with `supersedes` naming the prior UUID. Nothing in the row format needs to change for that later.

### 3.5 `savedAt`

Wall-clock ordering is superseded for any document with replicated tables. It remains the mechanism for `broadcast`, where whole copies still replace each other.

## 4. Declarations

```json
{ "manifestVersion": 4, "requires": ["shared-dataset"], "profile": "shared-dataset", "confidentiality": "open" }
```

Absent `profile` means `broadcast`. Absent `confidentiality` means `open`. The recipe exposes the two as questions: *how many people use this, and do they all write?* and *who should be able to open it?*

## 5. Profiles

| Profile | Parties | Who writes | Roster | Copies meet by | Typical apps |
|---|---|---|---|---|---|
| `broadcast` | one → many | publisher only | none | succession | statements, reports, reference tools |
| `session` | few, fixed | roster members | closed, set once, key-based | relay or link, per session | correspondence chess, two-party agreements, turn-based anything |
| `shared-dataset` | many, growing | roster members, each on own rows | open, owner-admitted | relay mailbox or file exchange | receipt tracker, family inventory, team log, field data collection |

### 5.1 `broadcast`

No replicated tables. The data section is the recipient's private annotation space and never travels back. Updates are a successor document. Nothing new in core.

### 5.2 `session`

```sql
CREATE TABLE _sessions (
  session_id  TEXT PRIMARY KEY,   -- random 128-bit, minted by the creator's host
  created_by  BLOB NOT NULL,      -- replica public key
  roster      BLOB NOT NULL,      -- CBOR array of replica public keys, ordered
  max_parties INTEGER NOT NULL,   -- declared by the app; 2 for chess
  closed      INTEGER NOT NULL DEFAULT 0
);
```

1. The creator's key is slot 0. Slots fill in order of first signed row against the `session_id` until `max_parties`, then the roster closes and never changes.
2. Every replicated row carries `session_id`. On merge, a row whose signer is not in that session's roster is **dropped**, not conflicted. A forwarded file cannot enter a closed game.
3. **Same-session parents rule (D4).** Every parent in `_r_parents` MUST carry the same `session_id` as the child. The write trigger refuses; merge rejects with `ROW_REJECTED`. A session is therefore a closed subgraph.
4. **Export is one session.** Sharing from within a session exports only that session's rows. Other sessions in the same document never travel. Conformance: `session-export-excludes-others`.
5. A host whose key is in no open session is offered "start new session": a new `session_id` with the host as slot 0. The app supplies the button; the host supplies the mechanics.
6. Rule validation is the app's job through the `data-validate` hook, run against every incoming row before merge. Rejected rows are recorded with the reason, visible in the details panel, excluded from `_current`. The protocol guarantees authorship; the app guarantees semantics.

### 5.3 `shared-dataset`

```sql
CREATE TABLE _roster (
  replica      BLOB PRIMARY KEY,
  label        TEXT,               -- assigned by the admitter, not the key holder
  admitted_by  BLOB NOT NULL,
  admitted_seq INTEGER NOT NULL,   -- Lamport clock at admission
  revoked_seq  INTEGER,            -- NULL while active
  mailbox_key  BLOB                -- current mailbox key wrapped to this replica (HPKE); see §8.3
);
```

1. The creator is the **owner**: first row, self-admitted. Only the owner admits or revokes. Ownership transfers by signed row; it is never shared.
2. A row is accepted if its signer was in the roster, unrevoked, at the row's Lamport clock. Rows before revocation stay; rows after are dropped. Revocation cannot unsend, and the documentation says so first.
3. Members' rows are their own; union converges by construction. Conflicts arise only on the same entity and surface per §3.3.
4. Display order is the app's business (a receipt sorts by its own date), never merge order.
5. **Two share actions**, distinct, both host-rendered, both required in every conforming host:
   - **Share a fresh copy** — new UUID, empty data, recipient becomes owner of a new roster. The share-sheet default and the only action reachable from the launch card.
   - **Invite into this roster** — owner only; a signed admission of a key the invitee's host generates on accept, delivered as a short link or relay message, carrying the shared data and the current mailbox key. Behind a deliberate step in settings.

   A host offering only one does not conform.

### 5.4 Bridge surface

| Message | Direction | Purpose |
|---|---|---|
| `dai:replica-id` | host → frame | this host's replica public key and label |
| `dai:sign` | frame → host → frame | sign a canonical row; returns it with `_r_sig` |
| `dai:roster` | host → frame | roster / session membership view |
| `dai:session-new` | frame → host | mint a session |
| `dai:share` | frame → host | open host share UI, `{mode: "fresh" | "invite" | "session"}` |
| `dai:merge-result` | host → frame | accepted / rejected / conflicted counts |

The frame never sees keys, cannot write `_roster` or `_sessions` directly (triggers refuse rows without a valid host signature), and cannot reach the network.

## 6. Confidentiality levels

| Level | Who can open | Mechanism | Recoverable on key loss |
|---|---|---|---|
| `open` | anyone with the bytes | none | n/a |
| `passphrase` | anyone with the passphrase | named KDF → AES-256-GCM over `app/` and `data/` | no |
| `recipient-bound` | listed recipients | HPKE (RFC 9180) per recipient wrapping a content key | only via an additional recipient |

Principles:

- **Nothing checks who is opening.** A file cannot authenticate its reader; any check in code is removable. The only protection is encryption to a key the reader must hold. Authentication is how the reader reaches the key. Hosts MUST NOT implement "verify identity, then decrypt with an embedded key"; there is a negative conformance vector.
- **The app is never involved.** Applied by the compiler at publish, reversed by the host at mount; app bytes identical across levels.
- **The signed set is verifiable before decryption.** Manifest, publisher signature, and card content stay clear, so the card renders honestly on a host that can't open the file.

### 6.1 `passphrase`

*(2.1)* KDF is a named identifier with its parameters in the signed manifest: `pbkdf2-sha256` (WebCrypto, ≥600k iterations) is the only id implemented at first; `argon2id` is registered for later. Unknown id → `UNSUPPORTED_KDF`, so adding one is a registry entry, not a version bump. One content key; passphrase stored nowhere; inline links carry ciphertext, never the passphrase. Loss is permanent and the host says so before it is set.

### 6.2 `recipient-bound`

- HPKE base mode, DHKEM(P-256), HKDF-SHA256, AES-256-GCM. Recipients listed as `{kid, source, enc, wrappedKey}`. Any number; ~100 bytes each.
- Sources: `webauthn-prf` (key derived from PRF output; biometric prompt is the authentication), `oidc-derived` (host-held key released after login to a named issuer, bound to `sub`; the host holds the key, the issuer releases it), `static` (raw P-256 key for escrow, CI, services).
- **Enrollment** is a first-contact step the format does not hide: a sender cannot encrypt to a key it has never seen. Core defines the enrollment record (signed by the replica key) and a `dai enroll` / `dai:enroll` bridge. *(2.1)* The opener ships one concrete exchange: *Send my enrollment* produces a short link (`/e/<record>` or inline fragment) and *Add recipient from link* imports it; paste-a-record is the fallback. Other exchanges are deployment-specific. A re-enrollment for a recipient already known under a different key is a **key-continuity event** *(2.1.1)*: the sender's host shows it on the card (§6.3 `recipient-key-changed`) and does not silently replace the pinned key.
- **Escrow (D3).** A `recipient-bound` document that must outlive one device SHOULD carry a `static` recipient held by the publishing organisation, named in the manifest's `escrow` field so the card can say *Your organisation can also open this*. A file encrypted to a single device key is unrecoverable by anyone if that device is lost. Whether escrow is right is an app-level values decision — correct for a statement, wrong for a private journal — and the declaration makes it explicit.
- Revoking a recipient means a successor without them; their existing copy remains theirs.

### 6.3 Card states

| State | When | Card |
|---|---|---|
| clear | `open` | as today |
| locked | `passphrase` not yet entered | *Protected with a passphrase* |
| bound-you | listed key present | *Encrypted for you* · unlock |
| bound-other | no listed key here | *Encrypted for someone else* · publisher still shown |
| bound-stale | key source unavailable | *Needs [passkey / sign-in] to open* |
| recipient-key-changed *(2.1.1)* | sender side: a known recipient re-enrolled under a new key | *[Name]'s key changed — confirm before sending* |

Never *Verified*, never *Secure*.

## 7. Card: the document line (D8)

The launch card carries two claims about two subjects and must not merge them:

- **App line** (unchanged): *Can't go online* — true of the sandboxed app, always.
- **Document line** (new): what the document does with other people. States: *Only you* · *Shares changes with N people · by file* · *Shares changes with N people · synced via relay 2h ago* · *Relay full — shared by link* *(2.1)* · *Encrypted for you*. `claimsFor()` gains a clause for it.

## 7A. Links and installation *(2.1.1)*

- Links carry `#u=<uuid>` as an **unverified hint** that only selects which library entry to try; the mounted manifest UUID is authoritative and a mismatch is treated as a first sighting (launch card, no reuse of the entry's data section). A fragment never reaches a server, so the hint cannot grow into a lookup service.
- No `?doc=` query parameter, ever: a bare UUID resolves nothing on its own and would invite a lookup service this project must never need.
- Install to home screen is offered only for a document already in the library. `start_url` is omitted so the icon bookmarks the live URL. Launch resolves library by UUID → store fetch via `#h=&k=` if present → card *This document isn't on this device — open the original link*.

## 8. Relay (open protocol)

A dumb, encrypted, append-only mailbox that moves rows between hosts not online at the same time. Optional for every profile; a document works identically without one. Core defines the protocol and ships a reference relay; anyone may run one.

### 8.1 Operations

`append(mailbox, blob)`, `since(mailbox, cursor) → blobs`, `head(mailbox) → {retention, cursor, limits}`. *(2.1)* `limits` advertises the mailbox's byte and push-subscription caps so a host can warn at 80% and is never surprised by a refusal. Nothing else. No ordering, no ACK quorum, no fork detection — union merge needs none of it. No presence and no accounts in the protocol; transport-level authentication is outside the format.

### 8.2 What the relay holds and learns

- Holds: ciphertext blobs per document UUID. Cannot read rows, rosters, or names.
- **Learns exactly one thing beyond volume:** the number of push subscriptions per mailbox, because push endpoints must be registered. This is stated here so it is never a surprise. Nothing else about membership is visible to the relay.

### 8.3 Mailbox key and rotation (D7)

- Rows in the mailbox are encrypted under a per-document mailbox key, initially derived from the document key in the fragment.
- **On every revocation the owner mints a new mailbox key**, wraps it to each remaining active replica key with HPKE, and writes the wrapped set into `_roster.mailbox_key` as a signed roster row. Invites carry the current key the same way. Blobs written after rotation are unreadable to the revoked member. Without this, revocation is honest about the document and false about the relay.
- Blobs written before rotation remain readable to a former member who fetches them within retention; the specification says so.

### 8.4 Push, retention, failure

- Push carries only the mailbox id; the host fetches and merges. Push is the reason `session` apps use a relay: the row is small, the tap is the point.
- Retention is advertised in `head()`. Blobs expire; documents do not. A host outside the window catches up by file exchange. Reference default: 90 days.
- Unreachable relay → fall back to link or file exchange; card shows last sync. No relay operation is ever required to open, verify, save, merge, or export.
- *(2.1)* **Limits.** `append` and push subscription may refuse with `RELAY_LIMIT_EXCEEDED { limit: "bytes" | "subscriptions", current, max, resetAt | null }`. Retention never produces this code: expiry is announced by `head()`, not refused. On refusal the host falls back to link or file exchange with the document line *Relay full — shared by link*; data is never lost. A null `resetAt` means the only exit is compaction and is the signal that schedules it (Roadmap Track 7).
- A Safari copy and an installed copy on iOS are two replicas of one document and reconcile through the mailbox; this is what finally closes the iOS split. Installation and `#u=` are specified in §7A.

### 8.5 Transport credentials and limits *(2.1.1)*

Transport-level credentials are outside the format. The reference relay exposes a pluggable entitlement interface with a null default that permits everything; a real one accepts an opaque token on the three operations and applies per-mailbox limits. Two rules keep §8.2 enforceable rather than aspirational:

- Limits are **per mailbox and volume-shaped only**: bytes, push subscriptions, retention. No limit may be defined in terms of roster size or membership.
- A refusal's reason and numbers MUST NOT vary with roster contents. `RELAY_LIMIT_EXCEEDED` carries `limit ∈ {bytes, subscriptions}` and byte or subscription counts, never a member count, and `max` is never scaled by membership. Otherwise the refusal itself leaks what §8.2 hides.

Nothing about who issues tokens is in the format.

## 9. What `dai-core` must contain to support an enterprise architecture

Stated as capability of the open code, so an enterprise deployment is configuration, not a fork.

1. Profiles, confidentiality, `requires`, and read-down in both conformance readers (TypeScript, Python) with vectors for every MUST.
2. Policy file read from a managed location, `locked` semantics, unknown keys ignored, unknown version refused.
3. Signed policy feed: revoke by UUID or publisher key, supersede, `maxOfflineAge`, `POLICY_STALE`, `REVOKED_BY_POLICY`; last good feed enforced offline.
4. Trust roots: publisher chains verified to a configured root; card shows the chain subject when valid, KNOWN/NEW/CONFLICT otherwise; expiry never yields *Verified*.
5. Recipient key sources `webauthn-prf`, `oidc-derived`, `static` in opener and desktop host; OIDC issuer configurable; enrollment record and bridge.
6. Escrow: multi-recipient HPKE, `escrow` field, secure-the-data mode on revocation as a policy option.
7. Store: three-call interface, admission by chain, encryption modes `e2e` / `org-held` / `clear`, retention and hold as configuration.
8. Reference relay deployable from the repo with §8 vectors, including rotation.
9. Host reports: off by default, documented schema (`open`, `refuse`, `merge`, `install`, rows and bytes per document; never content).
10. Policy lint in `dai check` with rule files and `REFUSED_BY_POLICY`.
11. One reference template per profile, passing lint and conformance, written from the recipe.

Directories, dashboards, issuance workflows, and hosted services are deployment and stay out of `dai-core`.

## 10. Two documents, two readers

- **Recipe / app-author guide**: the two declarations, three templates, bridge calls, share actions. No cryptography, no wire formats.
- **Implementer specification**: CDDL, merge and roster algorithms, HPKE parameters, relay operations, error codes, vectors.

## 11. Accepted trade-offs

Recorded so they are decisions, not discoveries.

- **No shared-invariant enforcement (D1).** Union merge cannot enforce rules that depend on total order or on seeing everyone's state at once — a balance that must never go negative, one ticket two offline people both claim. No current or planned app needs this. When one does, a single app can give one participant authority over that one value without taxing every other app. Media and payload size are unaffected by this choice; they are container and store questions.
- **Old readers refuse new documents (D2).** Deliberate. The cost is readers-before-writers scheduling, already practised once.
- **Authorship key loss is not recovered (D3)** where PRF is unavailable or excluded (hybrid and hardware-key credentials). Cost: attribution of future rows. Existing rows stay valid.
- **`passphrase` ships on PBKDF2-SHA256, not Argon2id *(2.1.1)*.** PBKDF2 is not memory-hard, so a GPU attacker guesses faster than against Argon2id. Accepted because of the tiering: `passphrase` is the out-of-band-secret level already documented as phishable and meant for low stakes; the strong level is `recipient-bound`, which uses no KDF. Argon2id is a registered id, addable without a version bump when a wasm KDF is acceptable in the opener core.
- **Escrow makes a file recoverable by the organisation (D3).** Correct for regulated documents, wrong for private ones; each app declares which.
- **Membership is invisible to the relay (D7, §8.2).** Consequence: anything a relay operator measures can only be volume, retention, and subscription count.
- **Growth is unbounded until compaction (D6).** Instrumented from day one; the exit is defined and does not change the row format.
- **A revoked member retains pre-rotation blobs within retention (D7)** and pre-revocation rows forever. Stated, not hidden.
- **Sessions in one document are isolated only at export (D4).** A holder of the full document still sees all their own sessions; that is the point.

## 12. Conformance vectors (additions)

Versioning: `v4-requires-missing-refuses`, `v4-reader-opens-v3`, `v4-reader-opens-v2`, `pre4-reader-refuses-v4`.
Replication: `heads-via-superseded-flag`, `current-conflict-deterministic-pick`, `replica-key-prf-derived`, `replica-key-host-held`, `replica-key-source-recorded`.
Links: `fragment-uuid-mismatch-is-first-sighting`, `install-held-document-opens-offline`.
Session: `session-third-party-dropped`, `session-roster-closes-at-max`, `session-cross-session-parent-rejected`, `session-export-excludes-others`, `session-invalid-move-rejected-by-app`, `session-forward-yields-new-session`.
Shared-dataset: `roster-owner-only-admits`, `roster-revoked-rows-after-dropped`, `roster-revoked-rows-before-kept`, `share-fresh-has-empty-data`, `share-invite-carries-data-and-key`, `share-both-actions-present`.
Confidentiality: `passphrase-kdf-params-honoured` (one vector per registered id), `enroll-link-roundtrip`, `enroll-key-change-shown`, `bound-card-renders-without-key`, `bound-multi-recipient`, `bound-no-embedded-key-negative`, `escrow-field-shown-on-card`.
Relay: `relay-blob-opaque`, `relay-rotation-excludes-revoked`, `relay-limit-falls-back-to-link`, `relay-head-advertises-limits`, `relay-limit-refusal-is-volume-shaped` *(2.1.1)* (same refusal for two rosters of different size and identical volume), `relay-null-entitlement-permits` *(2.1.1)*, `relay-expiry-does-not-affect-document`, `relay-absent-document-opens`.
Policy: `policy-locked-not-overridable`, `feed-revoke-refuses`, `feed-stale-refuses-level2`, `feed-unmanaged-unaffected`.

## 13. Error codes (additions)

`UNSUPPORTED_CAPABILITY`, `UNSUPPORTED_KDF`, `RELAY_LIMIT_EXCEEDED` (never for retention), `NOT_IN_ROSTER`, `SESSION_CLOSED`, `ROW_REJECTED`, `ROW_REJECTED_BY_APP`, `NO_RECIPIENT_KEY`, `KEY_SOURCE_UNAVAILABLE`, `RELAY_UNREACHABLE`, `REVOKED_BY_POLICY`, `POLICY_STALE`, `REFUSED_BY_POLICY`.

## 14. Out of scope

Real-time collaborative editing; presence; cross-publisher forks; general CRDTs; page-level SQLite diffing; cross-document reads; authorship key recovery beyond PRF derivation; compaction implementation; any capability granting an app frame network access; identity issuance workflows; deployment topology.
