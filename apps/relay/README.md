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

## Push (slice two)

    POST  /m/<doc>/subscribe    body = { endpoint } → "ok"
    POST  /m/<doc>/unsubscribe  body = { endpoint } → "ok"

A new batch wakes every subscription on that mailbox except the appender's
own (named by `x-dai-sender: <sha256 of its endpoint>`). The push is
payloadless Web Push signed with VAPID: it carries no body, so nothing about
the move reaches the push service, and the woken service worker asks this
relay's `head` what moved. A subscription the push service answers 404 or 410
for is forgotten. The opener registers one service worker per mailbox, so each
mailbox has its own endpoint and the relay holds nothing tying one game's
mailbox to another's.

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
