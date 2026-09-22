# Deploying what is on main

The runbook. `docs/deploying.md` is the reasoning behind the two static sites —
origins, caching, the store credential — and is worth reading once. This is the
sequence to follow, in order, with the check that each half is live.

Three things ship, and only the first two are needed for a person to open a
document:

| | Where | Deployed by |
|---|---|---|
| the website | `www.dynamicapplicationinterface.io` | Vercel, promoted by hand |
| **the opener** | `opendai.app` | Vercel, promoted by hand |
| **the relay** | a Cloudflare Worker | `wrangler`, from this machine |

**Order matters once.** The opener carries the relay's address in its page,
stamped at build from `DAI_RELAY_BASE`. If the relay's address is changing, or
it is being deployed for the first time, the relay goes first and the opener is
built afterwards; otherwise the opener build points at nothing and the mailbox
and the version check are both off in that build.

---

## 1. The relay

```bash
cd apps/relay
npx wrangler deploy --dry-run
```

Read what it prints before publishing: the bindings (`MAILBOX`, `VERSION`,
`MAILBOX_R2`) and the migrations it would apply. Then:

```bash
npx wrangler deploy
```

### What the VersionDO migration does to the mailboxes

`wrangler.toml` now carries two migrations:

```toml
[[migrations]]
tag = "v1"
new_sqlite_classes = ["MailboxDO"]

[[migrations]]
tag = "v2"
new_sqlite_classes = ["VersionDO"]
```

`v1` has already been applied on the deployed worker, and Cloudflare applies
only the tags that have not run. So this deploy applies `v2` alone, and `v2`
**creates a new class**. It does not rename, move or delete anything.

- **Every existing mailbox object keeps its storage**: its counter, its
  digest→cursor index and its push subscriptions are untouched, and the sealed
  bytes in R2 are not read or written by this at all.
- **No mailbox is migrated**, because none has to be: `MailboxDO`'s code is
  unchanged by this release except that the worker in front of it now routes a
  second path.
- **The destructive migration kinds are `deleted_classes` and
  `renamed_classes`.** Deleting a class deletes the storage of every object of
  that class, and it cannot be undone. Neither appears in this file, and
  neither should be added without a separate decision.

### The window while it rolls out

The worker and its Durable Objects do not change version at the same instant.
`apps/relay/README.md` states the rule that comes out of that: **check with a
read before you post anything**, because a POST meant for a new route can land
in an old object as an append — a batch in somebody's mailbox.

For this release the new route is safe to call during the window, and it is the
cleanest way to tell the versions apart: the old worker has no `/v/` route and
answers `not found` with 404, and the new one answers JSON. Nothing about a POST
to `/v/` can be mistaken for a mailbox append, because the old code does not
route it anywhere.

### Push keys

Unchanged by this release. If they are being set for the first time,
`apps/relay/README.md` has the sequence; note that **rotating VAPID keys
silently breaks every push subscription already made** — devices re-subscribe on
their next open, and any wake owed to them before that is lost.

---

## 2. The opener

1. Push to `main`; Vercel builds both projects.
2. Set or confirm the build environment on the **opener** project
   (Settings → Environment Variables), Production:
   - `DAI_RELAY_BASE` — **the mailbox path, including `/m`**, e.g.
     `https://relay.opendai.app/m`. The mailbox client appends the document to
     whatever it is given, which is why the `/m` belongs here. The version door
     is `/v` on the same worker and the opener derives it from this value's
     origin, so there is one address to set and not two.
   - `DAI_PUSH_PUBLIC_KEY` — the relay's VAPID public key, if push is on.
   - the store credentials, which `docs/deploying.md` lists.
3. Promote that commit's deployment to production in Vercel. **A push is not a
   release**: a preview looks identical from outside.

---

## 3. Check both halves are live

### The opener

```bash
npm run deploys
```

It asks each site what commit it is serving and exits non-zero until both match
the checkout. It reads `version.json`, which the build writes beside the page.

Then read the stamp a person can read, because that is the one in the bytes: open
`https://opendai.app`, open the menu (⋯), and the sheet shows the build — for
example `4135982 · 2026-09-22`. A preview that was never promoted says so
(`· preview`), which is exactly the case this catches.

### The relay

The mailbox, with a read (safe at any time):

```bash
curl -s https://relay.opendai.app/m/00000000-0000-4000-8000-000000000000/head
```

A cursor — `0` for a mailbox nobody has written to. Anything else means the
route is not live.

The version door, which is live only after this release:

```bash
curl -s -X POST https://relay.opendai.app/v/00000000-0000-4000-8000-000000000000 \
  -H 'content-type: application/json' \
  -d '{"version":"none","publisher":""}'
```

- `{"current":null,"successor":null}` — live, and nothing announced for that id,
  which is right for an id nobody uses.
- `not found` — the old worker is still answering; the deploy has not rolled to
  this route yet.

It is a POST, and it is still a safe check: it takes the version door's own
path, which the old worker does not route, and it writes nothing but a
check-in count under an id that belongs to nobody.

---

## What is irreversible, or as good as

- **Deleting or renaming a Durable Object class** in a future migration deletes
  that class's storage. Every mailbox is one object of one class.
- **Changing the opener's origin** strands every library saved under the old
  one; storage is scoped per origin. `docs/deploying.md` argues this at length.
- **Rotating the VAPID keys** invalidates every push subscription in existence.
- **Publishing an announcement to the version relay** reaches everybody using
  that document on their next check. An author can replace their own notice
  with a newer one — the relay takes a replacement only under the same key —
  but there is no way to un-say one that has already been read, and a copy that
  has already updated has updated.
- **Promoting a deployment** is reversible: Vercel keeps the previous one, and
  `npx wrangler rollback` returns the worker to its last version. Neither
  rollback undoes storage that the newer code wrote.

## If something looks wrong

- `npx wrangler deployments list` (in `apps/relay`) — what is live and what was
  before it.
- `npx wrangler tail` — the worker's live log.
- The opener's own diagnostics are in the menu, under the build stamp: which
  worker build is answering, whether storage is kept, and the last breadcrumbs.
