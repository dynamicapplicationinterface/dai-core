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

test.describe("dai check", () => {
  /*
   * The question that comes before "is this container intact".
   *
   * `verify` refuses a container because somebody changed it. `check` refuses
   * source because it does something a container cannot do, which is not a
   * fault so much as a fact nobody has told the author yet — usually a model,
   * which is why the machine-readable form matters as much as the prose.
   */
  const app = (files: Record<string, string>): string => {
    const dir = mkdtempSync(resolve(tmpdir(), "dai-check-"));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(resolve(dir, name), body);
    }
    return dir;
  };

  const check = (dir: string, ...args: string[]) =>
    spawnSync(process.execPath, [cli, "check", dir, ...args], { cwd: repo, encoding: "utf8" });

  test("passes source that will work, and says so", () => {
    const dir = app({
      "index.html": '<!doctype html><title>Fine</title><script type="module" src="./app.js"></script>',
      "app.js": "const db = await window.dai.openDatabase();\n",
    });

    const run = check(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("ready to build");
  });

  test("refuses source that cannot work inside a container", () => {
    const dir = app({
      "index.html": '<!doctype html><script src="https://cdn.example.com/x.js"></script>',
    });

    const run = check(dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("loads a script from the internet");
    // Every finding says what to do instead. A refusal that only names the
    // problem sends an author back to the same mistake.
    expect(run.stdout).toContain("Inline the library");
  });

  test("reports findings as data, for something that is not a person", () => {
    const dir = app({
      "index.html": "<!doctype html><title>x</title>",
      "app.js": 'const rows = await fetch("/api/rows");\n',
    });

    const run = check(dir, "--json");
    expect(run.status).toBe(1);

    const report = JSON.parse(run.stdout) as {
      ok: boolean;
      hasEntryPoint: boolean;
      storesDataInTheFile: boolean;
      findings: { file: string; id: string; fix: string }[];
    };

    expect(report.ok).toBe(false);
    expect(report.hasEntryPoint).toBe(true);
    expect(report.findings.map((finding) => finding.id)).toContain("network-call");
    expect(report.findings[0]!.file).toBe("app.js");
    expect(report.findings[0]!.fix).toBeTruthy();
  });

  test("notices there is no way in", () => {
    // A container with no index.html mounts a blank frame, which looks exactly
    // like a broken file to whoever opened it.
    const dir = app({ "app.js": "const db = await window.dai.openDatabase();\n" });

    const run = check(dir, "--json");
    expect(run.status).toBe(1);
    expect((JSON.parse(run.stdout) as { hasEntryPoint: boolean }).hasEntryPoint).toBe(false);
  });

  test("says when nothing is stored in the file, without refusing it", () => {
    /*
     * An application that keeps nothing is a legitimate thing to build. It is
     * worth reporting because "my data vanished" is what somebody says
     * afterwards about a file that was never keeping any.
     */
    const dir = app({ "index.html": "<!doctype html><title>Static</title><p>hello" });

    const run = check(dir, "--json");
    expect(run.status).toBe(0);
    const report = JSON.parse(run.stdout) as { ok: boolean; storesDataInTheFile: boolean };
    expect(report.ok).toBe(true);
    expect(report.storesDataInTheFile).toBe(false);
  });
});

/**
 * A document published without its engine, at the command line.
 *
 * `dai build --thin` leaves the engine out for a host that already holds those
 * exact bytes. `dai verify` on what it has just produced must not read as
 * damage: a tool that tells somebody they broke a file it made for them a
 * moment ago teaches them to ignore it.
 */
test.describe("verifying a document published without its engine", () => {
  test("reads as intact, completed from the engine installed here", async () => {
    const { thinned } = await import("../src/container.js");
    const { parseContainer } = await import("../src/container.js");
    const { compileDirectory } = await import("../src/compile.js");

    const source = mkdtempSync(resolve(tmpdir(), "dai-cli-thin-"));
    writeFileSync(
      resolve(source, "index.html"),
      '<!doctype html><meta charset="utf-8"><p>thin</p>',
      "utf8",
    );
    const built = await compileDirectory({ sourceDir: source, root: repo, appName: "Thin" });

    // Derived from the signed build rather than built again: nothing signed
    // twice is the same file, so a second build would be a second document.
    const file = resolve(source, "thin.dai.html");
    writeFileSync(file, thinned(parseContainer(built.html)), "utf8");

    const run = spawnSync(process.execPath, [cli, "verify", file], { encoding: "utf8" });

    expect(run.stdout).toContain("intact");
    expect(run.stdout).toMatch(/0 not matching/);
    expect(run.status).toBe(0);
  });
});
