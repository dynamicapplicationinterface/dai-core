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
