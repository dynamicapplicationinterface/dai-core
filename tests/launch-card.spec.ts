import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { CLAIMS, claimsFor, ISOLATION_CLAUSES } from "../src/host-profile.js";
import { verifyContainer } from "../src/container.js";

const here = dirname(fileURLToPath(import.meta.url));
const CONTAINER = resolve(here, "fixture/fixture.dai.html");
const RUNNER_URL = "http://localhost:5175/";

/**
 * A tick is a claim, and a claim has to be backed.
 *
 * The card tells somebody what the thing they were sent will not be able to
 * do. That is only worth printing if it is true, so every sentence names the
 * §4 clauses it rests on and is shown only while this host applies all of
 * them — the same list it declares to every container it mounts, which the
 * isolation probe checks against reality in host-profile.spec.ts.
 *
 * The chain is: the probe proves the clause, the clause backs the sentence,
 * and the sentence is what a person reads. These hold the middle link.
 */
test.describe("no claim without the clauses behind it", () => {
  test("every claim names clauses this host actually declares", () => {
    // A sentence resting on a clause nobody checks is a sentence nobody
    // checked. Every `needs` must be a clause the probe knows about.
    for (const claim of CLAIMS) {
      expect(claim.needs.length, claim.id).toBeGreaterThan(0);
      for (const need of claim.needs) {
        expect(ISOLATION_CLAUSES, `${claim.id} needs ${need}`).toContain(need);
      }
    }
  });

  test("a host holding everything may say everything", () => {
    expect(claimsFor(ISOLATION_CLAUSES).map((claim) => claim.id)).toEqual(
      CLAIMS.map((claim) => claim.id),
    );
  });

  test("dropping one clause drops the sentence it backed, and only that one", () => {
    for (const claim of CLAIMS) {
      for (const need of claim.needs) {
        const weaker = ISOLATION_CLAUSES.filter((id) => id !== need);
        const said = claimsFor(weaker).map((entry) => entry.id);

        expect(said, `${claim.id} survived without ${need}`).not.toContain(claim.id);
        // And nothing else was quietly lost with it: a claim that vanishes
        // when an unrelated clause goes is a claim that was not really about
        // the clauses it named.
        for (const other of CLAIMS) {
          if (other.needs.includes(need)) continue;
          expect(said, `${other.id} lost when ${need} went`).toContain(other.id);
        }
      }
    }
  });

  test("a host that holds nothing says nothing", () => {
    expect(claimsFor([])).toEqual([]);
  });
});

/**
 * The card itself, on the carrier it exists for.
 *
 * A link is how a document is met on first contact, and until now the whole
 * of that moment was a button naming a hostname.
 */
test.describe("the card a link lands on", () => {
  let server: Server | undefined;
  let origin = "";
  // Read from the very bytes this test serves. The fixture is rebuilt with a
  // fresh key, so a fingerprint written down here would be a different one by
  // the next run.
  let fingerprint = "";

  test.beforeAll(async () => {
    const body = readFileSync(CONTAINER);
    fingerprint = (await verifyContainer(body.toString("utf8"))).publicKeyFingerprint ?? "";
    server = createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "access-control-allow-origin": "*",
      });
      response.end(body);
    });
    await new Promise<void>((listening) => server!.listen(0, "127.0.0.1", listening));
    const address = server.address();
    origin = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
  });

  test.afterAll(() => server?.close());

  const link = () => `${RUNNER_URL}?open=${encodeURIComponent(`${origin}/thing.dai.html`)}`;

  test("shows what it is, who signed it, and what it cannot do — before it runs", async ({
    page,
  }) => {
    await page.goto(link());

    const card = page.locator("#card");
    await expect(card).toBeVisible({ timeout: 30_000 });

    // Nothing has mounted. The card is the decision.
    await expect(page.locator("body")).not.toHaveClass(/loaded/);
    await expect(page.locator("#cartridge")).toBeHidden();

    // Verified facts, not what the file says about itself: this is rendered
    // after verifyContainer, so a name on screen is a name that checked out.
    await expect(page.locator("#card-name")).toHaveText(/fixture/i);
    await expect(page.locator("#card-publisher")).toContainText(/signed|not signed/i);
    await expect(page.locator("#card-from")).toContainText("127.0.0.1");

    // Every tick this host is entitled to, and no others.
    const ticks = await page.locator("#card-claims li").evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.claim),
    );
    expect(ticks).toEqual(claimsFor(ISOLATION_CLAUSES).map((claim) => claim.id));
    await expect(page.locator('#card-claims li[data-claim="offline"]')).toContainText(
      "Can't go online",
    );

    await page.click("#card-open");
    await expect(page.locator("body")).toHaveClass(/loaded/, { timeout: 30_000 });
    await expect(page.locator("#cartridge")).toBeVisible();
    // The card gets out of the way once it has been answered.
    await expect(card).toBeHidden();
  });

  test("the publisher line is the trust check's answer, not the file's claim", async ({
    page,
  }) => {
    // The fixture is signed, and this device has never seen it. A first
    // sighting is named as one: there is nothing yet to compare against, and
    // saying "signed" alone would let a substitution pass as continuity.
    await page.goto(link());
    await expect(page.locator("#card")).toBeVisible({ timeout: 30_000 });

    // Signed by a key this device has not seen, under no name: anonymous.
    // Not a fingerprint on screen — nobody compares those — but a state, and
    // a safety number two people can read to each other (4.3).
    const publisher = page.locator("#card-publisher");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    await expect(publisher).toHaveAttribute("data-state", "anonymous");
    await expect(publisher).toContainText("first time you've seen this key");
    await page.locator("#card-verify").click();
    await expect(page.locator("#card-safety")).toContainText(/Safety number \d{5}/);
  });
});

/**
 * The exit criterion, through the DOM.
 *
 * The table tests above hold the rule; this holds the screen. The card is a
 * renderer over the profile it is handed, so a profile with a clause missing
 * is drawn here and the sentence resting on that clause has to be gone from
 * the list a person reads.
 */
test.describe("a tick this host cannot back is not printed", () => {
  const draw = async (page: import("@playwright/test").Page, applied: readonly string[]) => {
    await page.goto(RUNNER_URL);
    await page.evaluate((clauses) => {
      const runner = (window as unknown as { __runner: { showCard: (input: unknown) => unknown } })
        .__runner;
      void runner.showCard({
        name: "Beach trip",
        publisher: { state: "unsigned" },
        applied: clauses,
      });
    }, applied);
    await expect(page.locator("#card")).toBeVisible();
    return page.locator("#card-claims li").evaluateAll((items) =>
      items.map((item) => (item as HTMLElement).dataset.claim),
    );
  };

  test("with every clause, every sentence", async ({ page }) => {
    expect(await draw(page, ISOLATION_CLAUSES)).toEqual(CLAIMS.map((claim) => claim.id));
  });

  test("without popups, the sentence about windows is gone and the rest remain", async ({
    page,
  }) => {
    const ticks = await draw(
      page,
      ISOLATION_CLAUSES.filter((id) => id !== "popup"),
    );
    expect(ticks).not.toContain("windows");
    expect(ticks).toContain("offline");
    expect(ticks).toContain("contained");
    expect(ticks).toContain("sealed");
  });

  test("without the network clause, the card stops saying it cannot go online", async ({
    page,
  }) => {
    const ticks = await draw(
      page,
      ISOLATION_CLAUSES.filter((id) => id !== "network"),
    );
    expect(ticks).not.toContain("offline");
    await expect(page.locator("#card-claims")).not.toContainText("Can\'t go online");
  });

  test("a host that holds nothing prints no ticks at all", async ({ page }) => {
    expect(await draw(page, [])).toEqual([]);
  });
});
