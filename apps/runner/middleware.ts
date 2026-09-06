/**
 * Link previews, at the edge. Backlog 3.3.
 *
 * An enhancement and nothing more. `/d/<id>` is served the opener's own
 * document by a rewrite in `vercel.json`, and that is what makes a reference
 * link work at all — on a mirror with no functions, on a static bucket,
 * anywhere. This adds the name and icon a chat client shows before anybody
 * taps, by filling a placeholder in that same document.
 *
 * It reads the sidecar and never the blob, so nothing it fetches is the
 * document. It never sees the key: the key lives in the fragment, and a
 * fragment is not sent to a server, so there is nothing here to leak. And it
 * never fails a request — a document the store has never held, or no longer
 * holds, is served the page with its generic tags, because the opener says
 * what happened far better than an error page would.
 *
 * A store may decline previews entirely by not being configured here, or by
 * refusing to serve the sidecar. Either way this falls back.
 */
import { injectPreview, documentIdFrom, type Preview } from "../../src/unfurl.js";

export const config = {
  // Only reference links. Everything else is served straight from the CDN,
  // which is the point of a static opener.
  matcher: "/d/:id",
};

/**
 * Where the sidecars are.
 *
 * Read per request rather than at module load, because at the edge this module
 * outlives any one deployment's environment, and because a test that stands a
 * store up has nowhere to put it otherwise. Unset is not an error: previews go
 * away, links do not.
 */
function storeBase(): string {
  // The same name the presign endpoint reads, because it is the same fact:
  // where the public reads this bucket. Two names for one thing is how a
  // deployment ends up half-configured with both of them set to something.
  return process.env.DAI_STORE_PUBLIC_BASE ?? "https://store.opendai.app/";
}

export default async function middleware(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const id = documentIdFrom(url.pathname);

  // The document the rewrite would have served. Fetched from this origin, so
  // it is the deployed index.html with whatever the build put in it.
  const page = await fetch(new URL("/", url), { headers: { accept: "text/html" } });
  const html = await page.text();

  // Not a reference link. The matcher should not have sent it here, but a
  // path that does not name a document has no preview to look up either way.
  if (!id) {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  let preview: Preview | undefined;
  let expired = false;
  try {
    const sidecar = await fetch(new URL(`${id}.json`, storeBase()));
    if (sidecar.ok) {
      preview = ((await sidecar.json()) as { preview?: Preview }).preview;
    } else if (sidecar.status === 404 || sidecar.status === 410) {
      expired = true;
    }
  } catch {
    /* The store is unreachable. The link still opens; there is simply no preview. */
  }

  const { html: body, cacheControl } = injectPreview(
    html,
    preview,
    new URL(`${id}.png`, storeBase()).href,
    { expired },
  );

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheControl,
      // The same headers the static page is served with; a preview must not be
      // a hole in them.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
