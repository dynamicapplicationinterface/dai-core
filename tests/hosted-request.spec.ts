import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileDirectory } from "../src/compile.js";
import { parseContainer } from "../src/container.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The opener hosts one built example, `apps/runner/public/request.dai.html`,
 * for checks on a phone (`.gitignore` says how it is built). It is the one
 * committed document with replicated tables, so it must be on the current
 * batch format: its manifest declares `authorship` (docs/format.md,
 * `version-declared`), and its application is what a build of
 * `examples/request` makes today, so a change to the example without a
 * rebuild fails here.
 */
const HOSTED = join(repo, "apps", "runner", "public", "request.dai.html");

test("the hosted request declares authorship and is built from the example as it stands", async () => {
  const hosted = parseContainer(readFileSync(HOSTED, "utf8"));
  expect(hosted.manifest.requires ?? []).toContain("authorship");
  expect(hosted.manifest.requires ?? []).toContain("replicated");

  const fresh = parseContainer(
    (await compileDirectory({ sourceDir: join(repo, "examples", "request"), root: repo, appName: "Request" })).html,
  );
  const app = (archive: Record<string, Uint8Array>) => Object.keys(archive).filter((name) => name.startsWith("app/")).sort();
  expect(app(hosted.archive)).toEqual(app(fresh.archive));
  for (const name of app(fresh.archive)) {
    expect(
      Buffer.from(hosted.archive[name]!).equals(Buffer.from(fresh.archive[name]!)),
      `${name} is what a build of examples/request makes today; rebuild the hosted copy with the CLI`,
    ).toBe(true);
  }
  expect(hosted.manifest.requires).toEqual(fresh.manifest.requires);
});
