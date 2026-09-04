import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The scoring, run against applications whose verdict is known.
 *
 * An evaluation nobody exercises is a script that stops working and then
 * reports whatever it reports. These drive it against a reference application
 * that should pass and a broken one that should not, because a harness that
 * cannot fail is a harness that scores everything as working.
 */
const evaluate = (candidates: string): Record<string, unknown> => {
  const stdout = execFileSync(
    process.execPath,
    [join(repo, "scripts", "evaluate.mjs"), candidates, "--json"],
    { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
};

interface Result {
  id: string;
  reached: string | null;
  failedAt: string | null;
  why: string | null;
}

test.describe("the evaluation", () => {
  test.slow();

  test("scores the reference application as usable", () => {
    const report = evaluate(join(repo, "eval", "candidates", "reference"));
    const results = report.results as Result[];
    const reading = results.find((result) => result.id === "reading-list")!;

    // Every stage: it checked, compiled, opened, was typed into, saved, and the
    // data was in the file that came back.
    expect(reading.reached).toBe("usable");
    expect(reading.failedAt).toBeNull();
  });

  test("counts a prompt with no candidate as a failure, not a skip", () => {
    // Quietly dropping them would score the prompts a model managed and call
    // that the rate.
    const report = evaluate(join(repo, "eval", "candidates", "reference"));
    const results = report.results as Result[];

    expect(results).toHaveLength(4);
    expect(results.filter((result) => result.failedAt === "missing")).toHaveLength(3);
    expect(report.usable).toBe(1);
    expect(report.rate).toBe(25);
  });

  test("stops at the first stage that fails, and says which", () => {
    /*
     * An application that reaches for the network. It never gets as far as
     * compiling, and reporting three further failures for one cause would
     * inflate the count of things wrong with it.
     */
    const root = mkdtempSync(join(tmpdir(), "dai-eval-"));
    mkdirSync(join(root, "reading-list"), { recursive: true });
    writeFileSync(
      join(root, "reading-list", "index.html"),
      '<!doctype html><title>x</title><script>fetch("/api/books")</script>',
    );

    const report = evaluate(root);
    const reading = (report.results as Result[]).find((r) => r.id === "reading-list")!;

    expect(reading.reached).toBeNull();
    expect(reading.failedAt).toBe("checked");
    expect(reading.why).toContain("network-call");
  });

  test("an application that mounts but keeps nothing is not usable", () => {
    /*
     * The failure worth catching, and the one a demonstration hides: it opens,
     * it looks right, and a person's work is not in the file afterwards.
     */
    const root = mkdtempSync(join(tmpdir(), "dai-eval-"));
    mkdirSync(join(root, "reading-list"), { recursive: true });
    writeFileSync(
      join(root, "reading-list", "index.html"),
      [
        "<!doctype html><meta charset=utf-8><title>Reading</title>",
        '<input id="what"><button id="add">Add</button><button id="save">Save</button>',
        '<script type="module">',
        "  const db = await window.dai.openDatabase();",
        '  db.exec("CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY, title TEXT)");',
        "  // Adds nothing and saves nothing: the controls are decoration.",
        "</script>",
      ].join("\n"),
    );

    const report = evaluate(root);
    const reading = (report.results as Result[]).find((r) => r.id === "reading-list")!;

    expect(reading.reached).toBe("mounted");
    expect(reading.failedAt).toBe("usable");
    expect(reading.why).toMatch(/nothing was saved|does not look right/);
  });
});
