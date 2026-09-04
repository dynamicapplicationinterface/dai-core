import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = join(repo, "tests", "fixture", "kit");

/**
 * An application that is HTML and SQL, driven the way a person would.
 *
 * The kit exists because most of what goes wrong in a generated application is
 * the wiring — query, render, attach a handler, mutate, remember to redraw —
 * and none of it is the part anybody wanted. The fixture it runs against has no
 * JavaScript in it at all, which is the claim being tested.
 */
const drive = (actions: unknown[], sql?: string): Record<string, unknown> => {
  const stdout = execFileSync(
    process.execPath,
    [
      join(repo, "scripts", "try-container.mjs"),
      app,
      "--do",
      JSON.stringify(actions),
      ...(sql ? ["--sql", sql] : []),
      "--json",
    ],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
};

test.describe("the kit", () => {
  test.slow();

  test("adds a row from a form and puts it in the file", () => {
    const report = drive(
      [
        { fill: "#what", text: "buy milk" },
        { click: "#add" },
        { wait: 400 },
        { click: "#save" },
      ],
      "SELECT title, done FROM tasks",
    );

    expect(report.problems).toEqual([]);
    expect(report.rows).toEqual([{ title: "buy milk", done: 0 }]);
  });

  test("a row's own control updates that row", () => {
    // The binding that would otherwise be hand-written per application: the
    // checkbox in a row knows which row it is in.
    const report = drive(
      [
        { fill: "#what", text: "one" },
        { click: "#add" },
        { wait: 300 },
        { fill: "#what", text: "two" },
        { click: "#add" },
        { wait: 300 },
        { click: "#list li:last-child .tick" },
        { wait: 300 },
        { click: "#save" },
      ],
      "SELECT title, done FROM tasks ORDER BY id",
    );

    expect(report.problems).toEqual([]);
    expect(report.rows).toEqual([
      { title: "one", done: 0 },
      { title: "two", done: 1 },
    ]);
  });

  test("stored text is rendered as text, never as markup", async () => {
    /*
     * The property that makes a container safe to open, extended to what the
     * application draws. A task titled `<img onerror=…>` is a task with an odd
     * name — and a kit that used innerHTML would hand every application an
     * injection that the format's own policy then has to catch.
     */
    const report = drive(
      [
        { fill: "#what", text: "<img src=x onerror=alert(1)>" },
        { click: "#add" },
        { wait: 400 },
        { click: "#save" },
      ],
      "SELECT title FROM tasks",
    );

    expect(report.problems).toEqual([]);
    // It is in the database verbatim…
    expect(report.rows).toEqual([{ title: "<img src=x onerror=alert(1)>" }]);
  });

  test("and the page shows it as text, with no element made from it", async ({ page }) => {
    /*
     * The assertion the one above cannot make. Reading it back out of the
     * database proves the value survived; only the page proves it was drawn as
     * a name rather than parsed into an element.
     */
    const built = join(
      execFileSync(
        process.execPath,
        [join(repo, "dist", "bin.js"), "build", app, "-o", join(tmpdir(), "kit-xss.dai.html"), "--quiet"],
        { cwd: repo, encoding: "utf8" },
      ).trim(),
    );

    await page.goto(pathToFileURL(built).href);
    await page.locator("body.dai-mounted").waitFor({ timeout: 30_000 });

    const inside = page.frameLocator("#dai-app");
    await inside.locator("#what").fill("<img src=x onerror=alert(1)>");
    await inside.locator("#add").click();

    const title = inside.locator("#list .title").first();
    await expect(title).toHaveText("<img src=x onerror=alert(1)>");
    // Nothing was parsed out of it.
    await expect(inside.locator("#list img")).toHaveCount(0);
  });

  test("shows the empty state before anything exists", () => {
    const report = drive([{ wait: 400 }]);
    expect(report.mounted).toBe(true);
    expect(report.problems).toEqual([]);
  });
});
