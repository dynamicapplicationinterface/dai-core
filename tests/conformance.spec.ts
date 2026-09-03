import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { auditContainer, parseContainer, verifyContainer } from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = join(repo, "conformance");

interface Case {
  name: string;
  file: string;
  form: "viewer" | "sectioned";
  summary: string;
  expect: {
    mount: boolean;
    parses?: boolean;
    ok?: boolean;
    entries?: { mismatched: string[]; missing: string[]; unlisted: string[] };
    shell?: string;
    signature?: string;
    expiry?: string;
    sections?: { mismatched: number[]; missing: number[]; staleFooter: boolean };
  };
}

const cases = JSON.parse(readFileSync(join(suite, "cases.json"), "utf8")) as {
  suiteVersion: number;
  formatVersion: number;
  cases: Case[];
};

/**
 * This implementation, run against the suite it publishes.
 *
 * The suite is generated from expectations written against the specification,
 * and the generator refuses to write it when this reader disagrees — so at the
 * moment it is built, these tests pass by construction. They are not redundant
 * afterwards: the files are committed and the reader keeps changing, and this
 * is what notices the day a change to the reader alters a published verdict.
 * A conformance suite the maintainers do not run is a suite nobody else should
 * trust.
 */
test.describe("the conformance suite", () => {
  test("is not empty, and covers both forms", () => {
    // A suite can rot down to nothing one deleted case at a time, and every
    // remaining test would still pass.
    expect(cases.cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.cases.some((entry) => entry.form === "sectioned")).toBe(true);
    expect(cases.cases.some((entry) => entry.form === "viewer")).toBe(true);
    expect(cases.cases.some((entry) => entry.expect.mount)).toBe(true);
    expect(cases.cases.some((entry) => !entry.expect.mount)).toBe(true);
  });

  for (const entry of cases.cases) {
    test(`${entry.name}: ${entry.summary}`, async () => {
      const raw = readFileSync(join(suite, entry.file));
      const source: string | Uint8Array = entry.file.endsWith(".dai")
        ? new Uint8Array(raw)
        : raw.toString("utf8");

      if (entry.expect.parses === false) {
        expect(() => parseContainer(source)).toThrow();
        return;
      }

      let mounted = true;
      try {
        await verifyContainer(source);
      } catch {
        mounted = false;
      }
      expect(mounted).toBe(entry.expect.mount);

      const report = await auditContainer(parseContainer(source));
      const named = (status: string) =>
        report.entries
          .filter((audit) => audit.status === status)
          .map((audit) => audit.name)
          .sort();

      if (entry.expect.ok !== undefined) expect(report.ok).toBe(entry.expect.ok);
      if (entry.expect.entries) {
        expect({
          mismatched: named("mismatch"),
          missing: named("missing"),
          unlisted: named("unlisted"),
        }).toEqual(entry.expect.entries);
      }
      if (entry.expect.shell) expect(report.shell.status).toBe(entry.expect.shell);
      if (entry.expect.signature) expect(report.signature.status).toBe(entry.expect.signature);
      if (entry.expect.expiry) expect(report.expiry.status).toBe(entry.expect.expiry);
      if (entry.expect.sections) {
        expect({
          mismatched: report.sections!.mismatched,
          missing: report.sections!.missing,
          staleFooter: report.sections!.staleFooter,
        }).toEqual(entry.expect.sections);
      }
    });
  }
});
