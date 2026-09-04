import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { buildContainer } from "../src/core.js";

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

/**
 * The kit is in the container whichever way the container was built.
 *
 * It was added in the command-line door only. The browser door — the website's
 * — did not add it, so every file made on the make-one page referenced a
 * dai-kit.js that was not there: the page drew, nothing ran, and the Add
 * button did nothing. The command line and every test were fine, which is why
 * this is checked at the engine and not at a door.
 */
test.describe("the kit ships from the engine", () => {
  test("a container built straight from the core carries it", async () => {
    const built = await buildContainer({
      files: { "index.html": new TextEncoder().encode('<!doctype html><script type="module" src="./dai-kit.js"></script>') },
      template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
      runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
      appName: "Kit",
    });
    const payload = /<script[^>]*id="dai-payload"[^>]*>([\s\S]*?)<\/script>/.exec(built.html)![1]!;
    const archive = unzipSync(Buffer.from(payload, "base64"));
    expect(Object.keys(archive)).toContain("app/dai-kit.js");
    expect(new TextDecoder().decode(archive["app/dai-kit.js"]!)).toContain("customElements.define('dai-rows'");
  });

  test("no door adds it on its own", () => {
    // A second place that adds the kit is a place that can be the only place.
    for (const door of ["src/compile.ts", "src/browser.ts"]) {
      expect(readFileSync(resolve(repo, door), "utf8")).not.toContain("KIT_SOURCE");
    }
  });
});

/**
 * An application's own icon becomes the document's icon.
 *
 * Every document used to get this project's mark, which is right for a file
 * about this project and wrong for somebody's packing list. The recipe asks
 * the assistant for an icon.svg; this is the compiler honouring it.
 */
test.describe("the document's own icon", () => {
  const shell = () => ({
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
  });
  const page = new TextEncoder().encode("<!doctype html><p>hi");

  test("an icon.svg among the files is the icon", async () => {
    const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#d9663c"/></svg>';
    const built = await buildContainer({
      files: { "index.html": page, "icon.svg": new TextEncoder().encode(icon) },
      appName: "Beach trip",
      ...shell(),
    });
    expect(built.manifest.favicon).toBe("data:image/svg+xml," + encodeURIComponent(icon));
    // And the shell shows it, so a tab has it before anything runs.
    expect(built.html).toContain(encodeURIComponent(icon).slice(0, 40));
  });

  test("a file that is not an SVG is not trusted as one", async () => {
    // This string ends up in the shell. Only a thing that is an SVG gets there.
    const built = await buildContainer({
      files: { "index.html": page, "icon.svg": new TextEncoder().encode("<script>alert(1)</script>") },
      appName: "Nope",
      ...shell(),
    });
    expect(built.manifest.favicon).not.toContain("script");
  });

  test("the recipe asks for one", async () => {
    const { RECIPE } = await import("../src/recipe.js");
    expect(RECIPE).toContain("icon.svg");
    expect(RECIPE).toMatch(/home screen/i);
  });
});
