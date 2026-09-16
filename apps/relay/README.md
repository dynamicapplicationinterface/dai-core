# dai-relay — the mailbox relay

A Cloudflare Worker with one Durable Object per document. It carries Track 5
mailbox batches between two copies of a document: `append` / `head` / `since`
over sealed bytes it cannot read. The counter and the digest→cursor index live
in the Durable Object (single-threaded per mailbox, so the cursor invariant is
race-free); the sealed bytes go to R2 under `mailbox/<doc>/<seq>`.

## Contract

    POST  /m/<doc>          body = sealed bytes → the cursor, as text
    GET   /m/<doc>/head     → the head cursor, as text
    GET   /m/<doc>?since=N  → { cursor, batches: [base64, …] }

This is the exact contract `src/mailbox-http.ts` speaks and
`tests/mailbox-http.spec.ts` pins, so the client and the relay cannot drift.

## Deploy (yours)

Needs the Cloudflare account that already holds the R2 store.

```bash
cd apps/relay
npx wrangler deploy
```

Set `bucket_name` in `wrangler.toml` to the store bucket first (it defaults to
`dai-store`). Point the opener's `httpMailbox({ base })` at the deployed
worker's `/m` path, e.g. `https://relay.opendai.app/m`.

**After a deploy, check with a read before you post anything.** The worker and
its Durable Objects do not change version at the same instant: for a short
window new routing can be live while a mailbox object still runs the old code,
and a POST meant for a new route lands in the old object as an append — a batch
in somebody's mailbox. A GET is a read in both versions, so it is safe in the window; use one that tells
the versions apart (for a new route, compare what the old and new code would
each return) and post only once it reads new.

## Push (slice two)

    POST  /m/<doc>/subscribe    body = { endpoint } → "ok"
    POST  /m/<doc>/unsubscribe  body = { endpoint } → "ok"

A new batch wakes every subscription on that mailbox except the appender's
own (named by `x-dai-sender: <sha256 of its endpoint>`). The push is
payloadless Web Push signed with VAPID: it carries no body and one constant
`Topic` for every mailbox, so nothing about the move — not even which mailbox
it was in — reaches the push service, and the woken service worker asks this
relay's `head` what moved. A subscription the push service answers 404 or 410
for is forgotten. The opener registers one service worker per mailbox, so each
mailbox has its own endpoint and the relay holds nothing tying one game's
mailbox to another's.

The relay sends only to HTTPS endpoints on the real push services' hosts
(Firebase Cloud Messaging, Mozilla autopush, Apple web push, the Windows
notification service), and a mailbox holds at most eight subscriptions, so it
cannot be aimed at an arbitrary host or made to send without bound. The test
environment variable `PUSH_ALLOW_LOOPBACK=1` admits a local push service; a
deploy never sets it.

Open tier, stated: anyone holding a mailbox's address can append, subscribe,
and name any subscription as the sender of an append to spare it the wake. That
is the same property as anyone-with-the-link-can-append, not a new one.

To switch it on (yours):

```bash
node apps/relay/scripts/vapid-keys.mjs
```

Then set the public key as the relay's `VAPID_PUBLIC_KEY` var (in
`wrangler.toml`) and as `DAI_PUSH_PUBLIC_KEY` on the opener's build, and the
private key as a secret: `npx wrangler secret put VAPID_PRIVATE_JWK`. Without
the keys the relay stores subscriptions and wakes nobody, and the opener, with
no public key in its page, never asks about notifications.

## Deferred, as ruled

Retention (trimming a mailbox) and entitlement (who may append or subscribe)
are not here. When retention lands, it is a lifecycle rule on the `mailbox/`
prefix.
