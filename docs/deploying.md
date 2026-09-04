# Deploying

Two sites, both static, both built from this repository:

| | |
|---|---|
| `www.dynamicapplicationinterface.io` | the website, built from `website/` |
| `run.dynamicapplicationinterface.io` | the runner, built from `apps/runner/` |

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

## Moving the opener to opendai.app

Not done yet: the address below still points at
`run.dynamicapplicationinterface.io`, and it stays there until the new domain
resolves. Pointing the site at an address that does not answer would be worse
than a long one.

**Do it early.** The opener stores every document's data in the browser's
per-origin storage, so moving it strands every library saved at the old address.
The `.dai` files themselves are untouched — that is the point of the format —
but somebody would have to open them again. The installed base is approximately
nobody today and grows every week.

When the domain answers, the address changes in these places:

| | |
|---|---|
| `website/components/PhoneFlow.vue` | the `OPENER` constant |
| `website/components/MakerWalkthrough.vue`, `MakeYourOwn.vue` | the link in the after-build steps |
| `website/open.md` | the link for somebody holding a file |
| `website/.vitepress/config.ts` | the nav entry |
| `apps/runner/src/main.ts` | the `OPENER` constant in the share text |
| `apps/runner/index.html` | the empty state's hint |
| `docs/deploying.md`, `scripts/check-deploys.mjs` | this table, and the deployment check |

Keep the old address serving a redirect afterwards. Anything already sent points
at it, and a container that arrived by link should not stop opening because the
name got shorter.

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
