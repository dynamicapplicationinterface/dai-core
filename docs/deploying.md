# Deploying

Two sites, both static, both built from this repository:

| | |
|---|---|
| `www.dynamicapplicationinterface.io` | the website, built from `website/` |
| `opendai.app` | the opener, built from `apps/runner/`. `www` and the old `run.dynamicapplicationinterface.io` both redirect to it |

**A push is not a release.** Production is promoted by hand, so a successful
build and a live change are different events. A preview deployment looks
identical to a promoted one from outside — same content, same behaviour, a URL
nobody is using — which is exactly how a fix can appear finished for an hour
while everybody keeps hitting the old one.

## Releasing

1. Push to `main`. Both projects build.
2. In Vercel, promote the deployment for that commit to production.
3. Check it:

```bash
npm run deploys
```

Each site reports the commit it is serving, when it was built, and whether it is
production. The command exits non-zero until both are serving the commit checked
out here, so it can gate anything that should wait for a promotion.

```
this checkout: 4135982

website  ok   current
runner   ok   current
```

## The opener lives at opendai.app

Everything a person is pointed at — the nav, the phone section, the page for
somebody holding a file, and the sentence that travels with a shared file — uses
`https://opendai.app`.

The apex currently redirects to `www.opendai.app`, which means the app runs, and
therefore stores every document, on the `www` origin. **Which one is canonical
has to be settled once and left alone**: storage is scoped per origin, so
changing it later strands every library saved before the change. Linking to the
apex is safe either way — the redirect keeps the path and query — but the
decision itself should not be deferred.

### Keep the old address, as a redirect and not a second copy

Anything already sent points at it, and a container that arrived by link should
not stop opening because the name got shorter. There are two ways to honour
that, and only one of them is safe.

**Serve the app at both addresses** — a DNS record pointing the old host at the
same deployment — and you get two origins running one app. Storage is scoped per
origin, so a person who opened files through an old link has a library at the
old address and an empty one at the new address, and which one they see depends
on which message they happened to tap. Documents appearing and disappearing
according to the link somebody used is the worst kind of bug: silent, and shaped
exactly like data loss. It also gives you two service workers, two installable
apps with the same name and icon, and two cache generations to keep in step.

**Answer the old address with a redirect** and one origin owns all storage. Old
links keep working and land where new ones do.

DNS cannot do this. A DNS record gets a request to a server; the server decides
what to answer with. So the old host keeps pointing at Vercel, and Vercel is
configured to redirect that domain — the record stays, the answer changes.

Two details:

- **The redirect must preserve the path and query.** A share link carries
  `?open=<url>`, so `run.…/?open=https://…` has to arrive as
  `opendai.app/?open=https://…`. Vercel's domain redirect does this; confirm it
  rather than assume it, because a link that loses its query looks to the person
  who followed it like the file failed to open.
- **Anyone who added the old address to their home screen should remove and
  re-add it.** Their library does not follow, and a standalone app that
  redirects across origins tends to bounce out into a browser tab. Which is the
  argument for doing this while that is nobody.

## Store credentials, and why nothing deployed has one

The write credential for the bucket is the only secret this project has. It
lives in `.env.local`, beside the repository, ignored by git. `.env.example` is
committed, holds every name and no values, and is what tells you what to fill
in:

    cp .env.example .env.local
    # then DAI_S3_ENDPOINT, DAI_S3_BUCKET, DAI_S3_ACCESS_KEY_ID,
    # DAI_S3_SECRET_ACCESS_KEY, DAI_S3_PUBLIC_BASE

A real environment variable beats the file, so CI and a shell export behave the
way anybody would expect. Set some of the five and not all of them and
publishing refuses outright — silently falling back to a local directory
because one name was misspelled is how somebody hands out a `file:` link
believing they published something.

**Nothing deployed needs any of this, and that is a property worth keeping.**

| | reads a store | needs a credential |
|---|---|---|
| the opener | a blob, over HTTPS, from a public URL | no |
| the edge middleware | a sidecar, the same way | no |
| `dai publish` / the MCP server | writes | **yes** |

The opener runs in a browser on a device belonging to whoever was sent a link,
so anything it held would be readable by them. The middleware builds a preview
out of a public object; there is nothing there to authenticate. Only publishing
is a write, and publishing happens on the machine of the person doing it.

So a credential should never appear in Vercel's environment, in a browser
bundle, or inside a container. If one ever has to, the design has changed in a
way that needs arguing about rather than configuring around —
`tests/credentials.spec.ts` fails if the opener or the middleware so much as
mentions one, checks that `.env*` is ignored while `.env.example` is not, and
scans every tracked file for a committed key.

## Caching, and the part that must not be cached

`/assets/*` is served `immutable` for a year. Those filenames carry a hash of
their own contents, so a change produces a new name and the old one is never
asked for again — which makes a year-long cache safe and saves every returning
visitor a revalidation round trip.

**`/runtime/*` is deliberately excluded, and extending the rule to cover it
would be a correctness bug.** Those names are stable — `sqlite3.wasm`,
`dai-runtime.js`, `template.html` — and their contents change every time the
shell or the bootloader is rebuilt. Cached immutably, a returning visitor would
compile containers with a months-old bootloader, and there would be no way to
reach them: the stale copy lives in their browser rather than on our server.

It is the staging trap in a worse place. When the committed copies under
`website/public/runtime` went stale, one redeploy fixed it. A stale copy in
somebody's cache cannot be fixed at all.

`/shots/*` is excluded for the same reason and lower stakes: stable names,
contents that change when a screenshot is retaken. A stale screenshot is
cosmetic; the rule is the same.

`tests/website-headers.spec.ts` fails if that ever changes.

## The one that bites

The website serves the container shell, the bootloader and the SQLite engine as
**committed files** under `website/public/runtime/`. Nothing regenerates them at
deploy time, so a change to `src/template.html` or `src/runtime/bootloader.ts`
reaches `dist` and every test here while the site keeps handing out the previous
version — green, deployed, and wrong.

```bash
npm run build && node scripts/build-demo-pair.mjs
```

`tests/staged-runtime.spec.ts` fails until that has been run, which is the only
reason it stopped happening.
