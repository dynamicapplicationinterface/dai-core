import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The harness that opens an application and uses it.
 *
 * It exists for evaluating generated applications, which means nothing else
 * exercises it — an evaluation that has not been run in a month is a script
 * that no longer works. This runs it against the example the site hands out.
 *
 * The property it asserts is the one worth having: a person typed something,
 * pressed save, and it is in the file. Not that the application rendered, not
 * that it compiled — that the data reached the document.
 */
const run = (args: string[]): { code: number; report: Record<string, unknown> } => {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(repo, "scripts", "try-container.mjs"), ...args],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, report: JSON.parse(stdout) as Record<string, unknown> };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return {
      code: failure.status ?? 1,
      report: failure.stdout ? (JSON.parse(failure.stdout) as Record<string, unknown>) : {},
    };
  }
};

test.describe("the try harness", () => {
  test.slow();

  test("builds an application, uses it, and finds the data in the saved file", () => {
    const { code, report } = run([
      join(repo, "examples", "tasks"),
      "--do",
      JSON.stringify([
        { fill: "#what", text: "milk" },
        { click: "#compose button[type=submit]" },
        { wait: 600 },
        { click: "#save" },
      ]),
      "--sql",
      "SELECT title FROM tasks ORDER BY id DESC LIMIT 1",
      "--json",
    ]);

    expect(code).toBe(0);
    expect(report.mounted).toBe(true);
    expect(report.problems).toEqual([]);
    // A file was written, and it is not the one that was built.
    expect(report.saved).toBeTruthy();
    expect(report.saved).not.toBe(report.container);
    expect(report.rows).toEqual([{ title: "milk" }]);
  });

  test("reports an application that never mounts, rather than passing it", () => {
    // The failure an evaluation exists to count. A harness that reported
    // success here would score a broken application as a working one.
    const { code, report } = run([
      join(repo, "tests", "fixture", "fixture.dai.html"),
      "--do",
      JSON.stringify([{ click: "#a-control-that-does-not-exist" }]),
      "--json",
    ]);

    expect(code).toBe(1);
    expect((report.problems as string[]).length).toBeGreaterThan(0);
  });
});
