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

## Deferred, as ruled

Retention (trimming a mailbox) and entitlement (who may append or subscribe)
are not here. When retention lands, it is a lifecycle rule on the `mailbox/`
prefix. Push (a subscription so a waiting copy is told rather than polling) is
slice two.
