/**
 * Builds an application, opens it, uses it, and reports what reached the file.
 *
 * The gap this fills is the one between "it compiled" and "it works". A
 * container can build cleanly, pass every digest, mount without complaint, and
 * still be useless — a button wired to nothing, a save that writes an empty
 * database, a schema the code never creates. None of that is visible to a
 * compiler, and all of it is visible to somebody who opens the file and types
 * into it, which is exactly what nobody does when a machine is writing the
 * application.
 *
 * So this does it: drives the application the way a person would, triggers its
 * own save, and reads the database out of the file that came back. "The data a
 * person entered is in the file they were handed" is the property worth
 * asserting, and it cannot be checked any other way.
 *
 *   node scripts/try-container.mjs ./app \
 *     --do '[{"fill":"#compose input","text":"milk"},{"press":"Enter"},{"click":"#save"}]' \
 *     --sql "SELECT count(*) AS n FROM tasks" \
 *     --json
 *
 * Development tooling rather than part of the published command line: it needs
 * a browser, and `dai` ships with two runtime dependencies and no browser among
 * them. A harness that forced Playwright into the package would be a strange
 * price for everybody who only wanted to build a file.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(message) {
  process.stderr.write(
    `${message}\n\n` +
      "usage: node scripts/try-container.mjs <directory|container> [options]\n" +
      "  --do <json>    actions to perform, as [{click|fill|press|wait: …}]\n" +
      "  --sql <query>  run against the database in the saved file\n" +
      "  --json         report as JSON rather than prose\n",
  );
  return 2;
}

function parse(argv) {
  const options = { target: undefined, actions: [], sql: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--json") options.json = true;
    else if (token === "--do") options.actions = JSON.parse(argv[++i] ?? "[]");
    else if (token === "--sql") options.sql = argv[++i];
    else if (!token.startsWith("-")) options.target = token;
  }
  return options;
}

/** Compiles a directory, or takes a container as it is. */
function containerFor(target) {
  const path = resolve(process.cwd(), target);
  if (!existsSync(path)) throw new Error(`Nothing at ${path}.`);
  if (!statSync(path).isDirectory()) return { path, built: false };

  const out = join(mkdtempSync(join(tmpdir(), "dai-try-")), "app.dai.html");
  execFileSync(process.execPath, [join(repo, "dist", "bin.js"), "build", path, "-o", out, "--quiet"], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { path: out, built: true };
}

/**
 * Opens a container and waits for its application to be on screen.
 *
 * Two frames down: the shell mounts the container's own frame, which mounts the
 * application. The shell marks itself when the application reports in, which is
 * the only signal that means anything a person would call ready.
 */
async function open(browser, container) {
  const page = await browser.newPage({ acceptDownloads: true });

  /*
   * Take the file picker away, so a save takes the download path.
   *
   * An application asks to save without saying how, and the runtime prefers the
   * picker when the browser has one. Chromium has one and dismisses it
   * instantly without a user gesture, so the save quietly does nothing and the
   * harness reports an application that saved nothing — which is
   * indistinguishable from an application whose save button is broken, and that
   * is the exact failure this exists to catch.
   *
   * Removing it leaves the anchor path, which is the one Safari and Firefox use
   * anyway, and the only one a machine can drive.
   */
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });

  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(String(error)));

  await page.goto(pathToFileURL(container).href);
  await page.locator("body.dai-mounted").waitFor({ timeout: 30_000 });

  return { page, app: page.frameLocator("#dai-app"), problems };
}

async function perform(app, page, actions) {
  const downloads = [];
  page.on("download", (download) => downloads.push(download));

  for (const action of actions) {
    if (action.click) await app.locator(action.click).first().click({ timeout: 15_000 });
    else if (action.fill) await app.locator(action.fill).first().fill(action.text ?? "");
    else if (action.press) await app.locator("body").press(action.press);
    else if (action.wait) await page.waitForTimeout(Number(action.wait));
    else throw new Error(`Unknown action: ${JSON.stringify(action)}`);
  }

  // A save writes a whole new document, which takes a moment after the click
  // that asked for it.
  if (actions.length > 0) await page.waitForTimeout(1500);
  return downloads;
}

/**
 * Runs a query against the database inside a container.
 *
 * Opened in a second page, through the container's own engine, because that is
 * the only engine in the room: `dai` does not carry SQLite outside a browser,
 * and asking the file to read itself avoids a second implementation of the one
 * thing the file is definitely able to do.
 */
async function query(browser, container, sql) {
  const { page, app } = await open(browser, container);
  try {
    return await app.locator("body").evaluate(async (_body, statement) => {
      const dai = window.dai;
      const db = await dai.openDatabase();
      const rows = [];
      db.exec({ sql: statement, rowMode: "object", resultRows: rows });
      return rows;
    }, sql);
  } finally {
    await page.close();
  }
}

async function main(argv) {
  const options = parse(argv);
  if (!options.target) return usage("Which application?");

  const { path: container, built } = containerFor(options.target);
  const browser = await chromium.launch();

  const report = {
    container,
    built,
    mounted: false,
    problems: [],
    saved: null,
    rows: null,
  };

  try {
    const { page, app, problems } = await open(browser, container);
    report.mounted = true;

    const downloads = await perform(app, page, options.actions);
    report.problems = problems;

    if (downloads.length > 0) {
      /*
       * Copied out before the page closes.
       *
       * A download lives in the browser's own scratch directory and is deleted
       * with the page that produced it, so reading it afterwards finds nothing
       * — which reads exactly like an application that saved an empty file.
       */
      const last = downloads[downloads.length - 1];
      report.saved = join(mkdtempSync(join(tmpdir(), "dai-saved-")), last.suggestedFilename());
      await last.saveAs(report.saved);
    }
    await page.close();

    if (options.sql) {
      // Against the saved file when there is one: the question is whether what
      // somebody typed reached the document, not whether it reached the screen.
      report.rows = await query(browser, report.saved ?? container, options.sql);
    }
  } catch (error) {
    report.problems.push(String(error?.message ?? error));
  } finally {
    await browser.close();
  }

  const ok = report.mounted && report.problems.length === 0;

  if (options.json) {
    process.stdout.write(JSON.stringify({ ...report, ok }, null, 2) + "\n");
    return ok ? 0 : 1;
  }

  process.stdout.write(
    `${container}\n` +
      `  ${report.mounted ? "mounted and ran" : "never mounted"}\n` +
      (report.saved ? `  saved to ${report.saved}\n` : "  nothing was saved\n") +
      (report.rows ? `  ${JSON.stringify(report.rows)}\n` : ""),
  );
  for (const problem of report.problems) process.stdout.write(`  error: ${problem}\n`);

  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
