/**
 * The runner's service worker.
 *
 * The point of the runner is to be installable and to work with no network at
 * all — a container is offline software, and a player that needs connectivity
 * to start would defeat it. So everything same-origin is cached, and offline
 * is answered from the cache.
 *
 * But not cache-first for the shell. The first version was, under a fixed
 * cache name, and this file never changed between deploys — so a browser that
 * had visited once kept the first build it ever saw, for ever. Every deploy
 * after that was invisible to anyone who had been before, and the website was
 * handing documents to an opener from weeks earlier that did not know how to
 * receive one. The page showed its empty chooser, and nothing said why.
 *
 * So: the shell (a navigation, or index.html) goes to the network first and
 * falls back to the cache only when the network fails. Hashed assets under
 * /assets/ are immutable by name and stay cache-first. And the cache name
 * carries a version, so a change here drops what the old worker kept.
 *
 * Note this caches the *runner*, never a container. Containers arrive from the
 * user's own filesystem and are stored separately; they are never fetched.
 */
const CACHE = "dai-runner-v2";

// The shell, by stable URL. Hashed asset URLs are unknown here and are picked
// up by the runtime cache on first use instead.
const PRECACHE = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing entry cannot fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Where a shared container waits between the share sheet and the page.
 *
 * Android hands a shared file to the manifest's share target as a POST, and a
 * POST cannot navigate the app: the response would replace the page. So the
 * worker takes the file out of the form, keeps it here, and redirects to the
 * app, which collects it. Nothing about this reaches a network.
 */
const SHARED = "dai-shared-v1";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const target = new URL(request.url);

  if (request.method === "POST" && target.pathname.endsWith("/shared")) {
    event.respondWith(
      (async () => {
        try {
          const form = await request.formData();
          const file = form.get("container");
          if (file && typeof file !== "string") {
            const cache = await caches.open(SHARED);
            // Stored as a response so the name survives alongside the bytes;
            // the page needs both to report what it opened.
            await cache.put(
              "./shared-container",
              new Response(file, {
                headers: {
                  "content-type": file.type || "application/octet-stream",
                  "x-dai-name": encodeURIComponent(file.name || "shared.dai"),
                },
              }),
            );
            return Response.redirect("./?shared=1", 303);
          }
        } catch {
          /* Falls through to the app, which will say nothing arrived. */
        }
        return Response.redirect("./?shared=0", 303);
      })(),
    );
    return;
  }

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /** Fetches, and keeps a copy of anything worth keeping. */
  const fromNetwork = () =>
    fetch(request).then((response) => {
      // Opaque and error responses are not worth persisting.
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    });

  // The shell: whatever is deployed now, and the cache only when there is no
  // network to ask. A navigation with a hash or query is still the one page.
  const isShell =
    request.mode === "navigate" || url.pathname === "/" || url.pathname.endsWith("/index.html");

  if (isShell) {
    event.respondWith(
      fromNetwork().catch(() =>
        caches.match(request).then((hit) => hit || caches.match("./index.html")),
      ),
    );
    return;
  }

  // Everything else — hashed assets, icons, the manifest — is fine from the
  // cache, because a new shell names new assets and never the old ones.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fromNetwork().catch(() => {
        throw new Error("offline and not cached");
      });
    }),
  );
});
