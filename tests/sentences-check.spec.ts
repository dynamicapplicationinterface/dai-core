import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * While a document is open, the host speaks over it (backlog D169). The
 * opener's `say()` writes to the chooser's line, which is under an open
 * document; scripts/check-sentences.mjs, in the check-names family, fails a
 * `say(...)` in any top-level block not named as the chooser's.
 */
function checkSentences(file?: string) {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "check-sentences.mjs"), ...(file ? ["--scan", file] : [])], {
    cwd: repo,
    encoding: "utf8",
  });
  return { status: run.status, output: `${run.stdout}\n${run.stderr}` };
}

const STRAY = [
  "function say(message: string): void {}",
  "function tellOverDocument(sentence: string): void {}",
  "async function shareIt(): Promise<void> {",
  '  say("Shared.");',
  "}",
  'window.addEventListener("message", () => {',
  "  // say(\"a comment is not a call\")",
  '  const quoted = "say(\\"a string is not a call\\")";',
  '  say(`This document can be read here but not changed: ${quoted}`);',
  "});",
  "function overIt(): void {",
  '  tellOverDocument("Shared.");',
  "}",
  "",
].join("\n");

test("check-sentences fails a say() on the document path, and names each line", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dai-sentences-")), "opener.ts");
  writeFileSync(file, STRAY, "utf8");
  const { status, output } = checkSentences(file);
  expect(status, output).toBe(1);
  expect(output).toContain("opener.ts:4: say() in shareIt");
  expect(output).toContain('opener.ts:9: say() in window.addEventListener("message"');
  expect(output, "a comment is not a call").not.toContain("opener.ts:7");
  expect(output, "a string is not a call").not.toContain("opener.ts:8");
  expect(output, "tellOverDocument is the way").not.toContain("opener.ts:12");
});

test("check-sentences passes a file whose sentences all go over the document", () => {
  const file = join(mkdtempSync(join(tmpdir(), "dai-sentences-")), "opener.ts");
  writeFileSync(file, ["function say(message: string): void {}", "function share(): void {", '  tellOverDocument("Shared.");', "}", ""].join("\n"), "utf8");
  const { status, output } = checkSentences(file);
  expect(status, output).toBe(0);
});

test("the opener passes, with every block named the chooser's still saying something", () => {
  const { status, output } = checkSentences();
  expect(status, output).toBe(0);
});
