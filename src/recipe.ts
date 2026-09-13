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
import {
  APP_REFUSALS,
  CONSTRAINTS,
  MARKERS,
  SHAPES,
  SHAPE_DECISION,
  SHAPE_ORDER,
  SURFACE,
  TOPICS,
  VIEWS,
  type Constraint,
  type Shape,
} from "./rules.js";

const SHAPE_LABEL: Record<Shape, string> = {
  solo: "solo",
  passable: "passable",
  session: "session",
  broadcast: "broadcast",
};

function shapesOf(shapes: readonly Shape[]): string {
  return shapes.length === SHAPE_ORDER.length ? "every shape" : shapes.map((s) => SHAPE_LABEL[s]).join(", ");
}

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
    `  Applies to: ${shapesOf(constraint.shapes)}. Enforcement: ${enforcementOf(constraint)}.`,
    `  ${constraint.rule}`,
    `  Why: ${constraint.why}`,
  ].join("\n");
}

function renderConstraints(): string {
  return TOPICS.map((topic) => {
    const inTopic = CONSTRAINTS.filter((constraint) => constraint.topic === topic.id);
    if (inTopic.length === 0) return "";
    return `${topic.title.toUpperCase()}\n\n${inTopic.map(renderConstraint).join("\n\n")}`;
  })
    .filter(Boolean)
    .join("\n\n");
}

function renderShapes(): string {
  const questions = SHAPE_DECISION.map(
    (step, index) => `${index + 1}. ${step.ask}\n   Yes: ${step.yes}\n   No: ${step.no}`,
  ).join("\n");
  const shapes = SHAPES.map(
    (shape) =>
      `${shape.title.toUpperCase()} — ${shape.who}\n  Declare: ${shape.declares}\n  What the runtime does: ${shape.mechanism}\n  For example: ${shape.examples}.`,
  ).join("\n\n");
  return `${questions}\n\n${shapes}`;
}

function renderSurface(): string {
  const groups: { title: string; test: (shapes: readonly Shape[]) => boolean }[] = [
    { title: "Every application", test: (s) => s.length === SHAPE_ORDER.length },
    { title: "Shared tables (passable and session)", test: (s) => s.includes("passable") },
    { title: "Sessions", test: (s) => s.length === 1 && s[0] === "session" },
  ];
  return groups
    .map((group) => {
      const entries = SURFACE.filter((entry) => group.test(entry.shapes));
      return `${group.title}:\n${entries.map((entry) => `- ${entry.call} — ${entry.does}`).join("\n")}`;
    })
    .join("\n\n");
}

function renderSchemaObjects(): string {
  const markers = MARKERS.map((m) => `- ${m.marker}\n  Where: ${m.where}\n  Does: ${m.does}`).join("\n");
  const views = VIEWS.map((v) => `- ${v.name} (${shapesOf(v.shapes)}): ${v.holds} ${v.read}`).join("\n");
  return `Markers:\n${markers}\n\nWhat the rewrite creates, for a replicated table t:\n${views}`;
}

function renderRefusals(): string {
  return APP_REFUSALS.map((r) => `- ${r.code} — ${r.when} ${r.then}`).join("\n");
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
      "SOLO — one person, one document. Written with the kit and no JavaScript of its own; the seed rows are local and idempotent.",
    passable:
      "PASSABLE — two people in one household hand the document back and forth. The shared table is written through window.dai.replicated and read from receipts_current; the totals are derived, never stored; a merge redraws; an edit made on both copies is shown and settled by the person.",
    session:
      "SESSION — two people play one game. Each game is a session: the creator plays X, whoever opens the invite takes the open seat. The board, the turn and the winner are derived from the marks; the application joins on a carrier open only, shows the contested and not-invited states, and closes a finished match.",
  };
  const apps = EXAMPLE_APPS.map(
    (app) => `${intro[app.shape] ?? app.shape.toUpperCase()}\n\n${bundleOf(app.name, app.files)}`,
  ).join("\n\n");
  return (
    `${apps}\n\n` +
    "BROADCAST — no example. Build it exactly as solo (SHAPE-BROADCAST-CONVENTION).\n\n" +
    "THE MISTAKE THESE EXAMPLES AVOID. The first chess application written from an earlier version of these " +
    "instructions marked its tables shared and then stored the board, the turn, the result and an updated_at " +
    "column in the games table; changed that row in place with UPDATE on every move; kept the selected square " +
    "and the theme in the shared table; put UNIQUE(game_id, ply) on moves; read the moves table itself; and never " +
    "listened for dai:merged. After the first exchange each copy showed a board computed from the moves it had, " +
    "and the other player's move never appeared. The correct version stores only games, moves and game events, " +
    "derives the board by replaying the moves, keeps the per-copy state local, lets two moves at one ply exist so " +
    "the players can see and settle it, reads the _current views, redraws on dai:merged, and declares a session."
  );
}

function renderChecklist(): string {
  return SHAPE_ORDER.map((shape) => {
    const ids = CONSTRAINTS.filter((c) => c.shapes.includes(shape)).map((c) => c.id);
    return `- ${SHAPE_LABEL[shape]}: ${ids.join(", ")}`;
  }).join("\n");
}

/** The model file, addressed to whoever is writing the code. */
export const RECIPE = `HOW TO ANSWER
Write a self-contained application that will be sealed into a DAI container: a single file holding the app, its SQLite database and its data, opened by double-clicking or from a link, with no server and no installation. There is no network: the container can reach nothing outside itself.

Decide the shape first (below). Then follow every constraint that applies to that shape. Each constraint has an ID in brackets, which is also what a lint finding cites; each says whether anything checks it. A constraint that nothing checks is still a constraint.

Content is the kit where the kit can express it: HTML with dai-rows, dai-value, dai-form, dai-attach and dai-save, and SQL in the document. The kit removes the dangerous sinks by construction (no statement built from a value, text-only rendering). Its write controls are for local tables only; shared tables are written in JavaScript through window.dai.replicated. Transport is whatever the channel has: when a tool is available, call it with the files as its arguments; when it is not, write the files as one text bundle, in the format under HOW TO HAND IT OVER. There is no third format.

FIRST, THE SHAPE
Answer these before writing a single table. The answer decides which tables are shared, whether there is a session profile, and which constraints apply.

${renderShapes()}

THE CONSTRAINTS

${renderConstraints()}

THE SURFACE
Everything an application is given, and nothing else.

${renderSurface()}

THE SCHEMA

${renderSchemaObjects()}

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

A local table and its seed (the notes table above is local, so an ordinary UPDATE is right for it):

  --- file: schema.sql
  CREATE TABLE IF NOT EXISTS notes (
    id      INTEGER PRIMARY KEY,
    body    TEXT NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL DEFAULT (datetime('now'))
  );

  <script type="application/sql">
    INSERT INTO notes (body) SELECT 'Try editing this' WHERE NOT EXISTS (SELECT 1 FROM notes);
  </script>

A migration, when a later version changes a table:

  --- file: migrations/002-add-priority.sql
  ALTER TABLE notes ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

The kit, over local tables:

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

A shared table, written and read:

  --- file: schema.sql
  -- dai:replicated
  CREATE TABLE IF NOT EXISTS moves (
    game_id TEXT NOT NULL,   -- the games row's entity, as hex
    ply     INTEGER NOT NULL,
    san     TEXT NOT NULL
  );

  const entity = window.dai.replicated.insert("moves", { game_id, ply, san });   // add
  window.dai.replicated.change("moves", entity, { game_id, ply, san: "Nf3" });   // every column
  window.dai.replicated.remove("moves", entity);                                  // delete
  const moves = db.selectObjects(
    "SELECT lower(hex(_r_entity)) AS entity, ply, san, _r_conflicted FROM moves_current WHERE game_id = ? ORDER BY ply",
    [game_id]);
  window.addEventListener("dai:merged", () => redraw());

HOW TO HAND IT OVER
If you can attach files, a zip of the files is best. Otherwise write the whole application as ONE fenced code block — open it with three backticks and the word text, close it with three backticks, and put every file inside it in this shape:

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
One complete application per shape, each a bundle you could hand over as it is. Each schema.sql opens with the decision that led to its shape.

${renderExamples()}

BEFORE YOU ANSWER, CHECK
Every constraint for the shape you chose, by ID:

${renderChecklist()}

And for every shape: the files are handed over as a tool call or as ONE fenced bundle; icon.svg exists; index.html has a description line and three dai:does lines; the background reaches every edge and content pads with var(--dai-safe-*, 0px).`;

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
