import { test as base, expect } from "@playwright/test";
import type { Browser, BrowserContext } from "@playwright/test";

/**
 * Every context a test opens is closed when the test ends, however it ends.
 *
 * A test that makes its own contexts closes them on its last lines, and a test
 * that throws never reaches those lines. The contexts, their pages, their
 * service workers and their mailbox polling then outlive it for the rest of the
 * worker. One test here fails by design on every run (D80), so this was not a
 * rare state: it was every run, and it is the shape of the local run that hung
 * at 1407 of 1412 on 19 September (D83).
 *
 * Playwright's own `browser` fixture is worker-scoped and hands every test the
 * same browser, so what is tracked is `newContext` on that shared object,
 * patched for the length of one test and put back afterwards. Tests in a file
 * share a worker and run one at a time (`fullyParallel: false`), so no other
 * test is opening contexts while the patch is in place.
 *
 * Specs that make contexts import `test` from here instead of from
 * `@playwright/test`. Everything else about it is unchanged, and `expect` is
 * re-exported so a spec needs one import line, not two.
 */
export const test = base.extend<{ closesItsContexts: void }>({
  closesItsContexts: [
    async ({ browser }, use) => {
      const opened: BrowserContext[] = [];
      const mine = browser as Browser & { newContext: Browser["newContext"] };
      const original = mine.newContext.bind(browser);
      mine.newContext = async (...options: Parameters<Browser["newContext"]>) => {
        const context = await original(...options);
        opened.push(context);
        return context;
      };
      try {
        await use();
      } finally {
        mine.newContext = original;
        // Closing what a test closed already is not an error; closing what it
        // could not reach is the point.
        for (const context of opened) await context.close().catch(() => undefined);
      }
    },
    { auto: true },
  ],
});

export { expect };
