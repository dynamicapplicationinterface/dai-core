import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const probe = resolve(repo, "conformance", "isolation-probe.dai.html");
const isolation = resolve(repo, "conformance", "isolation");
const lax = resolve(repo, "tests", "fixture", "lax-host.html");

interface Result {
  id: string;
  clause: string;
  attempted: string;
  status: "blocked" | "allowed";
  detail: string;
}

/**
 * The published isolation probe, run against this project's own shell.
 *
 * The probe exists for other hosts: §4 describes properties of a runtime, not
 * of a file, so the only way to check them is to be inside one and try. This
 * runs it against ours, on every engine, for the same reason the conformance
 * suite is run here — a suite the maintainers do not run is one nobody else
 * should trust.
 *
 * It also means the probe is checked as a container. A probe that stopped
 * mounting, or whose own script stopped running, would otherwise report nothing
 * and be mistaken for a probe that found nothing.
 */
test.describe("the isolation probe", () => {
  test.skip(!existsSync(probe), "run `npm run conformance` to build the probe");

  test("reports every boundary as held, on this host", async ({ page }) => {
    const reports: { results: Result[] }[] = [];
    await page.exposeFunction("__probeReport", (payload: { results: Result[] }) =>
      reports.push(payload),
    );
    // Collected from the shell, which is where the probe posts: an isolated
    // frame can address no other window.
    await page.addInitScript(() => {
      window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: string };
        if (data?.type === "dai:isolation-report") {
          void (window as unknown as { __probeReport: (payload: unknown) => void }).__probeReport(
            data,
          );
        }
      });
    });

    await page.goto(pathToFileURL(probe).href);

    const app = page.frameLocator("iframe");
    const verdict = app.locator("#verdict");
    await expect(verdict).toHaveAttribute("data-state", /pass|fail|error/, { timeout: 30_000 });

    const rows = await app.locator("#results tr").count();
    // The probe reporting zero findings because it ran zero checks is the
    // failure this catches.
    expect(rows).toBeGreaterThanOrEqual(9);
    await expect(verdict).toHaveAttribute("data-state", "pass");

    await expect.poll(() => reports.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const results = reports[0]!.results;
    expect(results.length).toBeGreaterThanOrEqual(9);

    const allowed = results.filter((result) => result.status !== "blocked");
    expect(allowed, `boundaries not held: ${allowed.map((r) => r.id).join(", ")}`).toEqual([]);

    // Named individually so a check silently disappearing from the probe is a
    // failure here rather than a smaller number nobody notices.
    expect(results.map((result) => result.id).sort()).toEqual(
      [
        "evaluation",
        "handler",
        "inline",
        "network",
        "origin",
        "popup",
        "shell",
        "socket",
        "storage",
      ].sort(),
    );
  });
  test("reports boundaries as missing against a host that holds none", async ({ page }) => {
    /*
     * The probe pointed at a permissive host.
     *
     * Without this the suite proves nothing: a probe that reports "blocked"
     * everywhere passes identically whether it is measuring a real boundary or
     * measuring nothing at all. Here the sandbox grants allow-same-origin and
     * popups and there is no policy, so the answers must change — and the ones
     * that do are exactly the ones the host is responsible for.
     */
    /*
     * Served by a real server rather than intercepted.
     *
     * A module script inside a sandboxed file:// frame never runs, so the probe
     * would report nothing and the silence would read as a pass. An earlier
     * version served it through request interception on a synthetic origin,
     * which WebKit does not reliably apply — the probe then reported nothing
     * for a different reason, and the test failed claiming the permissive host
     * held every boundary.
     */
    const dir = resolve(repo, "apps", "runner", "dist", "lax");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "host.html"), readFileSync(lax, "utf8"));
    for (const name of ["index.html", "probe.js", "probe.css"]) {
      writeFileSync(join(dir, name), readFileSync(join(isolation, name), "utf8"));
    }

    await page.goto("http://localhost:5175/lax/host.html");

    const app = page.frameLocator("#app");
    const verdict = app.locator("#verdict");
    await expect(verdict).toHaveAttribute("data-state", /pass|fail|error/, { timeout: 30_000 });
    await expect(verdict).toHaveAttribute("data-state", "fail");

    // Waited for rather than read once: the verdict appears in the frame's own
    // DOM, and the report reaches this window as a message a task later.
    const collected = await page.waitForFunction(
      () => {
        const reports = (window as unknown as { reports: { results: Result[] }[] }).reports;
        return reports.length > 0 ? reports[0]!.results : null;
      },
      undefined,
      { timeout: 30_000 },
    );
    const results = (await collected.jsonValue()) as Result[];

    const allowed = results.filter((result) => result.status === "allowed").map((r) => r.id);
    // The policy checks, specifically: with no CSP there is nothing to report a
    // violation, and an injected script runs.
    expect(allowed).toContain("inline");
    expect(allowed).toContain("evaluation");
    expect(allowed).toContain("network");
  });
});
