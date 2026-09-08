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
const CACHE = "dai-runner-v7";

// The shell, by stable URL. Hashed asset URLs are unknown here and are picked
// up by the runtime cache on first use instead.
// The engine is here because a document published without one (spec §6.2)
// cannot run unless this app has those bytes, and "works with no network at
// all" has to include that document. It is the largest thing precached by a
// long way, which is the trade: a megabyte once, against every thin document
// afterwards opening offline.
const PRECACHE = [
  // "./" and not "./index.html": the host answers the second with a redirect
  // to the first, and a *redirected* response stored here and later served
  // for a navigation is one Safari refuses outright — "Response served by
  // service worker has redirections". A phone test found it on the second
  // link ever opened: the first came from the network, the second missed the
  // cache and landed on the redirected fallback. See `clean` below too.
  "./",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./runtime/sqlite3.wasm",
  "./runtime/sqlite3.mjs",
];

/**
 * The app's own bundle, whose name nobody here can know.
 *
 * Vite writes hashed filenames, so they cannot be listed above, and leaving
 * them to the runtime cache does not work: on a first visit the page's scripts
 * are fetched before this worker controls anything, so they are never cached,
 * and the first time somebody is offline the app fails to load with the shell
 * served perfectly from cache. That is how it failed — the HTML arrived, the
 * JavaScript did not, and the page sat empty with nothing to say.
 *
 * So the names are read from the document that references them. This makes the
 * worker independent of the build's naming, which is the same reason it is not
 * generated.
 */
async function appAssets() {
  const html = await (await fetch("./index.html", { cache: "reload" })).text();
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    // Same-origin build output only. An absolute URL is somebody else's server
    // and has no business in this cache.
    if (url.startsWith("./assets/") || url.startsWith("/assets/")) found.add(url);
    // The confusable table (spec §9.6) is content-hashed too, and named in the
    // page by a prefetch link so this worker can find it the same way.
    if (/^\.?\/?confusables\.[0-9a-f]+\.json$/.test(url)) found.add(url);
  }
  return [...found];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (cache) => {
        const urls = [...PRECACHE, ...(await appAssets().catch(() => []))];
        // Individually, so one missing entry cannot fail the whole install.
        await Promise.allSettled(urls.map((url) => cache.add(url)));
      })
      .then(() => self.skipWaiting()),
  );
});

/*
 * What an update may throw away: earlier versions of *this* cache, and
 * nothing else. The document icons and manifests, and a share parked between
 * the share sheet and the page, live in caches of their own with lives of
 * their own — and a sweep that deleted everything but the current shell
 * cache erased every home-screen manifest on every update, and any share
 * that happened to be in flight.
 */
const OURS = "dai-runner-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key.startsWith(OURS) && key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * A response a navigation may be answered with.
 *
 * A response that arrived by following a redirect carries that fact, and a
 * browser will not let a worker answer a navigation with one. The shell's
 * bytes are what matter; they go out in a fresh response with the same
 * headers and no history.
 */
async function clean(response) {
  if (!response || !response.redirected) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(await response.arrayBuffer(), { status: 200, headers });
}

/**
 * The shell, introducing itself as the document it is about to open.
 *
 * iOS takes a home-screen icon's name, picture and launch address from the
 * web app manifest the page linked when it *loaded* — a phone test showed
 * that a manifest swapped in later, or one at a data: URL, is not read, and
 * the icon came out as the opener's. So when a navigation names a document
 * this page has described (`?doc=<uuid>`) and the page has put that
 * document's manifest in the cache, the shell goes out with that manifest
 * linked, that icon, that title. The cached copy of the shell is never the
 * rewritten one; this happens on the way out.
 */
async function describedAs(response, url) {
  const uuid = url.searchParams.get("doc");
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid) || !response || !response.ok) return response;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  const manifestAddress = new URL(`/doc-manifests/${uuid}.webmanifest`, self.location.origin).href;
  const hit = await caches.match(manifestAddress);
  if (!hit) return response;
  let manifest;
  try {
    manifest = await hit.json();
  } catch {
    return response;
  }
  const attr = (value) =>
    String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const name = attr(manifest.name);
  // For apple-touch-icon, an address: iOS ignores a data: URL in that tag.
  // The manifest keeps its data: icon, which is the one iOS's Add to Home
  // Screen actually uses.
  const addressed = (manifest.icons || []).find((entry) => entry && typeof entry.src === "string" && !entry.src.startsWith("data:"));
  const icon = addressed ? attr(addressed.src) : null;

  let html = await response.text();
  /*
   * The first paint is the document's, not the opener's. Without this the
   * page shows "DAI Opener" and the chooser for as long as it takes the
   * script to read the address and mount — a flash of the wrong app on
   * every launch from an icon. The header gets the name and icon here, and
   * `launching` hides the chooser until the script either mounts the
   * document or finds it is not held and takes the class off.
   */
  html = html
    .replace(/<body(\s[^>]*)?>/, (tag, rest) => `<body class="launching"${rest ?? ""}>`)
    .replace(/<span id="title"><\/span>/, `<span id="title">${name}</span>`)
    .replace(/<p id="launch-name"><\/p>/, `<p id="launch-name">${name}</p>`)
    .replace(/<img id="launch-icon"([^>]*?)\s*hidden\s*\/?>/, (tag, rest) =>
      icon ? `<img id="launch-icon"${rest} src="${icon}" />` : tag)
    .replace(/<img id="title-icon"([^>]*?)\s*hidden\s*\/?>/, (tag, rest) =>
      icon ? `<img id="title-icon"${rest} src="${icon}" />` : tag)
    .replace(/<link\s+rel="manifest"\s+href="[^"]*"\s*\/?>/, `<link rel="manifest" href="${attr(manifestAddress)}" />`)
    .replace(/<meta\s+name="apple-mobile-web-app-title"\s+content="[^"]*"\s*\/?>/, `<meta name="apple-mobile-web-app-title" content="${name}" />`)
    .replace(/<title>[^<]*<\/title>/, `<title>${name}</title>`);
  if (icon) {
    html = html.replace(/<link\s+rel="apple-touch-icon"\s+href="[^"]*"\s*\/?>/, `<link rel="apple-touch-icon" href="${icon}" />`);
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(html, { status: 200, headers });
}

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
    /*
     * Anyone can post here, and the worker cannot tell who.
     *
     * A plain cross-site form needs no permission to POST a file to this
     * address and navigate the person in to collect it. The header that would
     * say so — Sec-Fetch-Site — is attached by the browser *after* a worker
     * has seen the request, so a check on it here runs against nothing; a
     * test proved that by posting from another origin straight through one.
     * What a worker does see is the referrer, which a page can withhold.
     *
     * So this does not gate. It records the referrer for the page to label
     * the card with, and the real protection is that the opener no longer
     * records a document's key until the person presses Open: a file posted
     * in by a stranger's website gets a card that says where it came from,
     * and nothing else happens unless they choose it.
     */
    const origin = (() => {
      try {
        return request.referrer ? new URL(request.referrer).origin : "";
      } catch {
        return "";
      }
    })();
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
                  "x-dai-referrer": origin,
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

  /*
   * The measurement pages answer for themselves.
   *
   * Every navigation below is treated as the shell, which is right for the
   * opener and wrong for anything else served from this origin: /probe would
   * be handed index.html and never load. It also has to bypass the cache on
   * principle — a page whose job is to report what this browser still holds
   * cannot be a copy this worker kept.
   */
  if (url.pathname === "/probe" || url.pathname.startsWith("/probe/")) return;

  /*
   * A document's own manifest is that document's, not a shared asset.
   *
   * `/m/<id>.webmanifest` is per-document: it names one document's icon,
   * start address and scope. It is not a navigation, so it would not be
   * mistaken for the shell — it would fall to the branch below, which caches
   * by URL forever on the reasoning that a name carrying a content hash is the
   * same bytes. These names carry a document id, and the document behind an id
   * can be replaced, so that reasoning does not hold and the icon on somebody's
   * home screen would be the one from the first time they ever opened it.
   *
   * Exempted before the route exists, because the same mistake has now been
   * made once (see /probe above) and finding it a second time on a phone costs
   * an afternoon.
   */
  if (url.pathname.startsWith("/m/")) return;

  /*
   * The build stamp is the one file that must never be remembered.
   *
   * It exists to answer "which deploy am I looking at", and a cached copy
   * answers it with the deploy before. That is the exact failure it was
   * written to end, so a worker holding it would be worse than not having it.
   */
  if (url.pathname === "/version.json") return;

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
    /*
     * From the cache at once, and the network in the background.
     *
     * This was network-first: whatever is deployed now, and the cache only
     * when the network fails. Correct, and slow in exactly the place it
     * shows — a home-screen icon launching a document this device already
     * holds waited on a round trip (or, offline, on the failure) before
     * painting anything. Now a cached shell answers immediately and the
     * network's copy replaces it in the cache for next time, so the shell
     * is at most one launch behind a deploy; a new worker taking over
     * reloads an idle page anyway (see main.ts).
     */
    event.respondWith(
      (async () => {
        /*
         * A reference link's head is written at the edge, and a cached shell
         * does not have it.
         *
         * `/d/<id>` and `/p/<id>` rewrite to this same page, and the edge
         * fills the placeholder with that document's title and apple-touch
         * icon. Those two tags are exactly what iOS reads at Add to Home
         * Screen. Served the generic shell out of the cache instead, an
         * install of a shared document is named and iconed as the reader —
         * the bug that `describedAs` exists to prevent, arriving by another
         * door and only for people who have used the opener before, since a
         * first-ever visitor has no worker yet and reaches the edge. It would
         * pass on any fresh device and fail for everyone real.
         *
         * `describedAs` cannot cover it: that reads a manifest this device
         * cached for a document it holds, and a reference link is for a
         * document it has never held.
         *
         * So these go to the network first. Nothing is given up by it: a
         * reference link has to reach the store for the document itself, so a
         * cached shell buys no offline launch here — only a wrong name on the
         * home screen. The cache is still the fallback, because offline the
         * opener saying it could not reach the store beats a browser error,
         * and an install is not happening then anyway.
         */
        const perDocument = url.pathname.startsWith("/d/") || url.pathname.startsWith("/p/");
        const cached = perDocument
          ? (await caches.match(request)) || (await caches.match(url.pathname))
          : (await caches.match(request)) ||
            (await caches.match(url.pathname)) ||
            (await caches.match("./")) ||
            (await caches.match("./index.html"));
        const network = fromNetwork();
        if (perDocument && !cached) {
          try {
            return describedAs(await clean(await network), url);
          } catch {
            const generic = (await caches.match("./")) || (await caches.match("./index.html"));
            if (generic) return describedAs(await clean(generic), url);
            throw new Error("offline and not cached");
          }
        }
        if (cached) {
          /*
           * A newer shell arrived behind a page running the old one.
           *
           * "At most one launch behind a deploy" was every launch after a
           * deploy running the build before it, and an afternoon of phone
           * tests measured the wrong build three times over. So the page is
           * told, and reloads while there is still nothing to lose (see
           * main.ts): on the chooser, or on the launch screen before a
           * document has mounted. Under an open document it waits.
           */
          event.waitUntil(
            network
              .then(async (fresh) => {
                const [was, now] = await Promise.all([cached.clone().text(), fresh.clone().text()]);
                if (was === now) return;
                const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
                for (const page of pages) page.postMessage({ type: "dai:shell-updated" });
              })
              .catch(() => {}),
          );
          return describedAs(await clean(cached), url);
        }
        return describedAs(await clean(await network), url);
      })(),
    );
    return;
  }

  /*
   * Everything else — hashed assets, icons, the engine — is fine from the
   * cache, because a new shell names new assets and never the old ones.
   *
   * Matched by URL as well as by request. A reload carries `cache: "reload"`
   * down into every subresource it asks for, and a request in that mode does
   * not match a stored entry; the symptom was the whole app failing to load
   * offline with its own bundle sitting in the cache, and a hand-written
   * fetch for the identical URL answering perfectly from the same worker.
   * Matching the URL is what a cache is for here: these names carry a content
   * hash, so the same name is the same bytes.
   */
  event.respondWith(
    caches
      .match(request)
      .then((hit) => hit || caches.match(url.pathname))
      .then((hit) => {
        if (hit) return hit;
        return fromNetwork().catch(() => {
          throw new Error("offline and not cached");
        });
      }),
  );
});
