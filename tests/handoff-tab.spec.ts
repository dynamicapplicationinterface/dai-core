import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { HANDOFF, OPENER_READY, handOffToOpener, receiveHandoff } from "../src/handoff-tab.js";
import type { Poster } from "../src/handoff-tab.js";

/**
 * A pair of fake windows, so the protocol can be driven without two browsers.
 *
 * These cover the parts that are awkward to provoke for real — a hostile origin
 * posting a ready, a document arriving from somewhere that is not allowed. The
 * test below them opens two actual tabs and hands a real container across,
 * because a handshake that only works against a mock is a handshake that has
 * never been used.
 */
function fakeWindow() {
  const handlers = new Set<(event: MessageEvent) => void>();
  return {
    window: {
      addEventListener: (_: "message", handler: (event: MessageEvent) => void) => {
        handlers.add(handler);
      },
      removeEventListener: (_: "message", handler: (event: MessageEvent) => void) => {
        handlers.delete(handler);
      },
    },
    deliver(origin: string, data: unknown) {
      for (const handler of [...handlers]) handler({ origin, data } as MessageEvent);
    },
    get listening() {
      return handlers.size;
    },
  };
}

test.describe("handing a document to another tab", () => {
  test("a ready from the wrong origin gets nothing", async () => {
    const sender = fakeWindow();
    const sent: unknown[] = [];
    const tab: Poster = { postMessage: (data) => void sent.push(data) };

    const handoff = handOffToOpener(
      tab,
      { name: "a.dai.html", bytes: new Uint8Array([1, 2, 3]) },
      { origin: "https://opendai.app", window: sender.window, timeoutMs: 200 },
    );

    // Any page on the web can post to the tab that built the document. If a
    // ready from one of them were enough, somebody's document would be sent to
    // a window they never opened.
    sender.deliver("https://elsewhere.example", { type: OPENER_READY });
    expect(sent).toEqual([]);

    await expect(handoff).rejects.toThrow(/did not respond/);
  });

  test("a document from a disallowed origin is not opened", async () => {
    const receiver = fakeWindow();
    const opened: unknown[] = [];

    receiveHandoff(
      { postMessage: () => {} },
      (document_) => void opened.push(document_),
      { allows: (origin) => origin === "https://good.example", window: receiver.window },
    );

    receiver.deliver("https://bad.example", {
      type: HANDOFF,
      name: "x.dai.html",
      bytes: new Uint8Array([1]),
    });
    expect(opened).toEqual([]);

    // And is still listening, so one rejected message does not deafen it to the
    // real sender arriving a moment later.
    expect(receiver.listening).toBe(1);
  });

  test("a name cannot say anything about where bytes go", async () => {
    const receiver = fakeWindow();
    const opened: { name: string }[] = [];

    receiveHandoff({ postMessage: () => {} }, (document_) => void opened.push(document_), {
      allows: () => true,
      window: receiver.window,
    });

    receiver.deliver("https://good.example", {
      type: HANDOFF,
      name: "../../etc/passwd",
      bytes: new Uint8Array([1]),
    });

    expect(opened[0]!.name).not.toContain("/");
    expect(opened[0]!.name).not.toContain("\\");
  });

  test("the receiver stops listening once it has a document", async () => {
    const receiver = fakeWindow();
    const opened: unknown[] = [];

    receiveHandoff({ postMessage: () => {} }, (document_) => void opened.push(document_), {
      allows: () => true,
      window: receiver.window,
    });

    const message = { type: HANDOFF, name: "a.dai.html", bytes: new Uint8Array([1]) };
    receiver.deliver("https://good.example", message);
    receiver.deliver("https://good.example", message);

    // One tab runs one document. A second arrival would replace what somebody
    // is already looking at.
    expect(opened).toHaveLength(1);
  });
});

/*
 * The whole path, across two real origins.
 *
 * Everything above proves the protocol against fake windows, which is exactly
 * the kind of test that keeps passing while the feature is broken. This opens a
 * second tab from a page on a different origin, hands a real container over,
 * and waits for it to be running — the thing somebody actually does.
 *
 * The sending page is served by the test rather than by a server: it needs to
 * be on a different origin from the opener and on localhost (which is what the
 * opener will accept a document from), and standing up a second web server to
 * deliver twenty lines of HTML would be more machinery than the thing it tests.
 *
 * It runs the real `handOffToOpener`, injected by source. The two message names
 * go in with it, because a function serialised out of a module leaves its
 * module scope behind — which has bitten this repository before, as a
 * ReferenceError inside a check that was supposed to be protecting data.
 */
test("a document crosses from one origin to another and runs", async ({ page, context }) => {
  const container = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "fixture/fixture.dai.html"));

  await page.route("http://localhost:5199/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><title>Sender</title><body>
        <script>
          const OPENER_READY = ${JSON.stringify(OPENER_READY)};
          const HANDOFF = ${JSON.stringify(HANDOFF)};
          const handOffToOpener = ${handOffToOpener.toString()};
          window.hand = (bytes, origin) => {
            const tab = window.open(origin + "/#handoff", "_blank");
            return handOffToOpener(tab, { name: "handed.dai.html", bytes: new Uint8Array(bytes) }, { origin, window });
          };
        <\/script>
      </body>`,
    }),
  );

  await page.goto("http://localhost:5199/");

  const opened = context.waitForEvent("page");
  await page.evaluate(
    ([bytes, origin]) =>
      (window as unknown as { hand: (b: number[], o: string) => Promise<void> }).hand(
        bytes as number[],
        origin as string,
      ),
    [[...container], "http://localhost:5175"] as const,
  );

  const runner = await opened;
  // Not a download, not a file picker: the document is simply running.
  await expect(runner.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
  await expect(runner.locator("#cartridge")).toBeVisible();
  // Named by the manifest inside the document, not by the name the sending
  // page attached. A sender says where bytes came from; it does not get to say
  // what they are.
  await expect(runner.locator("#title")).toContainText("fixture");
});
