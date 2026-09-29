#!/usr/bin/env node
/**
 * While a document is open, the host speaks over it (backlog D169).
 *
 * `say()` writes to `#report`, the chooser's line, which sits under an open
 * document: a sentence said there after a mount is on no screen, and a refusal
 * nobody can see is a refusal nobody understands. Everything the host has for
 * someone looking at a document goes through `tellOverDocument` (`#doc-note`).
 *
 * The same family as check-names: a scan of source with named exceptions, each
 * with its reason, where an exception that excuses nothing fails. Here the
 * exceptions are the chooser's: every top-level block of the opener that says
 * anything is either named below, or it is on the document path and a `say(`
 * in it fails. So a new function is on the document path until somebody names
 * it the chooser's.
 *
 *   node scripts/check-sentences.mjs            the opener, apps/runner/src/main.ts
 *   node scripts/check-sentences.mjs --scan F   only the file F, with no exceptions (for tests)
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(join(repo, "package.json"))("typescript");
const OPENER = "apps/runner/src/main.ts";

/** The blocks whose sentences are the chooser's, by function name or first line, and why. */
const CHOOSER = {
  say: "the chooser's line itself",
  refuseArrival: "an arrival refused: it takes the launch screen down and speaks on the chooser (D122)",
  eject: "clears the line as the document goes",
  launchFromLibrary:
    "opening a document from the library, before it mounts; its \"opened empty\" goes over the document once mounted, a branch this check cannot see",
  openFromUrl: "fetching a document by address: nothing is open yet",
  ingest:
    "the arrival, before the card; its two merge lines into a document already mounted go over it, and this check cannot see that branch",
  openFromLink: "unpacking a document from a link: nothing is open yet",
  openFromReference: "fetching a document a reference names: nothing is open yet",
  start: "the page's first load, before any document",
  namePublisher: "asked from the card, before the document opens",
  refusedByShell: "the shell refused the document and the frame comes down: the chooser is what is left",
  'document.getElementById("remove")?.addEventListener("click", () => {': "the document is removed: the chooser is what is left",
};

/**
 * Every top-level statement: its name (a function's, or its first line) and the
 * lines of its `say(...)` calls. Parsed, so a string or a comment is never a call.
 */
function blocks(source) {
  const file = ts.createSourceFile("opener.ts", source, ts.ScriptTarget.ES2022, true);
  return file.statements.map((statement) => {
    const name =
      ts.isFunctionDeclaration(statement) && statement.name
        ? statement.name.text
        : statement.getText(file).split("\n")[0].trim();
    const says = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "say")
        says.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      ts.forEachChild(node, visit);
    };
    visit(statement);
    return { name, says };
  });
}

const at = process.argv.indexOf("--scan");
const path = at > 0 ? resolve(process.argv[at + 1]) : join(repo, OPENER);
const shown = at > 0 ? relative(process.cwd(), path).split("\\").join("/") : OPENER;
const exceptions = at > 0 ? {} : CHOOSER;
const all = blocks(readFileSync(path, "utf8"));
const speaking = all.filter((block) => block.says.length > 0);

const problems = [];
for (const block of speaking) {
  if (block.name in exceptions) continue;
  for (const line of block.says)
    problems.push(`${shown}:${line}: say() in ${block.name}, on the document path: say it with tellOverDocument`);
}
// An exception that excuses nothing fails: `say` is named for what it is, and holds no call.
for (const name of Object.keys(exceptions)) {
  if (name === "say" ? all.some((b) => b.name === "say") : speaking.some((b) => b.name === name)) continue;
  problems.push(`the chooser's "${name}" is not a block of ${shown} that says anything; remove it`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`sentences: ${problem}`);
  process.exit(1);
}
console.log(
  `sentences: ${speaking.length} blocks in ${shown} say something, each the chooser's (${Object.keys(exceptions).length} named)`,
);
