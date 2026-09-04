# The runner

Opens a container on a device that cannot execute one from its filesystem —
which is every iPhone, and most Android configurations. A phone will not run a
`.dai.html` out of its Files app, so the code has to arrive from somewhere; this
is that somewhere.

Everything else about a container is unchanged. It mounts in the same sandbox,
against the same bootloader, and is verified the same way. This is a host, not a
second implementation.

## Where the data goes

Onto the device, and nowhere else. Databases are written to the Origin Private
File System, keyed by document UUID, so closing the app and opening it again
finds the rows where they were left. Nothing is uploaded; there is no server
side to upload to. The deployment is static files.

Because OPFS is scoped to an origin rather than a path, the origin this is
served from is where every user's documents are filed **on their own device**.
Moving it later does not delete anything, but it does strand it — the data stays
filed under an address the app no longer answers at, and installed home-screen
copies point at the old one. Choose the origin once.

For the same reason it belongs on its own subdomain rather than a path on a site
that might one day carry a third-party script: any code served from an origin
can read what that origin has stored on the device.

## Offline

`public/sw.js` caches the runner's own shell, cache-first. After one visit the
app opens with no network at all, which matters for something whose whole claim
is offline software. It caches the runner and never a container: containers come
from the user's filesystem and are stored separately.

## Deploying

A Vercel project with its root directory set to `apps/runner`.

| Setting | Value |
|---|---|
| Root Directory | `apps/runner` |
| Build Command | `cd ../.. && npm ci && npm run build && cd apps/runner && npx vite build` |
| Output Directory | `dist` |

The build reaches back to the repository root because the runner imports the
container reader from `src/`, which has to be built first.

`vercel.json` sets the headers that matter: `no-cache` on the shell, the worker
and the manifest so updates actually land; immutable caching on hashed assets;
and cross-origin isolation, which SQLite's fast OPFS engine requires and which
cannot be added retroactively to files already cached on someone's phone.

HTTPS is not optional — service workers and OPFS both need a secure context.

## Getting a container into it

Three ways in, and none of them upload anything.

**Choosing a file.** The picker, with no type filter — iOS greys out anything a
filter does not name and the Files app has no type for `.dai`.

**A link.** `?open=<url>` opens any address this page is allowed to read: a file
on Dropbox, in a bucket, on a GitHub raw URL, on a company file share. That
makes a container shareable without infrastructure belonging to this project. A
relay would be a convenience for people with nowhere to put a file, not the
mechanism — which is what keeps "the file needs no server" true.

Most web servers do not allow other sites to read their files, and a browser
reports that identically to being offline. The runner says which is likely,
because otherwise the blame lands here.

**A share.** On Android, the share sheet delivers a file as a POST to the share
target. A POST cannot navigate an app, so the service worker takes the file out
of the form, parks it, and redirects; the page collects it and deletes it. A
file left parked would reappear at the next launch, which is somebody's document
opening itself without being asked for.

Whichever way it arrives, it is verified before it runs. Where bytes came from
says nothing about what they are.
