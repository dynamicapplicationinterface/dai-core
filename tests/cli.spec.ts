import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "../src/cli.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(repo, "dist/bin.js");

const APP = [
  "<!doctype html>",
  '<html><head><meta charset="UTF-8"><title>Notes</title></head>',
  '<body><h1>Notes</h1><form id="f"><input id="b" required></form><ul id="l"></ul>',
  '<script type="module">',
  "const db = await window.dai.openDatabase();",
  'db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");',
  "function draw() {",
  "  l.innerHTML = '';",
  '  for (const row of db.selectObjects("SELECT * FROM notes ORDER BY id")) {',
  "    const li = document.createElement('li');",
  "    li.textContent = row.body;",
  "    l.appendChild(li);",
  "  }",
  "}",
  "f.onsubmit = (e) => {",
  "  e.preventDefault();",
  '  db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: [b.value] });',
  "  b.value = '';",
  "  draw();",
  "};",
  "draw();",
  "</script></body></html>",
].join("\n");

/** A project directory somewhere with no node_modules, as a user would have. */
function project(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "dai-cli-"));
  mkdirSync(resolve(dir, "src"));
  writeFileSync(resolve(dir, "src/index.html"), APP);
  return dir;
}

/**
 * Runs the CLI and returns both streams together.
 *
 * Both, because warnings go to stderr while the result goes to stdout — a
 * helper that read only one would quietly assert against half the output.
 */
function dai(args: string[], cwd: string): { out: string; code: number } {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return { out: `${result.stdout ?? ""}${result.stderr ?? ""}`, code: result.status ?? 1 };
}

test.describe("argument parsing", () => {
  test("reads long, short, inline and negated flags", () => {
    const parsed = parseArgs([
      "build",
      "./dist",
      "-o",
      "out.dai.html",
      "--name=My App",
      "-k",
      "key.pem",
      "--no-verify",
      "--quiet",
    ]);

    expect(parsed.command).toBe("build");
    expect(parsed.positional).toEqual(["./dist"]);
    expect(parsed.flags.out).toBe("out.dai.html");
    expect(parsed.flags.name).toBe("My App");
    expect(parsed.flags.key).toBe("key.pem");
    expect(parsed.flags.verify).toBe(false);
    expect(parsed.flags.quiet).toBe(true);
  });

  test("refuses a valued flag with nothing after it", () => {
    // Silently treating the next flag as the value is how you end up writing a
    // container to a file called "--quiet".
    expect(() => parseArgs(["build", "./dist", "--out", "--quiet"])).toThrow(/needs a value/);
  });
});

test.describe("dai build", () => {
  test("packages a directory into a container that runs", async ({ page }) => {
    const dir = project();
    const result = dai(["build", "./src", "-n", "Notes", "-o", "notes.dai.html"], dir);

    expect(result.code).toBe(0);
    // The engine has to come from the CLI's own installation: a user running
    // this in a folder of HTML has no node_modules, and a container without
    // SQLite fails later, in front of whoever opens it.
    expect(result.out).toContain("sqlite3 + glue embedded");

    const file = resolve(dir, "notes.dai.html");
    await page.goto(pathToFileURL(file).href);
    const app = page.frameLocator("iframe");

    // The heading is static HTML and renders even when the application never
    // ran. The row cannot appear until SQLite has booted, and a cold runner
    // takes longer than the default five seconds.
    await expect(app.locator("h1")).toHaveText("Notes", { timeout: 20_000 });
    await app.locator("#b").fill("Ring the dentist");
    await app.locator("#b").press("Enter");
    await expect(app.locator("li")).toHaveText("Ring the dentist", { timeout: 20_000 });
  });

  test("--quiet prints only the path, for scripting", () => {
    const dir = project();
    const result = dai(["build", "./src", "-n", "Notes", "--quiet"], dir);

    expect(result.code).toBe(0);
    expect(result.out.trim().split("\n")).toHaveLength(1);
    // Asserted with the capital the compiler actually produces. A
    // case-insensitive match here would accept the wrong name on the only
    // platform where the name matters.
    expect(result.out.trim()).toMatch(/Notes\.dai\.html$/);
  });

  test("says so when there is nothing to package", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "dai-cli-"));
    mkdirSync(resolve(dir, "empty"));

    const result = dai(["build", "./empty"], dir);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/empty/i);
  });

  test("names a directory that does not exist rather than guessing", () => {
    const result = dai(["build", "./nope"], project());
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/No such directory/);
  });

  test("warns when the app has no entry point", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "dai-cli-"));
    mkdirSync(resolve(dir, "src"));
    writeFileSync(resolve(dir, "src/main.html"), APP);

    const result = dai(["build", "./src"], dir);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/open blank/);
  });
});

test.describe("dai verify", () => {
  test("passes an untouched container and fails an edited one", () => {
    const dir = project();
    dai(["build", "./src", "-n", "Notes", "-o", "notes.dai.html", "--quiet"], dir);

    const intact = dai(["verify", "notes.dai.html"], dir);
    expect(intact.code).toBe(0);
    expect(intact.out).toContain("intact");

    // The payload is base64, so flipping a character in it is the crudest
    // possible tamper — and still has to be caught.
    const file = resolve(dir, "notes.dai.html");
    const html = readFileSync(file, "utf8");
    const at = html.indexOf('id="dai-payload"') + 200;
    writeFileSync(file, html.slice(0, at) + (html[at] === "A" ? "B" : "A") + html.slice(at + 1));

    const broken = dai(["verify", "notes.dai.html"], dir);
    // The exit code is what a pipeline branches on, so it matters as much as
    // the message.
    expect(broken.code).toBe(1);
  });
});

test("prints usage when asked, and when given nothing", () => {
  const dir = project();

  const asked = dai(["--help"], dir);
  expect(asked.out).toContain("dai build");

  const nothing = dai([], dir);
  expect(nothing.code).toBe(2);
  expect(nothing.out).toContain("dai build");
});
