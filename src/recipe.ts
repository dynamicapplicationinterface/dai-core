/**
 * The model file: everything an assistant needs to write an application that
 * works inside a container, in one pass.
 *
 * Rendered, not written. The constraints, the shapes, the surface, the views
 * and the refusals come from src/rules.ts; the complete example applications
 * come from examples/ through src/generated/examples.ts. Only the connective
 * prose and the hand-over format live here. That is the whole point: the text
 * a model is handed and the pages a person reads are two presentations of one
 * source, so they cannot say different things.
 *
 * One text, several readers. The MCP server hands it to a model in its tool
 * descriptions; the website publishes it at /llms-full.txt and, with a line
 * inviting the reader to finish it, at /recipe.txt for pasting into a chat.
 * The name RECIPE is kept because those consumers import it.
 */

import { EXAMPLE_APPS } from "./generated/examples.js";
import { APP_REFUSALS, CONSTRAINTS, SURFACE, TOPICS, type Constraint } from "./rules.js";

function enforcementOf(constraint: Constraint): string {
  const parts = constraint.enforced.map((how) =>
    how === "lint" ? `checked by the lint${constraint.lint ? ` (${constraint.lint.join(", ")})` : ""}` :
    how === "compiler" ? "refused at build" :
    how === "runtime" ? "refused at run time" :
    "not checked by anything — follow it anyway",
  );
  return parts.join("; ");
}

function renderConstraint(constraint: Constraint): string {
  return [
    `[${constraint.id}] ${constraint.title}`,
    `  Enforcement: ${enforcementOf(constraint)}.`,
    `  ${constraint.rule}`,
    `  Why: ${constraint.why}`,
  ].join("\n");
}

/*
 * One shape (R-O, Build 1). Every application the model file teaches is
 * written over ordinary tables; whether its copies merge, and with whom, is
 * the host's policy, not the author's choice. The constraints taught are the
 * ones every application meets. The shape decision and the shared-table and
 * session surfaces stay in rules.ts for documents already built through the
 * policy layer (chess), and are not taught.
 */
export const TAUGHT = (constraint: Constraint): boolean => constraint.shapes.includes("solo") && constraint.topic !== "shape";

function renderConstraints(): string {
  return TOPICS.map((topic) => {
    const inTopic = CONSTRAINTS.filter((constraint) => constraint.topic === topic.id && TAUGHT(constraint));
    if (inTopic.length === 0) return "";
    return `${topic.title.toUpperCase()}\n\n${inTopic.map(renderConstraint).join("\n\n")}`;
  })
    .filter(Boolean)
    .join("\n\n");
}

function renderSurface(): string {
  return SURFACE.filter((entry) => entry.shapes.includes("solo"))
    .map((entry) => `- ${entry.call} — ${entry.does}`)
    .join("\n");
}

/** A refusal is taught when it can meet an ordinary-table application: nothing about shared tables or sessions. */
export const TAUGHT_REFUSAL = (r: { code: string; when: string; then: string }): boolean =>
  !/replicated|_r_|session|seat|roster|SHARED-|IDENTITY-SEAT|SESSION-/i.test(`${r.code} ${r.when} ${r.then}`);

function renderRefusals(): string {
  return APP_REFUSALS.filter(TAUGHT_REFUSAL)
    .map((r) => `- ${r.code} — ${r.when} ${r.then}`)
    .join("\n");
}

function bundleOf(name: string, files: Record<string, string>): string {
  const body = Object.entries(files)
    .map(([path, text]) => `--- file: ${path}\n${text.endsWith("\n") ? text : `${text}\n`}`)
    .join("\n");
  return "```text\ndai bundle v1\nname: " + name + "\n\n" + body + "```";
}

function renderExamples(): string {
  const intro: Record<string, string> = {
    solo:
      "A packing list. Written with the kit and no JavaScript of its own: ordinary tables, a seed block that runs once when the document is created, and nothing about who else holds a copy.",
    passable:
      "PASSABLE — two people in one household hand the document back and forth. The shared table is written through window.dai.replicated and read from receipts_current; the totals are derived, never stored; a merge redraws; an edit made on both copies is shown and settled by the person.",
    session:
      "SESSION — one person writes a request and sends a link; the person who opens it answers. Each request is a session: the creator writes it, whoever opens the invite takes the open seat. The two sides are not interchangeable, so the tables declare author=creator and author=joiner (SESSION-AUTHOR-ROLES); which side this copy is on is read from the seats. Progress is derived, never stored; the application joins on a carrier open only, shows the contested and not-invited states, settles an answer edited on two devices, and lets only the creator close. A session whose parties are interchangeable — two players of one game — is the same with no author= on any table.",
  };
  // The examples written over ordinary tables. The shared and session examples
  // stay in examples/ and in CI, built through the policy layer; they are not taught.
  return EXAMPLE_APPS.filter((app) => app.shape === "solo")
    .map((app) => `${intro[app.shape]}\n\n${bundleOf(app.name, app.files)}`)
    .join("\n\n");
}

function renderChecklist(): string {
  return CONSTRAINTS.filter(TAUGHT)
    .map((c) => c.id)
    .join(", ");
}

/** The model file, addressed to whoever is writing the code. */
export const RECIPE = `HOW TO ANSWER
Write a self-contained application that will be sealed into a DAI container: a single file holding the app, its SQLite database and its data, opened by double-clicking or from a link, with no server and no installation. There is no network: the container can reach nothing outside itself.

Write ordinary SQLite tables, with their own keys, and ordinary SQL over them: INSERT, UPDATE, DELETE, joins, transactions, foreign keys. That is the whole data model. Whether the document is kept on one device, moved between a person's devices or handed to somebody else is the host's business, not the application's: the host records what each save changed, signs it, and merges copies, and nothing in the application has to know. Follow every constraint below. Each has an ID in brackets, which is also what a lint finding cites; each says whether anything checks it. A constraint that nothing checks is still a constraint.

Content is the kit where the kit can express it: HTML with dai-rows, dai-value, dai-form, dai-attach and dai-save, and SQL in the document. The kit removes the dangerous sinks by construction (no statement built from a value, text-only rendering). Transport is whatever the channel has: when a tool is available, call it with the files as its arguments; when it is not, write the files as one text bundle, in the format under HOW TO HAND IT OVER.

THE CONSTRAINTS

${renderConstraints()}

THE SURFACE
Everything an application is given, and nothing else.

${renderSurface()}

REFUSALS YOU MAY MEET
What an error means, and what to do instead.

${renderRefusals()}

PATTERNS
The database, from JavaScript. Parameters are bound, never interpolated.

  const db = await window.dai.openDatabase();
  db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: ["Buy milk"] });
  db.exec({ sql: "UPDATE notes SET done = :done WHERE id = :id", bind: { ":done": 1, ":id": 3 } });
  const rows = db.selectObjects("SELECT * FROM notes ORDER BY id");
  const one  = db.selectObjects("SELECT * FROM notes WHERE id = ?", [3]);
  const count = db.selectValue("SELECT count(*) FROM notes WHERE done = 0");

Pass bind only when there are parameters: an empty array is read as parameters promised and not supplied, and throws. Use SQL for the work — joins, aggregates, ORDER BY — rather than loading everything and filtering in JavaScript.

A table and its seed. Leave the id out of an INSERT and the runtime chooses it; read it back with last_insert_rowid() or RETURNING id. The seed block runs once, when the document is created:

  --- file: schema.sql
  CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    body    TEXT NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  <script type="application/sql">
    INSERT INTO notes (body) VALUES ('Try editing this');
  </script>

A migration, when a later version changes a table:

  --- file: migrations/002-add-priority.sql
  ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

The kit:

  <dai-value query="SELECT count(*) AS n FROM tasks WHERE done = 0"></dai-value> left

  <dai-form run="INSERT INTO tasks (title) VALUES (:title)">
    <input name="title" required>
    <button type="button">Add</button>
  </dai-form>

  <dai-rows query="SELECT id, title, done FROM tasks ORDER BY id" empty="Nothing to do">
    <template>
      <li>
        <input type="checkbox" data-run="UPDATE tasks SET done = 1 - done WHERE id = :id">
        <span data-text="title"></span>
      </li>
    </template>
  </dai-rows>

  <dai-save>Save</dai-save>   <!-- hides itself under a host -->

  <script type="module" src="./dai-kit.js"></script>

- A form's fields become the :parameters of its statement, by name.
- Inside a row, :parameters come from that row's columns; data-text writes a column as text; data-when shows an element when a column is truthy.
- A control's own attributes data-x become :x, and what was typed into an input is :typed.
- A picture goes in the document, in a BLOB column, so it travels with the file: <dai-attach run="UPDATE entries SET photo = :file WHERE id = :id" data-id="1">Add a photo</dai-attach>, and <img data-blob="photo" alt=""> to show it. Never write a file path or a URL to an image the document does not carry.

When another copy's changes arrive, the host applies them to the same tables and the application hears dai:merged; redraw on it (the kit's elements already do):

  window.addEventListener("dai:merged", () => redraw());

HOW TO HAND IT OVER
When a tool is available, call it. If you can attach files to your answer, a zip of the files works too — a person drops it on the make-your-own page. Otherwise write the whole application as ONE fenced code block — open it with three backticks and the word text, close it with three backticks, and put every file inside it in this shape:

\`\`\`text
dai bundle v1
name: Reading list

--- file: index.html
<!doctype html>
<meta name="description" content="Books to read, and the ones you did">
<meta name="dai:does" content="Keep a list of what you want to read next">
<meta name="dai:does" content="Mark a book finished and see what you got through">
<meta name="dai:does" content="Search by author or title as the list grows">
…

--- file: schema.sql
CREATE TABLE IF NOT EXISTS books (…);

--- file: app.js
const db = await window.dai.openDatabase();

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">…</svg>
\`\`\`

One fence around everything, not one per file: the file markers begin with three dashes, and outside a fence a chat window draws them as dividing lines and breaks the application into pieces nobody can copy.

Every file starts with a line reading "--- file: " and its path, at the start of the line. Everything after that line belongs to that file until the next one. If a line inside a file would itself start with "--- file:", put a backslash in front of it.

COMPLETE EXAMPLES
A complete application, a bundle you could hand over as it is.

${renderExamples()}

BEFORE YOU ANSWER, CHECK
Every constraint, by ID:

${renderChecklist()}

And: the files are handed over as a tool call or as ONE fenced bundle; icon.svg exists; index.html has a description line and three dai:does lines; the background reaches every edge and content pads with var(--dai-safe-*, 0px).`;

/** The four custom properties a host sets; defined in rules.ts, re-exported for existing readers. */
export { CSS_VARS } from "./rules.js";

/**
 * What check_dai_app carries: the constraints the lint enforces, by id.
 *
 * The same source as RECIPE, filtered. A tool that only checks does not need
 * the shape decision, the patterns or the examples — it needs the rules its
 * findings cite, so a model reading a finding knows what it means. Carrying the
 * whole model file in both tool descriptions put it in a connected model's
 * context twice.
 */
export const CHECK_TEXT = `What this checks, by constraint. Each finding names the id it enforces; the full text of every constraint, with the shape decision and complete examples, is in create_dai_app's description.

${CONSTRAINTS.filter((c) => c.enforced.includes("lint"))
  .map((c) => `[${c.id}] ${c.title} — lint: ${(c.lint ?? []).join(", ")}\n  ${c.rule}`)
  .join("\n\n")}`;

/** One line each, for a reader who wants the surface rather than the argument. */
export const API: { call: string; does: string }[] = SURFACE.map(({ call, does }) => ({ call, does }));

/**
 * The model file with a line inviting the reader to finish it.
 *
 * Only the paste-it-into-a-chat route needs this: the MCP server's model is
 * already holding the request, and a trailing prompt there would read as an
 * instruction to invent one.
 */
export const RECIPE_AS_PROMPT = `${RECIPE}

The app I want is: `;
