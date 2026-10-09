import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The words of the machinery stay out of what a person reads (V1.0 ruling 11,
 * pass B's B6).
 *
 * "Host", "sequence floor", "left floor", "batch" and "seal" name parts of
 * the design. A person has none of them: a sentence that says "the host would
 * not sign this change" tells them something broke and nothing about what to
 * do. Every sentence the opener, the runtime and the key store can put in
 * front of a person is a string literal in these files, so this reads every
 * literal that looks like words, outside the console and outside the
 * registry, and refuses one that uses a word from the list.
 *
 * The full registry of person-facing sentences, each with its next action, is
 * later work (Phase 1.7); this holds the vocabulary until then.
 */
const within = (dir: string): string[] =>
  readdirSync(resolve(repo, dir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${dir}/${name}`);

/** The opener, the runtime inside every document, and the reader whose refusals the opener shows. */
const FILES = [
  ...within("apps/runner/src"),
  ...within("src/runtime"),
  "src/kit.ts",
  "src/core.ts",
  "src/container.ts",
  "src/frame.ts",
  "src/worker.ts",
  "src/replicated-frame.ts",
  "src/link.ts",
  "src/fragment.ts",
  "src/handoff.ts",
  "src/handoff-tab.ts",
];

const JARGON = /\b(hosts?|sequence floor|left floor|batch(es)?|seal(s|ed|ing)?)\b/i;

/** A literal that reads as words: letters, at least two spaces, nothing that looks like code. */
const wordy = (text: string): boolean =>
  /[A-Za-z]/.test(text) && (text.match(/ /g) ?? []).length >= 2 && !/[{}<>=;]|SELECT |\bdai:/.test(text);

/** Calls whose string arguments never reach a person: logs, and internal tracing. */
const QUIET = /^(console\.\w+|note|noteHeldBack|trace|breadcrumb|log)$/;

function literals(file: string): { line: number; text: string }[] {
  const source = readFileSync(resolve(repo, file), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const quiet = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isCallExpression(at) && QUIET.test(at.expression.getText(tree))) return true;
      if (ts.isImportDeclaration(at) || ts.isExportDeclaration(at)) return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text;
      if (wordy(text) && !quiet(node)) {
        found.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

test("no sentence a person reads names the host, a floor, a batch or a seal", () => {
  const offending: string[] = [];
  let read = 0;
  for (const file of FILES) {
    const found = literals(file);
    read += found.length;
    for (const { line, text } of found) if (JARGON.test(text)) offending.push(`${file}:${line}  ${text}`);
  }
  // A scanner that finds nothing has stopped reading, not passed.
  expect(read, "sentences read").toBeGreaterThan(200);
  expect(offending, "say what the person can do, in words they have").toEqual([]);
});
