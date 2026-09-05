import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { unzipSync, zipSync } from "fflate";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTAINER = resolve(repo, "tests", "fixture", "fixture.dai.html");

/**
 * Who the bridge will listen to.
 *
 * Every message the bridge acts on used to be accepted from whoever posted it.
 * A window holding a reference to a container could announce itself as a host
 * and be believed, which turns a save into a message sent to a stranger and
 * lets a page that verified nothing tell an application its work is on disk.
 *
 * The nonce does not establish that a host is honest — an embedder can echo it
 * as easily as anyone. It establishes that a message came from the party the
 * handshake was completed with, which is the claim that can actually be made
 * from inside a frame, and it is the one that was missing.
 */

/** A page that frames a container and answers the handshake as a host would. */
const hostPage = (containerUrl: string, echo: "correct" | "wrong" | "none") => `
<!doctype html>
<meta charset="utf-8">
<title>host</title>
<iframe id="frame" src="${containerUrl}" style="width:100%;height:80vh;border:0"></iframe>
<script>
  window.seen = [];
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || typeof data !== "object") return;
    window.seen.push(data.type);

    if (data.type === "DAI_HOST_REFUSED") {
      window.refusalNonce = data.payload && data.payload.sessionNonce;
    }

    if (data.type === "DAI_HOST_HANDSHAKE") {
      window.handshakeNonce = data.payload && data.payload.sessionNonce;
      const payload =
        ${JSON.stringify(echo)} === "correct"
          ? { bridgeVersion: 1, sessionNonce: window.handshakeNonce }
          : ${JSON.stringify(echo)} === "wrong"
            ? { bridgeVersion: 1, sessionNonce: "not-the-one-it-sent" }
            : { bridgeVersion: 1 };
      event.source.postMessage({ type: "DAI_HOST_HANDSHAKE_ACK", payload }, "*");
    }
  });
</script>`;

/**
 * Asks for a save from inside the application.
 *
 * These tests used to post `dai:save` at the shell from the host page. That is
 * a window forging a message the application alone may send, and the shell now
 * ignores it — which would leave the two negative cases below passing because
 * the message never arrived rather than because the nonce was wrong. A test
 * that cannot fail for its stated reason is worse than no test.
 */
const saveFromApp = async (browser: Page): Promise<void> => {
  await browser
    .frameLocator("#frame")
    .frameLocator("#dai-app")
    .locator("body")
    .evaluate(async () => {
      const app = window as unknown as {
        dai?: { saveState: (bytes: unknown, options: unknown) => Promise<unknown> };
      };
      for (let i = 0; i < 200 && !app.dai; i++) {
        await new Promise((settle) => setTimeout(settle, 50));
      }
      // Not awaited: these fixture hosts never acknowledge a save, so the
      // promise the application is holding never settles.
      void app.dai!.saveState(null, { method: "auto" });
    });
};

const page = (echo: "correct" | "wrong" | "none"): string => {
  const dir = mkdtempSync(join(tmpdir(), "dai-bridge-"));
  const file = join(dir, "host.html");
  writeFileSync(file, hostPage(pathToFileURL(CONTAINER).href, echo));
  return file;
};

test.describe("the handshake nonce", () => {
  test("the container invents one and sends it with the handshake", async ({ page: browser }) => {
    await browser.goto(pathToFileURL(page("correct")).href);

    const nonce = await browser.waitForFunction(
      () => (window as unknown as { handshakeNonce?: string }).handshakeNonce,
      undefined,
      { timeout: 30_000 },
    );

    // Sixteen bytes of randomness, hex-encoded. A predictable value would be
    // no better than the absent one it replaces.
    expect(await nonce.jsonValue()).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a save reaching the host carries it", async ({ page: browser }) => {
    /*
     * The message that writes over a file. A host now ignores one that does not
     * carry the value it was given, so the container has to send it on every
     * message rather than only at the start.
     */
    await browser.goto(pathToFileURL(page("correct")).href);
    await browser.waitForFunction(
      () => (window as unknown as { handshakeNonce?: string }).handshakeNonce,
      undefined,
      { timeout: 30_000 },
    );

    const nonce = (await browser.evaluate(
      () => (window as unknown as { handshakeNonce: string }).handshakeNonce,
    )) as string;

    // Armed before the application is asked, so nothing is missed in between.
    await browser.evaluate(() => {
      (window as unknown as { savedNonce: string | null }).savedNonce = null;
      window.addEventListener("message", function onSave(event: MessageEvent) {
        const data = event.data as { type?: string; sessionNonce?: string };
        if (data?.type !== "DAI_HOST_SAVE") return;
        window.removeEventListener("message", onSave);
        (window as unknown as { savedNonce: string | null }).savedNonce = data.sessionNonce ?? "";
      });
    });

    await saveFromApp(browser);
    await browser.waitForFunction(
      () => (window as unknown as { savedNonce: string | null }).savedNonce !== null,
      undefined,
      { timeout: 30_000 },
    );

    expect(
      await browser.evaluate(
        () => (window as unknown as { savedNonce: string | null }).savedNonce,
      ),
    ).toBe(nonce);
  });

  test("an acknowledgement echoing the wrong value is not a host", async ({ page: browser }) => {
    /*
     * The attack the nonce closes: a window that never handshook with this
     * container, answering as though it had. It is refused, so the container
     * keeps handling saves itself rather than posting them to a stranger.
     */
    await browser.goto(pathToFileURL(page("wrong")).href);
    await browser.waitForFunction(
      () => (window as unknown as { handshakeNonce?: string }).handshakeNonce,
      undefined,
      { timeout: 30_000 },
    );

    await browser.evaluate(() => {
      (window as unknown as { posted: boolean }).posted = false;
      window.addEventListener("message", (event: MessageEvent) => {
        if ((event.data as { type?: string })?.type !== "DAI_HOST_SAVE") return;
        (window as unknown as { posted: boolean }).posted = true;
      });
    });

    // The application asks, and is answered by its own container rather than
    // by a window whose acknowledgement did not check out.
    await saveFromApp(browser);
    await browser.waitForTimeout(3000);

    expect(await browser.evaluate(() => (window as unknown as { posted: boolean }).posted)).toBe(
      false,
    );
  });

  test("an acknowledgement with no value at all is not a host either", async ({ page: browser }) => {
    // The shape every host sent before this existed. Refusing it is a
    // deliberate break: a host that has not been updated is one whose saves
    // this container should not be routing anywhere.
    await browser.goto(pathToFileURL(page("none")).href);
    await browser.waitForFunction(
      () => (window as unknown as { handshakeNonce?: string }).handshakeNonce,
      undefined,
      { timeout: 30_000 },
    );

    await browser.evaluate(() => {
      (window as unknown as { posted: boolean }).posted = false;
      window.addEventListener("message", (event: MessageEvent) => {
        if ((event.data as { type?: string })?.type !== "DAI_HOST_SAVE") return;
        (window as unknown as { posted: boolean }).posted = true;
      });
    });

    // The application asks, and is answered by its own container rather than
    // by a window whose acknowledgement did not check out.
    await saveFromApp(browser);
    await browser.waitForTimeout(3000);

    expect(await browser.evaluate(() => (window as unknown as { posted: boolean }).posted)).toBe(
      false,
    );
  });

  test("a refusal reaches the host, and carries the value too", async ({ page: browser }) => {
    /*
     * A refusal is the entry an audit trail most needs, so it has to reach the
     * host — and a host now has a way to tell it apart from one posted by a
     * window that never mounted anything.
     *
     * The tampering is inside the payload rather than to the shell. A container
     * cannot detect its own bootloader being rewritten, because that check
     * would run inside the code that was replaced; §8 of the specification says
     * so, and a test that expected otherwise would be asserting a property this
     * format explicitly does not claim.
     */
    const tampered = mkdtempSync(join(tmpdir(), "dai-bridge-bad-"));
    const file = join(tampered, "broken.dai.html");

    const original = readFileSync(CONTAINER, "utf8");
    const parts = /(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(<\/script>)/.exec(original)!;
    const archive = unzipSync(Buffer.from(parts[2]!, "base64"));
    const target = Object.keys(archive).find((name) => name.endsWith(".js"))!;
    archive[target] = new TextEncoder().encode("/* replaced after sealing */");
    writeFileSync(
      file,
      original.replace(
        /(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(<\/script>)/,
        (_m, open: string, __: string, close: string) =>
          open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
      ),
    );

    const host = join(tampered, "host.html");
    writeFileSync(host, hostPage(pathToFileURL(file).href, "correct"));

    await browser.goto(pathToFileURL(host).href);
    await browser.waitForFunction(
      () => (window as unknown as { seen: string[] }).seen.includes("DAI_HOST_REFUSED"),
      undefined,
      { timeout: 30_000 },
    );

    const carried = await browser.evaluate(
      () => (window as unknown as { refusalNonce?: string }).refusalNonce,
    );
    expect(carried).toMatch(/^[0-9a-f]{32}$/);
  });
});
