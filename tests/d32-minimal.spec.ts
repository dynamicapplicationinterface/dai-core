import type { Browser, Page } from "@playwright/test";
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

// The page is a mock, and the runner's worker serves same-origin requests
// cache-first: without this it can answer before the route does, and the test
// would be looking at the opener rather than at these two frames.
test.use({ serviceWorkers: "block" });

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

/** Opens the mock page, with the runner's worker kept out of the way. */
async function mockPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/d32-minimal", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE }),
  );
  await page.goto("http://localhost:5175/d32-minimal");
  return page;
}

/** The application's element, through both frames, within a bound. */
const enterable = (page: Page, timeout = 15_000): Promise<boolean> =>
  page
    .frameLocator("#cartridge")
    .frameLocator("#dai-app")
    .locator("#app")
    .waitFor({ state: "attached", timeout })
    .then(() => true, () => false);

/** Points the shell's frame at about:blank, then at a fresh blob of the same document. */
async function remount(page: Page): Promise<void> {
  await page.evaluate(
    ([outer]) => {
      const frame = document.getElementById("cartridge") as HTMLIFrameElement;
      frame.src = "about:blank";
      // The next mount on the turn after, as the opener's eject-then-mount does.
      setTimeout(() => {
        const blob = new Blob([outer], { type: "text/html" });
        frame.src = URL.createObjectURL(blob);
      }, 50);
    },
    [OUTER],
  );
}

/**
 * Variant (a): a second mount in the same page.
 *
 * Every sighting of D32 is a reopen, never a first open, and the opener's
 * reopen points the same `#cartridge` at `about:blank` and then at a fresh
 * blob. One mount did not reproduce it in 210 runs; this is the next rung.
 */
test("the inner frame can be entered after a second mount in the same page", async ({ browser }) => {
  const page = await mockPage(browser);
  expect(await enterable(page), "the first mount is enterable").toBe(true);

  await remount(page);
  const entered = await enterable(page);
  if (!entered) {
    const held = await page.evaluate(() => {
      const outer = document.getElementById("cartridge") as HTMLIFrameElement | null;
      const inner = outer?.contentDocument?.getElementById("dai-app") as HTMLIFrameElement | null;
      return {
        outerWindow: Boolean(outer?.contentWindow),
        outerDoc: outer?.contentDocument?.readyState ?? "unreachable",
        innerPresent: Boolean(inner),
        innerWindow: Boolean(inner?.contentWindow),
      };
    });
    console.log(`D32 second mount: unenterable; page holds ${JSON.stringify(held)}, automation sees ${page.frames().length} frames`);
  }
  expect(entered, "the second mount is enterable").toBe(true);
});

/**
 * Variant (b): a navigation between the mounts.
 *
 * What the failing tests do — `goto` the same address again, which is a fresh
 * document with a fresh shell, and then mount into it.
 */
test("the inner frame can be entered after a navigation between mounts", async ({ browser }) => {
  const page = await mockPage(browser);
  expect(await enterable(page), "the first mount is enterable").toBe(true);

  await page.goto("about:blank");
  await page.goto("http://localhost:5175/d32-minimal");
  const entered = await enterable(page);
  if (!entered) {
    const held = await page.evaluate(() => {
      const outer = document.getElementById("cartridge") as HTMLIFrameElement | null;
      const inner = outer?.contentDocument?.getElementById("dai-app") as HTMLIFrameElement | null;
      return {
        outerWindow: Boolean(outer?.contentWindow),
        outerDoc: outer?.contentDocument?.readyState ?? "unreachable",
        innerPresent: Boolean(inner),
        innerWindow: Boolean(inner?.contentWindow),
      };
    });
    console.log(`D32 after navigation: unenterable; page holds ${JSON.stringify(held)}, automation sees ${page.frames().length} frames`);
  }
  expect(entered, "the mount after a navigation is enterable").toBe(true);
});
