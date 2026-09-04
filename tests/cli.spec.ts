import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync, zipSync } from "fflate";
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

test.describe("verify --json", () => {
  /*
   * The verdict in a shape a program can branch on.
   *
   * The exit code says whether a container is intact. Anything that wanted to
   * know why has had to read prose written for a person, which makes a tool
   * depend on the wording of a sentence — and the wording changes, as it did
   * this week when a damaged database stopped being reported as tampering.
   */
  const build = (): { dir: string; out: string } => {
    const dir = mkdtempSync(resolve(tmpdir(), "dai-json-"));
    writeFileSync(resolve(dir, "index.html"), "<!doctype html><title>J</title><p>hi");
    const out = resolve(dir, "app.dai.html");
    spawnSync(process.execPath, [cli, "build", dir, "-o", out, "--quiet"], { cwd: repo });
    return { dir, out };
  };

  test("reports an intact container as data, and exits zero", () => {
    const { out } = build();
    const run = spawnSync(process.execPath, [cli, "verify", out, "--json"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      documentUuid: string;
      shell: string;
      signature: { status: string };
      entries: { name: string; status: string }[];
    };

    expect(report.ok).toBe(true);
    expect(report.documentUuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.shell).toBe("ok");
    expect(report.signature.status).toBe("unsigned");
    expect(report.entries.every((entry) => entry.status === "ok")).toBe(true);
  });

  test("names what failed, and still exits non-zero", () => {
    const { out } = build();
    // The same tampering the security page invites people to try.
    const html = readFileSync(out, "utf8");
    const parts = /(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(<\/script>)/.exec(html)!;
    const archive = unzipSync(Buffer.from(parts[2]!, "base64"));
    archive["app/index.html"] = new TextEncoder().encode("<!doctype html><p>changed");
    writeFileSync(
      out,
      html.replace(
        /(<script[^>]*id="dai-payload"[^>]*>)([\s\S]*?)(<\/script>)/,
        (_m, open: string, __: string, close: string) =>
          open + Buffer.from(zipSync(archive, { level: 9 })).toString("base64") + close,
      ),
    );

    const run = spawnSync(process.execPath, [cli, "verify", out, "--json"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      entries: { name: string; status: string }[];
    };

    expect(report.ok).toBe(false);
    const failed = report.entries.filter((entry) => entry.status !== "ok");
    expect(failed.map((entry) => entry.name)).toContain("app/index.html");
    expect(failed[0]!.status).toBe("mismatch");
  });

  test("writes nothing but JSON, so a pipe can read it", () => {
    // A warning on stdout would make the output unparseable, which is the
    // commonest way a --json flag turns out not to work.
    const { out } = build();
    const run = spawnSync(process.execPath, [cli, "verify", out, "--json"], {
      cwd: repo,
      encoding: "utf8",
    });

    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });
});
