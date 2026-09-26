import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { lintFiles } from "../src/lint.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The seat tables are the kit's (docs/identity.md, step 5; IDENTITY-KIT-SEATS).
 * An application that writes one around the kit fails a check: this
 * repository's scan (scripts/check-seats.mjs, in the check-names family), and
 * the authoring lint, which reaches any application built on the format.
 */
function checkSeats(dir: string) {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-seats.mjs"), "--scan", dir], {
    cwd: repo,
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

const STRAY = [
  "db.exec(\"INSERT INTO _dai_binding (seat, _r_replica) VALUES (?, ?)\");",
  "window.dai.replicated.session.join(game.session, seat);",
  "// a comment that says INSERT INTO _dai_seat is prose, not a write",
  "db.exec('UPDATE _dai_seat SET seat = ?');",
  "const { session } = shared.session.create();",
  "",
].join("\n");

test("check-seats fails on an application that writes a seat table around the kit, and names each line", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-seats-"));
  writeFileSync(join(dir, "app.js"), STRAY, "utf8");
  const { status, output } = checkSeats(dir);
  expect(status, output).toBe(1);
  expect(output).toContain("app.js:1");
  expect(output).toContain("app.js:2");
  expect(output, "a comment is not a write").not.toContain("app.js:3");
  expect(output).toContain("app.js:4");
  expect(output).toContain("app.js:5");
});

test("check-seats passes an application that uses the kit's seats", () => {
  const dir = mkdtempSync(join(tmpdir(), "dai-seats-"));
  writeFileSync(
    join(dir, "app.js"),
    [
      "const session = window.daiKit.newSession();",
      "window.daiKit.claimSeat(session);",
      "const mine = window.daiKit.mySeat(session);",
      "const rows = db.selectObjects('SELECT * FROM _dai_binding_current');",
      "",
    ].join("\n"),
    "utf8",
  );
  const { status, output } = checkSeats(dir);
  expect(status, output).toBe(0);
});

test("the repository's own applications pass, with every exception still earning its place", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-seats.mjs")], { cwd: repo, encoding: "utf8" });
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
});

test("the authoring lint refuses an application that writes a seat table around the kit", () => {
  const schema = `-- dai:profile session max_parties=2
-- dai:replicated
CREATE TABLE moves (
  san TEXT NOT NULL
);
`;
  const findings = lintFiles({ "schema.sql": schema, "app.js": STRAY });
  expect(findings.map((f) => f.id)).toContain("seat-table-write");
  const clean = lintFiles({ "schema.sql": schema, "app.js": "const s = window.daiKit.newSession();\nwindow.addEventListener('dai:merged', () => {});\n" });
  expect(clean.map((f) => f.id)).not.toContain("seat-table-write");
});
