import { expect, test } from "./fixtures.js";

/**
 * D32, reduced to the two frames it happens in.
 *
 * The opener mounts a document by pointing its `#cartridge` frame at a fresh
 * `blob:` URL; that document writes a sandboxed `srcdoc` frame, `#dai-app`, and
 * the application runs in it. About seven reopens in a hundred end with Firefox
 * rendering the document while Playwright never registers the inner frame, so
 * every locator that must enter both waits until it times out.
 *
 * This is that shape and nothing else: no service worker, no storage, no
 * runtime, no document — a page that makes a blob frame, which makes a
 * sandboxed srcdoc frame, which says one word. If it reproduces here, the
 * report upstream is this file. If it does not, the opener does something this
 * page does not, and the next thing to add is named in D32.
 *
 * Run it as a loop with the d32-loop workflow, or here:
 *   npx playwright test tests/d32-minimal.spec.ts --project=firefox --repeat-each=20
 */
const INNER = "<!doctype html><title>inner</title><p id=app>ready</p>";

const OUTER = `<!doctype html><title>outer</title>
<script>
  const frame = document.createElement("iframe");
  frame.id = "dai-app";
  frame.setAttribute("sandbox", "allow-scripts allow-forms");
  frame.srcdoc = ${JSON.stringify(INNER)};
  (document.body ?? document.documentElement).append(frame);
</script>`;

const PAGE = `<!doctype html><title>shell</title>
<script>
  // The mount the opener does: a blob: document in a frame of this page.
  const blob = new Blob([${JSON.stringify(OUTER).split("</").join("<\\/")}], { type: "text/html" });
  const frame = document.createElement("iframe");
  frame.id = "cartridge";
  frame.src = URL.createObjectURL(blob);
  (document.body ?? document.documentElement).append(frame);
</script>`;

test("the inner frame of a blob frame can be entered", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/d32-minimal", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE }),
  );
  await page.goto("http://localhost:5175/d32-minimal");

  const built = await page.evaluate(() => {
    const outer = document.getElementById("cartridge") as HTMLIFrameElement | null;
    return {
      html: document.documentElement.outerHTML.slice(0, 120),
      outer: Boolean(outer),
      src: (outer?.getAttribute("src") ?? "").slice(0, 24),
      outerDoc: outer?.contentDocument?.readyState ?? "unreachable",
      inner: Boolean(outer?.contentDocument?.getElementById("dai-app")),
    };
  });
  console.log("D32 minimal:", JSON.stringify(built), "frames:", page.frames().length);

  // What the opener's tests ask for: the application's own element, through
  // both frames. Bounded well under the file's timeout so a failure is this
  // assertion rather than the runner's clock.
  await expect(page.frameLocator("#cartridge").frameLocator("#dai-app").locator("#app")).toHaveText("ready", {
    timeout: 15_000,
  });

  // And the reading D32 turns on: what the page holds, against what the
  // automation registered.
  const held = await page.evaluate(() => {
    const outer = document.getElementById("cartridge") as HTMLIFrameElement | null;
    const inner = outer?.contentDocument?.getElementById("dai-app") as HTMLIFrameElement | null;
    return { outerWindow: Boolean(outer?.contentWindow), innerWindow: Boolean(inner?.contentWindow) };
  });
  expect(held.outerWindow, "the page holds the blob frame").toBe(true);
  expect(
    page.frames().length,
    `the automation sees both frames; it saw ${page.frames().length} and the page holds ${JSON.stringify(held)}`,
  ).toBeGreaterThanOrEqual(3);
});
