/**
 * What an application inside a container must do, stated once.
 *
 * This is the source. The text a model is handed (`RECIPE` in recipe.ts, the
 * MCP tool descriptions, /llms-full.txt and /recipe.txt) and the pages a person
 * reads (Constraints, Runtime API, Views, Choose a shape) are all rendered from
 * these lists. Nothing restates a constraint by hand, because two hand-kept
 * copies is how the recipe fell behind the code: a model instructed one way and
 * a person reading another, with no way to tell which was current.
 *
 * Each constraint carries:
 *   - an `id` that never changes once published — it is the anchor on the page
 *     and the name a lint finding cites;
 *   - the `shapes` it applies to;
 *   - the `rule`, stated so nothing is left implied;
 *   - `why` it exists, because a person who knows why does not reach for the
 *     workaround;
 *   - `anchors`: the code the rule depends on, checked by tests/rules.spec.ts,
 *     so a rule whose mechanism moves fails a test instead of going stale;
 *   - `enforced`: what refuses a violation — the compiler, the runtime, the
 *     lint (`dai check` and the MCP server), or nothing ("prose"). Prose is
 *     stated as prose so nobody believes a check exists that does not.
 */

export type Shape = "solo" | "passable" | "session" | "broadcast";
export const SHAPE_ORDER: readonly Shape[] = ["solo", "passable", "session", "broadcast"];

export type Enforcement = "compiler" | "runtime" | "lint" | "prose";

export interface Anchor {
  /** Path from the repository root. */
  file: string;
  /** Text that must appear in that file for the rule to still be true. */
  contains: string;
}

export interface Constraint {
  id: string;
  title: string;
  shapes: readonly Shape[];
  topic: Topic;
  rule: string;
  why: string;
  enforced: readonly Enforcement[];
  /** The lint finding ids that enforce this, when `enforced` includes "lint". */
  lint?: readonly string[];
  anchors: readonly Anchor[];
}

export type Topic =
  | "shape"
  | "container"
  | "data"
  | "shared"
  | "session"
  | "kit"
  | "presentation"
  | "handover"
  | "identity";

export const TOPICS: readonly { id: Topic; title: string }[] = [
  { id: "shape", title: "The shape, decided first" },
  { id: "container", title: "What the container forbids" },
  { id: "data", title: "Data" },
  { id: "shared", title: "Shared tables" },
  { id: "session", title: "Sessions" },
  { id: "kit", title: "The kit" },
  { id: "presentation", title: "The screen and the card" },
  { id: "handover", title: "Handing it over" },
  { id: "identity", title: "Who wrote it" },
];

const ALL: readonly Shape[] = SHAPE_ORDER;
const SHARED: readonly Shape[] = ["passable", "session"];
const SESSION: readonly Shape[] = ["session"];

/** The four shapes, and what the runtime does and does not know about each. */
export interface ShapeInfo {
  id: Shape;
  title: string;
  /** One line: who uses it. */
  who: string;
  /** What the author declares. */
  declares: string;
  /** What the runtime enforces, stated honestly. */
  mechanism: string;
  examples: string;
  /** Example directory in the repository, when one exists. */
  example?: string;
}

export const SHAPES: readonly ShapeInfo[] = [
  {
    id: "solo",
    title: "Solo",
    who: "One person, one document.",
    declares: "No replicated tables.",
    mechanism:
      "Ordinary SQLite. Whole copies replace each other when the file is saved; nothing merges.",
    examples: "a packing list, a habit tracker, a recipe box",
    example: "examples/packing-list",
  },
  {
    id: "passable",
    title: "Passable",
    who:
      "One person across their own devices, or a document handed around where every copy's changes are kept.",
    declares: "Tables marked -- dai:replicated, and no session profile.",
    mechanism:
      "Rows are appended, never changed in place, and copies merge by union. There is no roster: anyone holding a copy participates.",
    examples: "a shared receipt tracker, a household inventory, a trip plan two people edit",
    example: "examples/receipts",
  },
  {
    id: "session",
    title: "Session",
    who: "A closed group admitted by invite — today, two people: the creator and one invitee.",
    declares: "Tables marked -- dai:replicated, plus the profile line -- dai:profile session max_parties=N.",
    mechanism:
      "Everything in passable, plus seats: the creator mints its own and one open seat, an invitee binds the open one, and only members' rows are read. A forwarded copy cannot join. There is no way yet to seat a third person, so a group larger than two cannot be a session.",
    examples: "a request one person writes and another answers, a game by message, a two-party agreement",
    example: "examples/request",
  },
  {
    id: "broadcast",
    title: "Broadcast",
    who: "One publisher writes; recipients read.",
    declares: "Nothing. Mechanically it is solo.",
    mechanism:
      "None yet. The separation between publisher and reader is a convention the application keeps, not something the runtime enforces: the confidentiality tier that makes it real is not implemented. A recipient's copy is an ordinary solo document they can write to.",
    examples: "a statement, a report, a reference tool",
  },
];

/** The questions that decide the shape, in the order to ask them. */
export const SHAPE_DECISION: readonly { ask: string; yes: string; no: string }[] = [
  {
    ask: "Will anybody but the person who made this change its data — someone else, or the same person on another device, with both copies' changes kept?",
    yes: "It is passable or session. Ask the next question.",
    no: "It is solo. If you are sending it out for other people to read, it is broadcast — which today is built exactly as solo.",
  },
  {
    ask: "Is it a closed group of a known size, where a copy forwarded to somebody else must not let them take part?",
    yes: "Session.",
    no: "Passable.",
  },
];

export const CONSTRAINTS: readonly Constraint[] = [
  // ------------------------------------------------------------------ shape
  {
    id: "SHAPE-FIRST",
    title: "Decide the shape before writing a table",
    shapes: ALL,
    topic: "shape",
    rule:
      "Before writing schema.sql, decide which of the four shapes the application is — solo, passable, session or broadcast — using the two questions above, and state the decision in a comment at the top of schema.sql. The shape decides which tables are replicated, whether there is a session profile, and every rule below that applies only to shared tables.",
    why:
      "The shape is the decision every table depends on, and it cannot be fixed afterward by editing a table. The first chess application written against these instructions was never asked it, and it stored the board — derived state that is wrong the moment two copies merge.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "dai:profile session max_parties=2" }],
  },
  {
    id: "SHAPE-BROADCAST-CONVENTION",
    title: "Broadcast has no runtime enforcement yet",
    shapes: ["broadcast"],
    topic: "shape",
    rule:
      "Build a broadcast application exactly as a solo one. Do not tell the reader their copy is read-only, locked, or protected: it is an ordinary document they can write to. If the application should not be edited by recipients, say that it is the publisher's, and put nothing in it that the publisher needs back.",
    why:
      "The mechanism that separates a publisher from its readers — the confidentiality levels — is not implemented. Claiming a protection the runtime does not provide is worse than saying nothing.",
    enforced: ["prose"],
    anchors: [{ file: "src/container.ts", contains: 'IMPLEMENTED_CAPABILITIES: readonly string[] = ["replicated", "session"]' }],
  },

  // -------------------------------------------------------------- container
  {
    id: "NO-NETWORK",
    title: "Nothing is fetched",
    shapes: ALL,
    topic: "container",
    rule:
      "Fetch nothing by URL. No CDN script tags: inline the library, or write the code without it. No hosted stylesheets or fonts: write the CSS inline and use system font stacks. No remote images: use inline SVG, a data: URI, or an emoji. No fetch, XMLHttpRequest, WebSocket, EventSource or sendBeacon, and no preconnect, dns-prefetch, prefetch or prerender links.",
    why:
      "The container permits no connections and the browser enforces it, so anything fetched fails silently and the application breaks in front of whoever opened it, far from the cause.",
    enforced: ["lint", "runtime"],
    lint: ["cdn-script", "remote-stylesheet", "network-call", "remote-image", "speculative-fetch"],
    anchors: [{ file: "src/lint.ts", contains: 'id: "network-call"' }],
  },
  {
    id: "STORE-IN-SQLITE",
    title: "The database is the only storage",
    shapes: ALL,
    topic: "container",
    rule:
      "Keep every piece of data in the SQLite database inside the document, opened with `await window.dai.openDatabase()`. Never use localStorage, sessionStorage, IndexedDB, cookies, the Cache API or the File System API.",
    why:
      "Browser storage belongs to the browser rather than to the file, so data kept there does not travel: send the document to somebody and it arrives empty.",
    enforced: ["lint"],
    lint: ["browser-storage"],
    anchors: [{ file: "src/lint.ts", contains: 'id: "browser-storage"' }],
  },
  {
    id: "MODULE-FOR-AWAIT",
    title: "A script that awaits is a module",
    shapes: ALL,
    topic: "container",
    rule: 'Any <script> that uses top-level await must be type="module".',
    why: "In a classic script top-level await is a syntax error, and the application opens blank.",
    enforced: ["lint"],
    lint: ["await-in-classic-script"],
    anchors: [{ file: "src/lint.ts", contains: 'id: "await-in-classic-script"' }],
  },
  {
    id: "NO-INLINE-HANDLERS",
    title: "No onclick attributes",
    shapes: ALL,
    topic: "container",
    rule:
      "Attach every event handler in script with addEventListener. Never write an event attribute such as onclick or onsubmit in HTML.",
    why: "A container allows no inline script, so the attribute never runs and the control does nothing, with no error to explain why.",
    enforced: ["lint"],
    lint: ["inline-event-handler"],
    anchors: [{ file: "src/lint.ts", contains: 'id: "inline-event-handler"' }],
  },
  {
    id: "NO-NEW-WINDOWS",
    title: "No new windows, no redirects",
    shapes: ALL,
    topic: "container",
    rule: 'Never open a window or tab (window.open, target="_blank") and never redirect with a meta refresh.',
    why: "A container cannot open windows or navigate anywhere, so the link does nothing or the application blanks.",
    enforced: ["lint"],
    lint: ["new-window", "meta-refresh"],
    anchors: [{ file: "src/lint.ts", contains: 'id: "new-window"' }],
  },
  {
    id: "ONE-DOCUMENT",
    title: "One document, many rows",
    shapes: ALL,
    topic: "container",
    rule:
      "Model every separate instance — a game, a match, a list, a save slot — as a row in the application's own schema, with a local setting recording which one is showing. Never offer a \"new file\": nothing in a running application can create a second document.",
    why:
      "A document is one sealed file with one database, and no call creates, forks or duplicates one. A \"New Game\" button that promises a new file promises something that cannot happen.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "active_game_id TEXT" }],
  },
  {
    id: "SHARE-THROUGH-HOST",
    title: "Sharing is the host's",
    shapes: ALL,
    topic: "container",
    rule:
      "To let a person share, put a Share button in the application and call `window.dai.requestShare()`. Never build a share flow of your own with the browser's share API. For a shared document the host sends a link, which is also how an invite reaches the other party.",
    why:
      "The host builds the link, shows the card, and asks whether to include the person's data; a substitute flow would carry none of that, and for a shared document a file sent any other way carries no key and can never sync.",
    enforced: ["prose"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: "requestShare: (session?: string) =>" },
      { file: "apps/runner/src/main.ts", contains: "The invite link could not be made" },
    ],
  },

  // ------------------------------------------------------------------- data
  {
    id: "SCHEMA-FILE",
    title: "Every table is in schema.sql",
    shapes: ALL,
    topic: "data",
    rule:
      "Declare every table in one file named schema.sql, each with CREATE TABLE IF NOT EXISTS. Create no table anywhere else — not in index.html, not in JavaScript.",
    why:
      "schema.sql runs first on every open and its shape is sealed with the file; that record is what protects a person's data when a later version changes the application.",
    enforced: ["prose"],
    anchors: [{ file: "src/schema.ts", contains: 'export const SCHEMA_FILE = "schema.sql"' }],
  },
  {
    id: "SEED-IDEMPOTENT",
    title: "Seed rows are idempotent, and local",
    shapes: ALL,
    topic: "data",
    rule:
      "Put a few example rows in a <script type=\"application/sql\"> block in index.html so the application is not an empty shell on first open, written so a second open adds nothing (INSERT … WHERE NOT EXISTS, or INSERT OR IGNORE with a fixed id). Never seed from schema.sql. Seed only local tables this way; see SHARED-SEED-THROUGH-SURFACE for shared ones.",
    why: "The block runs on every open, so a seed that is not idempotent duplicates itself each time the document is opened.",
    enforced: ["prose"],
    anchors: [{ file: "src/runtime/bootloader.ts", contains: "runDocumentSql(db)" }],
  },
  {
    id: "WRITE-AS-IT-HAPPENS",
    title: "The database is the state",
    shapes: ALL,
    topic: "data",
    rule:
      "Write every action a person takes — a tick, a new row, an edit — to the database at the moment they take it. Never hold the application's state in a JavaScript variable to write later. On load, read the database and draw from it; after a write, read again and redraw.",
    why: "Whatever is only in a variable is lost when the document closes, and it is not in the copy that gets sent.",
    enforced: ["prose"],
    anchors: [{ file: "src/runtime/bootloader.ts", contains: "Only a write schedules a save" }],
  },
  {
    id: "NO-INPUT-LOST-WHILE-OPENING",
    title: "Nothing a person does while the app is opening is lost",
    shapes: ALL,
    topic: "data",
    rule:
      "Until the application's script has finished starting — the database open, the handlers attached, the first draw done — show nothing a person can type into or submit. Put the interactive part of the page in an element marked both hidden and inert, `<main id=\"app\" hidden inert>`, beside a short line such as \"Opening…\". `inert` is what keeps it out of reach: `hidden` alone is undone by any style rule that sets `display` on that element, while an inert element takes no focus, typing or clicks whatever the CSS says. Run the whole start-up — `openDatabase()`, the first draw — inside try/catch. On success, hide the line and remove both attributes. On failure, replace the line with what went wrong and what the person can do next: never leave \"Opening…\" showing over a start-up that has already ended. Do not wait for an event to learn that start-up failed — the frame's `dai:error` message is posted outward to the host, is never delivered to the application, and nothing acts on it today; the application's own catch is the only place that knows. A page built only from the kit's elements is already safe: they are not `<form>` elements, so a button inside them submits nothing before the kit has started. A `<form>` of your own is not.",
    why:
      "The script's start-up waits on `await window.dai.openDatabase()`, which in a shared document waits for the host's write rules. A form on screen before then takes a person's typing while the application cannot yet handle it. Pressing Enter or its button then either makes the browser submit the form itself and replace the page, or does nothing at all — and the script's own start-up resets the form a moment later. Which of the two happens varies between browsers and between one opening and the next; either way what they typed is gone, with nothing to say why. Both blind runs copied examples that showed their forms early. The same failure arriving mid-edit, when another copy's rows land, is SHARED-REDRAW-ON-MERGE.",
    enforced: ["prose"],
    anchors: [
      { file: "tests/fixture/chess/app.js", contains: "$('boot-notice').hidden=true;$('app').hidden=false;" },
      { file: "examples/receipts/index.html", contains: '<main id="app" hidden inert>' },
      { file: "examples/tic-tac-toe/index.html", contains: '<main id="app" hidden inert>' },
      { file: "src/frame.ts", contains: 'ERROR: "dai:error"' },
      { file: "src/runtime/bootloader.ts", contains: '{type:${JSON.stringify(FRAME_INTERNAL.ERROR)},message:String(e.message)},"*")' },
      { file: "src/kit.ts", contains: "class DaiForm extends HTMLElement {" },
    ],
  },
  {
    id: "NO-SAVE-BUTTON",
    title: "Saving is automatic",
    shapes: ALL,
    topic: "data",
    rule:
      "Build no Save button, no \"saved\" indicator and no dirty flag. Under a host every write is saved as it happens (`window.dai.autosaves` is true). A page that uses the kit includes <dai-save> once, at the bottom: it appears only when the file was opened straight in a browser with no host, where saving takes a tap, and hides itself everywhere else. A page without the kit that must save with no host calls `window.dai.saveDatabase(db)` from a control shown only when `window.dai.autosaves` is false. A shared document needs no such control: with no host it cannot write its shared tables at all (SHARED-NEEDS-HOST).",
    why: "A save control under a host is a control that does nothing, and a person who presses it learns to distrust the rest.",
    enforced: ["prose"],
    anchors: [{ file: "src/runtime/bootloader.ts", contains: "autosaves: autosaves" }],
  },
  {
    id: "MIGRATE-CHANGED-TABLES",
    title: "A changed table needs a migration",
    shapes: ALL,
    topic: "data",
    rule:
      "When a later version changes an existing table, add a migration — one file in migrations/, named with the next number (migrations/002-add-priority.sql), holding the ALTER statements that move the old shape to the new — and update schema.sql to match. Adding a table needs no migration. Never drop a table to get past the check.",
    why: "A version whose schema moved without a migration is refused at build, because the old file holds somebody's data and nothing else says how to carry it forward.",
    enforced: ["compiler"],
    anchors: [{ file: "src/schema.ts", contains: 'export const MIGRATIONS_DIR = "migrations/"' }],
  },
  {
    id: "TIMES-IN-UTC",
    title: "Store UTC, show words",
    shapes: ALL,
    topic: "data",
    rule:
      "Store times as SQLite text in UTC (datetime('now')) and show them the way a person reads them — \"today\", \"2 hours ago\" — never as 2026-09-04 15:01:27. A time on a shared table is a fact somebody entered (a receipt's date), never a record of when a row was written: see SHARED-NO-DERIVED-STATE.",
    why: "Raw timestamps read as a machine talking. And a write time on a shared row is a second opinion about order that the replication already records.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "no timestamp" }],
  },

  // ----------------------------------------------------------------- shared
  {
    id: "SHARED-MARKER",
    title: "Mark a shared table",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Put the line -- dai:replicated directly above each table that more than one copy writes, with nothing but whitespace between the comment and CREATE TABLE. Only tables every party must agree on get it; everything about one copy stays local (SHARED-LOCAL-STAYS-LOCAL).",
    why:
      "The compiler rewrites a marked table into an append-only one with the columns, key, triggers and views replication needs. A marker further up is an ordinary comment and declares nothing.",
    enforced: ["compiler"],
    anchors: [{ file: "src/replicated.ts", contains: 'export const REPLICATED_MARKER = "dai:replicated"' }],
  },
  {
    id: "SHARED-DECIDE-UP-FRONT",
    title: "Decide which tables are shared before the first release",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Decide whether each table is shared before the application is first released, and do not plan to convert a local table into a replicated one later: that path is not supported or tested today.",
    why:
      "A replicated table carries the rewrite in every copy already saved, and whether a migration can turn an existing local table into one has not been established. Deciding the shape first (SHAPE-FIRST) is what makes this cheap.",
    enforced: ["prose"],
    anchors: [{ file: "src/replicated.ts", contains: "export function rewriteReplicated" }],
  },
  {
    id: "SHARED-NO-KEY",
    title: "No PRIMARY KEY, no AUTOINCREMENT",
    shapes: SHARED,
    topic: "shared",
    rule: "A replicated table declares no PRIMARY KEY and no AUTOINCREMENT. Its identity is the entity the write surface returns (SHARED-ENTITY-IDENTITY).",
    why: "The key belongs to replication. Two copies both advancing one counter allocate the same ids for different rows.",
    enforced: ["compiler"],
    anchors: [{ file: "src/replicated.ts", contains: "declares its own PRIMARY KEY" }],
  },
  {
    id: "SHARED-NO-UNIQUE-CHECK",
    title: "No UNIQUE, no CHECK",
    shapes: SHARED,
    topic: "shared",
    rule: "A replicated table declares no UNIQUE and no CHECK constraint, on a column or on the table.",
    why:
      "A UNIQUE(game_id, ply) refuses exactly the rows a merge exists to surface: two people acting at the same point is a conflict to show a person, not an error to raise at them. A CHECK that differs between two versions of the application rejects the other copy's honest rows, and they arrive as rejected rows rather than a refused merge, so nobody can see what happened.",
    enforced: ["lint"],
    lint: ["shared-table-constraint"],
    anchors: [{ file: "src/lint.ts", contains: '"shared-table-constraint": {' }],
  },
  {
    id: "SHARED-NO-R-COLUMNS",
    title: "No column names beginning _r_",
    shapes: SHARED,
    topic: "shared",
    rule: "Name no column of your own with the prefix _r_.",
    why: "That prefix is replication's; the rewrite adds _r_replica, _r_seq, _r_lc, _r_entity, _r_parents, _r_deleted, _r_superseded, _r_batch and, in a session document, _r_session.",
    enforced: ["compiler"],
    anchors: [{ file: "src/replicated.ts", contains: "uses the reserved prefix _r_" }],
  },
  {
    id: "SHARED-WRITE-SURFACE",
    title: "Write shared rows only through window.dai.replicated",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Write to a replicated table only with `window.dai.replicated.insert(table, values)`, `.change(table, entity, values)` and `.remove(table, entity)`, after `await window.dai.openDatabase()`. `values` is an object of your own columns. `change` takes every one of your columns, not only the ones that changed. Never run INSERT, UPDATE or DELETE against a replicated table — not in JavaScript, not in a kit control, not in a seed block.",
    why:
      "Rows are appended and never changed in place: an UPDATE or DELETE is refused with REPLICATED_TABLE_IMMUTABLE, and a raw INSERT fails because it lacks the replication columns only the write surface fills in.",
    enforced: ["runtime", "lint"],
    lint: ["shared-raw-write"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: "insert: (table: string, values: Any, sessionHex?: string): string =>" },
      { file: "src/replicated.ts", contains: "RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE')" },
    ],
  },
  {
    id: "SHARED-READ-CURRENT",
    title: "Read shared rows from the _current view",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Read a replicated table t only through the view t_current, which holds one row per live entity. Never SELECT from t itself for display or logic. Use t_conflicts or t_heads only to show or resolve a conflict (SHARED-SURFACE-CONFLICTS).",
    why:
      "The base table holds every version of every row: superseded edits, tombstones of deleted rows, and — in a session — rows from non-members and rows written after the close. Reading it shows all of them at once.",
    enforced: ["lint"],
    lint: ["shared-base-read"],
    anchors: [{ file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS ${q}_current AS" }],
  },
  {
    id: "SHARED-SURFACE-CONFLICTS",
    title: "Show conflicts; never pick silently",
    shapes: SHARED,
    topic: "shared",
    rule:
      "There are two kinds of conflict, and an application with shared tables must show both to the person and let them resolve it. (1) The same row edited on two copies: t_current still shows one version, with `_r_conflicted` = 1; the competing versions are the rows of t_heads for that entity (t_conflicts lists the entities). Show that it happened and offer the versions; the person resolves it by choosing, which the application writes as `change(table, entity, chosenValues)` — a change names every current head, so it settles the conflict. (2) Two new rows that claim one slot — two moves at the same turn, two people taking the same shift. Replication cannot see this (they are different rows); the application derives it from the rows (two rows with the same ply) and shows it, and the person keeps one while the other is removed.",
    why:
      "A merge that picked one version or one row and hid the other would read to a person as lost data. The runtime surfaces conflicts precisely so that the person, not the order the files arrived in, decides.",
    enforced: ["lint", "prose"],
    lint: ["shared-conflicts-unshown"],
    anchors: [
      { file: "src/replicated.ts", contains: "AS _r_conflicted" },
      { file: "src/replicated-rows.ts", contains: "Naming *all* the heads is what makes an edit made while a conflict is open a" },
    ],
  },
  {
    id: "SHARED-REDRAW-ON-MERGE",
    title: "Redraw when the other copy's rows arrive",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Listen for the `dai:merged` event on window and redraw everything drawn from shared tables when it fires: `window.addEventListener(\"dai:merged\", (event) => { redraw(); })`. `event.detail` carries `applied`, `duplicate`, `rejected`, `newReplicas`, `conflicts` and `via` — \"carrier\" when a file or link was opened, \"mailbox\" when rows arrived in the background. If the page uses the kit's reading elements, call `window.daiKit.refresh()` in the listener. A redraw must never discard what the person is in the middle of — text typed into a field, an editor that is open, a selection: rows arrive whenever the other copy's changes do, including mid-sentence. Keep work in progress outside what the redraw rebuilds — in a form written once in the HTML rather than recreated on every draw, or in a local drafts table the redraw reads back — or leave the element being edited untouched until it is saved or cancelled. The same failure arriving at start-up rather than mid-edit is NO-INPUT-LOST-WHILE-OPENING.",
    why:
      "Nothing else tells the application that another copy's rows landed. Without it the application draws once and redraws only after its own writes, so a two-person document looks broken in exactly the case it exists for. And a redraw that rebuilds an open editor from the stored wording throws away what was being typed, silently — found by running a blind candidate over the mailbox, where a background merge landed while a term was being edited.",
    enforced: ["lint"],
    lint: ["shared-no-merge-listener"],
    anchors: [
      { file: "src/frame.ts", contains: 'MERGED: "dai:merged"' },
      { file: "src/runtime/bootloader.ts", contains: 'new CustomEvent(names.MERGED, { detail: { ...report, via: "carrier" } })' },
      { file: "src/runtime/bootloader.ts", contains: 'new CustomEvent(names.MERGED, { detail: { ...report, via: "mailbox" } })' },
      { file: "tests/fixture/chess/schema.sql", contains: "A tentative move lives here until the player commits it" },
    ],
  },
  {
    id: "SHARED-POINTER-HOLDS-THE-SCREEN",
    title: "Never redraw while a finger is down",
    shapes: SHARED,
    topic: "shared",
    rule:
      "A merge can arrive at any moment, including between a press and its release: never redraw while a pointer is down, draw when it lifts, and read the state when you act, not when you drew. Set a flag on `pointerdown`, clear it on `pointerup` and `pointercancel`, and have the redraw note itself and run when the flag clears; a redraw from the person's own action is already after their release and needs nothing. Then check, in the handler, that what the tap asks for is still legal — the merge you held back may have taken the square, ended the game or moved the turn — and say so if it is not.",
    why:
      "A redraw replaces the elements it drew. If that happens between a press and its release, the browser fires no click at all, because the element that was pressed is gone: the tap is lost with no error, nothing on screen changes, and the person taps again. It is not rare — a live opponent's move arrives exactly while somebody is tapping. Reimplementing the tap from press and release instead is worse: it inherits scrolling, pointer capture, a finger that slides off, long-press, touch-cancel, the keyboard and assistive technology, and one of those is always got wrong. Holding the redraw back for the length of a tap costs nothing and keeps `click` meaning what it means.",
    enforced: [],
    anchors: [
      { file: "examples/tic-tac-toe/app.js", contains: "Never redraw under a finger (D79, SHARED-POINTER-HOLDS-THE-SCREEN)" },
      { file: "examples/tic-tac-toe/app.js", contains: "let pointerDown = false;" },
      { file: "src/kit.ts", contains: "if (refreshPending && !pointerDown) refresh();" },
    ],
  },
  {
    id: "SHARED-NO-DERIVED-STATE",
    title: "Store facts, derive everything else",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Store in a shared table only the facts people enter or acts they take — a receipt, a move, a mark. Never store anything computable from them: no board, no score, no turn, no total, no balance, no \"last updated\", no status that follows from other rows. Compute it from the rows each time it is drawn, preferably in SQL.",
    why:
      "A stored total is a second opinion about what the rows say, and after a merge it is wrong: each copy computed it from the rows it had, and neither computed it from the union.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "No board, no turn, no result, no timestamp" }],
  },
  {
    id: "SHARED-LOCAL-STAYS-LOCAL",
    title: "What belongs to one copy stays local",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Keep in ordinary local tables everything about this copy rather than the document: settings, drafts, which item the screen is showing, what this person has hidden, the name this person goes by. Local tables are never merged, so they may use PRIMARY KEY, UNIQUE and CHECK freely. They travel only in a whole-document copy — a file, or the host menu's share — where a person opening it for the first time starts from the sender's local rows. An invite into one session carries none of them, and a copy that already exists keeps its own local rows when another copy's shared rows are merged into it.",
    why: "A setting in a shared table changes the other person's screen, and a draft in one is sent before it is finished.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "Local tables. Never merged" }],
  },
  {
    id: "SHARED-ENTITY-IDENTITY",
    title: "A shared row's identity is its entity",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Refer to a shared row by the entity the write surface returned: 32 lowercase hex characters. Read it back as `lower(hex(_r_entity))`. To point one shared row at another (a move at its game), store that hex string in an ordinary TEXT column and compare it with `lower(hex(_r_entity))`. A particular version of a row is its key, `(_r_replica, _r_seq)` — the same on every copy — so an application that needs to name \"this exact wording\" (what a person accepted, say) can use it.",
    why: "The entity is the same on every copy, where an id of your own would be allocated separately on each.",
    enforced: ["prose"],
    anchors: [{ file: "tests/fixture/chess/schema.sql", contains: "hex entity of the games row" }],
  },
  {
    id: "IDENTITY-ONE-LIVE-COPY",
    title: "One document, one live copy per device",
    shapes: SHARED,
    topic: "identity",
    rule:
      "A device holds one copy of a document. A copy of a document this device already holds never becomes a second copy beside it: when it arrives, the host merges it into the held copy, takes it in place of the held one, or keeps the held one and sets the arrival aside. A loose file opened twice is the same document arriving twice. An application never keeps two copies of itself apart, and never needs to: the host decides before the application runs. Two tabs showing the same held copy are not yet covered (backlog D105).",
    why: "Every copy on a device writes under that device's one author id, the fingerprint of its person key (docs/identity.md), and a shared row's version is named by `(_r_replica, _r_seq)`. Two copies writing on one device would issue the same pair for different rows, and the next exchange would refuse one of them as tampering. Row identity by content hash would remove the hazard (backlog D104).",
    enforced: ["runtime"],
    anchors: [{ file: "apps/runner/src/main.ts", contains: "this host keeps one copy per document" }],
  },
  {
    id: "IDENTITY-SEAT-ADMITS",
    title: "A signature says who wrote a row; a seat says whether they may",
    shapes: ["session"],
    topic: "identity",
    rule:
      "A session app admits a row only from the author holding the seat that row's action belongs to: a move for White only from whoever holds White's seat. That the row is correctly signed is not enough, because a signature answers who wrote it and not whether they may. The kit does the check inside its merge path, so an app cannot skip it, and reports a refused row as SEAT_NOT_HELD with its author. Until the kit provides it (step 5 of docs/identity.md), nothing enforces this.",
    why: "D80: a copy under the creator's id played the creator's move. Once every row is stamped with its author's own key, the move arrives honestly as the other player's, and it is still the wrong player's move. Only the seat can say so.",
    enforced: ["prose"],
    anchors: [{ file: "docs/identity.md", contains: "A signature answers who wrote a row; a seat answers whether they may." }],
  },
  {
    id: "SHARED-SEED-THROUGH-SURFACE",
    title: "Shared rows are never seeded with SQL",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Seed no replicated table from a <script type=\"application/sql\"> block. Prefer to seed nothing shared: an empty shared table with a good empty state is correct. If a shared example row is essential, insert it with `window.dai.replicated.insert` once, guarded by a flag in a local table, so a second open and a second copy do not add it again.",
    why: "A raw INSERT into a replicated table fails (it lacks the replication columns), and a seed that every copy writes on its own first open puts a duplicate in every merge.",
    enforced: ["runtime", "lint"],
    lint: ["shared-raw-write"],
    anchors: [{ file: "src/replicated.ts", contains: "_r_replica    BLOB    NOT NULL" }],
  },
  {
    id: "SHARED-NEEDS-HOST",
    title: "A shared document writes only under a host",
    shapes: SHARED,
    topic: "shared",
    rule:
      "Expect shared tables to be writable only when the document is opened by a host — the DAI opener or the desktop app — which delivers the write rules. Opened straight in a browser as a plain file, `openDatabase()` resolves after the rules wait (about 10 seconds) and every shared write is refused with WRITE_SURFACE_UNAVAILABLE. Catch that error around writes and tell the person to open the document in the opener; local tables still work.",
    why: "The rules that stamp and merge a replicated row come from the host. A shared write without them would be a row no other copy could merge.",
    enforced: ["runtime"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: 'const error = new Error(`WRITE_SURFACE_UNAVAILABLE (${reason})`);' },
      { file: "src/runtime/bootloader.ts", contains: "const RULES_WAIT_MS = 10_000;" },
    ],
  },

  // ---------------------------------------------------------------- session
  {
    id: "SESSION-PROFILE",
    title: "Declare the session profile",
    shapes: SESSION,
    topic: "session",
    rule:
      "Declare a session document with one line comment in schema.sql: -- dai:profile session max_parties=N close=any|creator. N is the most people the document allows, at least 1 — but today a session seats two whatever N says: `session.create()` mints the creator's seat and one open seat, and no call adds another (backlog D6). Declare max_parties=2, and do not build an application that needs a third member. close=any lets any member close a session; close=creator lets only the person who created it; it defaults to any. The document must also have at least one table marked -- dai:replicated. Every replicated table then carries the session of each row.",
    why:
      "The profile is signed into the document, so the size of the group is the creator's stated limit rather than something the application decides. A malformed profile, or one with no replicated table, is refused at build.",
    enforced: ["compiler"],
    anchors: [
      { file: "src/replicated.ts", contains: 'export const SESSION_PROFILE_MARKER = "dai:profile session"' },
      { file: "src/replicated.ts", contains: "no table is marked -- dai:replicated" },
    ],
  },
  {
    id: "SESSION-CREATE",
    title: "A new game is a new session",
    shapes: SESSION,
    topic: "session",
    rule:
      "Start each game, match or agreement with `const { session, seat } = window.dai.replicated.session.create()`. It seats the creator and leaves one open seat for the invitee; `session` is the id to keep (hex), `seat` is the open seat. Then insert the thing itself — the games row — with that session (SESSION-ROW-CARRIES-SESSION). Do both in one transaction if you write local rows beside them: `session.create()` and `insert` work inside a `BEGIN` … `COMMIT` you open. The creator is a member from the moment the session exists, so the creator's rows are admitted before anyone has joined — the first move can be made before the invite is sent.",
    why: "A session is the unit of membership. Rows written outside one belong to nobody, and a second game in the same session would share the first game's roster.",
    enforced: ["prose"],
    anchors: [{ file: "src/runtime/bootloader.ts", contains: "create: (): { session: string; seat: string } =>" }],
  },
  {
    id: "SESSION-ROW-CARRIES-SESSION",
    title: "Every insert names its session",
    shapes: SESSION,
    topic: "session",
    rule:
      "In a session document, pass the session id as the third argument of every insert: `window.dai.replicated.insert(\"moves\", values, session)`. `change` and `remove` take no session — they inherit the entity's.",
    why:
      "Every replicated row in a session document belongs to a session. Run against the write rules: an insert without one throws \"A row for … carries no session, but <table> declares the session profile\", and nothing is written.",
    enforced: ["runtime"],
    anchors: [
      { file: "src/replicated-rows.ts", contains: "carries no session, but" },
      { file: "src/replicated.ts", contains: "_r_session    BLOB    NOT NULL" },
      { file: "src/replicated-rows.ts", contains: "The session is inherited from the entity's head" },
    ],
  },
  {
    id: "SESSION-AUTHOR-ROLES",
    title: "Say which party writes a table",
    shapes: SESSION,
    topic: "session",
    rule:
      "When the two parties in a session are not interchangeable — one asks and the other answers, one offers and the other accepts — put the role on the table's marker: `-- dai:replicated author=creator` for a table only the session's creator writes, `-- dai:replicated author=joiner` for a table only the party who took the invite writes. A table with no role is written by either member. The creator is the copy that called `session.create()`; the joiner is the other member. A write by the wrong party throws ROLE_NOT_PERMITTED, which names the table and which party wrote it, and nothing is written. Hide or disable the other party's controls, and read which party this copy is from the seats (SESSION-MEMBERSHIP), never from a stored column.",
    why:
      "The role is signed into the document and held twice. The write surface refuses the wrong party, and a row that reaches a copy some other way — a copy with the check removed, a hand-built batch — is stored but never admitted to the _current views, so it never shows and never buries a legitimate row. At build, a role other than creator or joiner is refused, a role in a document with no session profile is refused, and a marker that begins as -- dai:replicated but does not parse is refused rather than built as a local table.",
    enforced: ["compiler", "runtime"],
    anchors: [
      { file: "src/replicated.ts", contains: "const AUTHOR_CLAUSE = /^dai:replicated\\s+author\\s*=\\s*([A-Za-z]+)$/i;" },
      { file: "src/replicated.ts", contains: "role, but the document has no session profile." },
      { file: "src/runtime/bootloader.ts", contains: "ROLE_NOT_PERMITTED (the joiner wrote ${table}" },
    ],
  },
  {
    id: "SESSION-JOIN-ON-OPEN",
    title: "Take the open seat when an invite is opened",
    shapes: SESSION,
    topic: "session",
    rule:
      "When this copy opens an invite, bind its open seat with `window.dai.replicated.session.join(session, seat)`: once at start-up, and again in the `dai:merged` listener only when `event.detail.via === \"carrier\"` — never for \"mailbox\". Join only if this copy is not already a member and an open seat exists: the open seat is a `_dai_seat_current` row for the session whose seat no `_dai_binding_current` row binds. Join the session the invite was sent for. An invite carries only that session and none of the sender's local rows (SESSION-INVITE), so it is a session with an open seat that this copy did not create and is not a member of — in a fresh copy made from an invite there is exactly one. That includes a copy whose seat was contested or replaced: opening the creator's fresh invite is how it gets back in, and excluding copies that were ever seated would lock it out for good. Prefer the item that is showing when it is joinable (a copy that arrived as a whole document carries the sender's local rows, including which item was showing), otherwise take the newest joinable one, and make it the item showing.",
    why:
      "Membership comes from opening an invite, not from rows arriving. A copy that joined on every background merge would re-take a seat it had lost, and a copy that joined twice would contest its own seat.",
    enforced: ["prose"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: "join: (sessionHex: string, seatHex: string): void =>" },
      { file: "tests/fixture/chess/app.js", contains: "e.detail.via==='carrier'" },
    ],
  },
  {
    id: "SESSION-MEMBERSHIP",
    title: "Read membership, and show the three ways to be outside",
    shapes: SESSION,
    topic: "session",
    rule:
      "This copy's replica id is `SELECT lower(hex(id)) AS id FROM _dai_replica`. It is a member of a session when `_dai_member` has a row for (session, replica). Enable writing only for members, and show a copy that is not one which of three states it is in: it holds the rows but is not a member, and no seat is open to it — which is both a copy forwarded to someone who was never in the game and a player's own new device or browser, and the copy cannot tell them apart, so say that the seats belong to other devices and never that the person was not invited; it joined but its seat was contested or replaced (SESSION-CONTESTED-SEAT); or the session is closed (SESSION-CLOSE). The _current views of a session document show only admitted rows — rows by members, written before any close.",
    why:
      "A non-member's rows are kept but never admitted, so an application that let a non-member play would show them their own moves and nobody else ever would. Saying which state a copy is in is the difference between a message and a hang.",
    enforced: ["prose"],
    anchors: [{ file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS _dai_member AS" }],
  },
  {
    id: "SESSION-CONTESTED-SEAT",
    title: "A contested seat is a state to show",
    shapes: SESSION,
    topic: "session",
    rule:
      "A seat bound by two or more different replicas is contested — two people opened the same invite — and admits neither. Detect it as a `_dai_binding_current` seat with `count(DISTINCT _r_replica) > 1` for the session. Show the creator that the invite went to more than one device and offer a fresh invite: `window.dai.replicated.session.reseat(session)`, then share again. Show a copy whose own seat was lost that nothing it did lost its place, and that the creator can send a new invite. `reseat` refuses with NOT_SEAT_CREATOR for anyone but the creator and with CANNOT_RESEAT when no seat is contested.",
    why: "It is resolved without a clock deciding who opened the invite first, so neither copy can be admitted until the creator repairs it; an application that treated it as an error would leave both people stuck.",
    enforced: ["runtime", "prose"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: 'throw new Error("CANNOT_RESEAT")' },
      { file: "src/runtime/bootloader.ts", contains: 'throw new Error("NOT_SEAT_CREATOR")' },
    ],
  },
  {
    id: "SESSION-CLOSE",
    title: "Closing is separate from finishing",
    shapes: SESSION,
    topic: "session",
    rule:
      "Ending the activity is an ordinary row: a resignation, a final mark, a signature. Closing the session is a separate, heavier act — `window.dai.replicated.session.close(session)` — after which rows written later than what the closer had seen are not admitted. Offer it only on a finished session, never as the way to end a live one. Closing as part of an act whose point is finality — sealing an agreement once both have accepted it — is exactly what close is for: write the act as a row, then close. Read whether a session is closed from `_dai_close_current` (any row for the session). Under close=creator a non-creator's close is refused with CLOSE_NOT_PERMITTED; hide or disable the control for them.",
    why: "A close is final for the group, and it is decided by what the closer had seen rather than by a clock. Folding it into \"resign\" would end a session the other person had not finished with.",
    enforced: ["runtime", "prose"],
    anchors: [
      { file: "src/runtime/bootloader.ts", contains: "close: (sessionHex: string): void =>" },
      { file: "src/runtime/bootloader.ts", contains: 'throw new Error("CLOSE_NOT_PERMITTED")' },
    ],
  },
  {
    id: "SESSION-INVITE",
    title: "An invite is a shared link",
    shapes: SESSION,
    topic: "session",
    rule:
      "Invite the other party by asking the host to share, naming the session: a button that calls `window.dai.requestShare(session)`. There is no invite call of your own. The copy that travels holds only that session's rows — none of the document's other sessions, and none of this copy's local tables — so the recipient gets this one game and nothing else of the sender's. Without a session, `requestShare()` offers the whole document, every session in it, as the host's own menu does; use it for that, never for an invite. After a copy has been shared by link, the host moves new rows between the copies on its own, and they arrive as `dai:merged` with `via` \"mailbox\"; a copy handed over as a file carries its rows when it is opened. The application never sends rows itself. **What the link means:** a link to one game, carrying that game's rows and its key; opening it gives the recipient the game, and the open seat if one is still open. So the same call both starts a game with someone and sends them a game they are already in: someone who closed the tab or lost the link opens it and is back. Keep offering it after the other party has joined, not only before; hiding it once the seats are filled leaves a player who lost the link no way back but a new game. It does not seat a player on a new device or browser whose seat is bound to their old one; nothing can yet (backlog D48).",
    why: "The host mints the key that lets the two copies exchange rows and makes the link; the application only asks, and only the application knows which game it is inviting to. Filtering to that game is what keeps a person's other games — and whatever they keep only on their own device — out of every invite they send.",
    enforced: ["prose"],
    anchors: [
      { file: "src/frame.ts", contains: 'REQUEST_SHARE: "dai:request-share"' },
      { file: "src/runtime/bootloader.ts", contains: 'window.parent.postMessage({ type: names.REQUEST_SHARE, ...(invite ? { session: invite } : {}) }, "*");' },
      { file: "apps/runner/src/main.ts", contains: "const html = invite ? await inviteHtml(invite) : await currentHtml(withData.checked);" },
      { file: "apps/runner/src/main.ts", contains: "Sharing is the moment a solo document becomes a shared one" },
    ],
  },

  // -------------------------------------------------------------------- kit
  {
    id: "KIT-FIRST",
    title: "Prefer the kit for local tables",
    shapes: ALL,
    topic: "kit",
    rule:
      "Use dai-kit for local tables: <dai-rows>, <dai-value>, <dai-form>, <dai-attach> and <dai-save>, with <script type=\"module\" src=\"./dai-kit.js\"></script> at the end of the body. Reach for JavaScript only for what the kit cannot express. Do not write dai-kit.js yourself or put it in the bundle: the compiler adds it to every container.",
    why: "The kit removes the dangerous sinks by construction — no statement built from a value, text-only rendering — and does the querying, rendering and redrawing a hand-written application gets wrong.",
    enforced: ["prose"],
    anchors: [
      { file: "src/kit.ts", contains: "customElements.define('dai-rows', DaiRows);" },
      { file: "tests/kit.spec.ts", contains: 'archive["app/dai-kit.js"]' },
    ],
  },
  {
    id: "SHARED-KIT-READS",
    title: "The kit reads shared tables; it does not write them",
    shapes: SHARED,
    topic: "kit",
    rule:
      "The kit's write controls — data-run, <dai-form run=…>, <dai-attach run=…> — run plain SQL, so they are for local tables only. On a shared table they fail (SHARED-WRITE-SURFACE), and the kit neither catches the error nor shows it. The kit's reading elements, <dai-rows> and <dai-value>, work over t_current views; redraw them on a merge with `window.daiKit.refresh()` (SHARED-REDRAW-ON-MERGE). Write shared rows in JavaScript through `window.dai.replicated`.",
    why: "Run against the rewrite: a kit INSERT into a replicated table fails with SQLite's NOT NULL error, and an UPDATE or DELETE with REPLICATED_TABLE_IMMUTABLE — uncaught, so the person sees nothing happen.",
    enforced: ["lint"],
    lint: ["shared-raw-write"],
    anchors: [
      { file: "src/kit.ts", contains: "if (names.length === 0) db.exec(sql);" },
      { file: "src/kit.ts", contains: "window.daiKit = { db: db, run: run, refresh: refresh };" },
    ],
  },

  // ----------------------------------------------------------- presentation
  {
    id: "ICON-SVG",
    title: "An icon that reads at 48 pixels",
    shapes: ALL,
    topic: "presentation",
    rule:
      "Include icon.svg: a simple, bold mark on a square canvas (viewBox=\"0 0 100 100\"), with a filled background, no text smaller than a third of the canvas, and no external references.",
    why: "It becomes the application's icon on a phone's home screen and in a browser tab.",
    enforced: ["prose"],
    anchors: [{ file: "src/core.ts", contains: 'const ICON_ENTRIES = ["icon.svg", "favicon.svg"];' }],
  },
  {
    id: "DESCRIBE-ON-CARD",
    title: "One line, and three things it does",
    shapes: ALL,
    topic: "presentation",
    rule:
      "In the <head> of index.html: <meta name=\"description\" content=\"…\"> — what it is for, under 60 characters, the way a store page puts a line under an app's name; and exactly three <meta name=\"dai:does\" content=\"…\"> lines, each under 90 characters, starting with a verb, saying what somebody would tell a friend it does. Three, or none. Beside them, <meta name=\"theme-color\" content=\"…\"> with the application's own background color.",
    why: "These are the whole of what a person sees on the card before they decide to open the document; two lines is a card with a gap in it.",
    enforced: ["prose"],
    anchors: [{ file: "apps/runner/src/card.ts", contains: "name=[\"']dai:does[\"']" }],
  },
  {
    id: "EDGE-TO-EDGE",
    title: "Color to the edge, content inside it",
    shapes: ALL,
    topic: "presentation",
    rule:
      "Paint the background to every edge of the screen, and push content clear of the strips a phone covers using the four custom properties the host sets: var(--dai-safe-top, 0px), var(--dai-safe-right, 0px), var(--dai-safe-bottom, 0px), var(--dai-safe-left, 0px). Usually that is padding at the top of what is first and at the bottom of what is last.",
    why: "Nothing is reserved for the host, so an application that ignores this puts its own title under the clock and its last row under the home indicator.",
    enforced: ["prose"],
    anchors: [{ file: "src/runtime/bootloader.ts", contains: "setProperty(`--dai-safe-${edge}`" }],
  },
  {
    id: "TOP-RIGHT-CLEAR",
    title: "Nothing tappable in the top right corner",
    shapes: ALL,
    topic: "presentation",
    rule: "Leave the top right corner clear of anything tappable.",
    why: "The host floats one small round button there, over the application, and it is how a person reaches the menu.",
    enforced: ["prose"],
    anchors: [{ file: "apps/runner/index.html", contains: '<button id="more" type="button" aria-label="More"' }],
  },
  {
    id: "ONE-LAYOUT",
    title: "One layout for every screen",
    shapes: ALL,
    topic: "presentation",
    rule:
      "Build one layout that holds from about 320px wide to a wide desktop window: a single column that grows, sensible maximum widths on text, tap targets no smaller than 44px, no fixed pixel widths on anything that holds content. Check it at 390px and at 1280px. Do not ask which device it is for and do not build two.",
    why: "A document is sent as a link, and the sender does not choose whether it is opened on a phone, a tablet or a desktop.",
    enforced: ["prose"],
    anchors: [{ file: "examples/receipts/app.css", contains: "grid-template-columns: repeat(auto-fit, minmax(140px, 1fr))" }],
  },
  {
    id: "LOOK-FINISHED",
    title: "Make it look finished",
    shapes: ALL,
    topic: "presentation",
    rule: "Real spacing, a considered empty state, keyboard support, and a dark mode through prefers-color-scheme.",
    why: "It is a document somebody will keep.",
    enforced: ["prose"],
    anchors: [{ file: "examples/receipts/app.css", contains: "@media (prefers-color-scheme: dark)" }],
  },

  // --------------------------------------------------------------- handover
  {
    id: "HANDOVER-BUNDLE",
    title: "One bundle, or a tool call",
    shapes: ALL,
    topic: "handover",
    rule:
      "When a tool is available, call it with the files as its arguments. Otherwise write the whole application as ONE fenced code block in the bundle format shown under HOW TO HAND IT OVER — one fence around every file, each file starting with a line \"--- file: <path>\". The bundle's second line is name: followed by the application's name, which becomes its title and file name. index.html is the entry point; other files are referenced from it by relative path.",
    why: "Outside a fence a chat window draws the file markers as dividing lines and breaks the application into pieces nobody can copy.",
    enforced: ["prose"],
    anchors: [{ file: "src/bundle.ts", contains: "dai bundle v1" }],
  },
];

/** Constraints by id. */
export const CONSTRAINT_BY_ID: ReadonlyMap<string, Constraint> = new Map(
  CONSTRAINTS.map((constraint) => [constraint.id, constraint]),
);

/* ----------------------------------------------------------- the surface */

export interface SurfaceEntry {
  call: string;
  does: string;
  shapes: readonly Shape[];
  /** Where the runtime defines it. */
  anchor: Anchor;
}

/** Everything an application is given, one line each. */
export const SURFACE: readonly SurfaceEntry[] = [
  {
    call: "await window.dai.openDatabase()",
    does: "Opens the database inside this file. In a shared document it waits for the host's write rules first.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "openDatabase: (options?: { pageSize?: number }): Promise<Any> =>" },
  },
  {
    call: "db.exec(sql)",
    does: "Runs one or more statements.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "db.exec = (...args: Any[]): Any =>" },
  },
  {
    call: "db.exec({ sql, bind })",
    does: "Runs a statement with bound parameters. Omit bind when there are none: an empty array throws.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "db.exec = (...args: Any[]): Any =>" },
  },
  {
    call: "db.selectObjects(sql, bind?)",
    does: "Returns rows as plain objects. bind is an array for ? or an object for :name.",
    shapes: ALL,
    anchor: { file: "src/kit.ts", contains: "db.selectObjects(this.getAttribute('query'))" },
  },
  {
    call: "db.selectValue(sql, bind?)",
    does: "The first column of the first row — a count, a setting, a total.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: '"selectValue", "selectArray"' },
  },
  {
    call: "window.dai.autosaves",
    does: "True under a host: every write is saved as it happens, and nothing needs pressing.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "autosaves: autosaves" },
  },
  {
    call: "await window.dai.saveDatabase(db)",
    does: "Saves now. Needed only where there is no host (a file opened straight in a browser). Returns { saved, method }.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "saveDatabase: (db: Any, options?: Any) =>" },
  },
  {
    call: "window.dai.exportDatabase(db)",
    does: "The database as bytes, without saving.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "exportDatabase: exportDatabase" },
  },
  {
    call: "window.dai.documentUuid",
    does: "This document's identity.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "documentUuid" },
  },
  {
    call: "window.dai.signature",
    does: '"valid", "unsigned" or "invalid" for this container.',
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "signature" },
  },
  {
    call: "window.dai.onAppModeChange(fn)",
    does: "Called when the container enters or leaves full-screen App Mode.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "onAppModeChange" },
  },
  {
    call: "window.dai.requestShare(session?)",
    does:
      "Opens the host's own share sheet — the same one behind its menu. Does not share anything itself: the person still sees the card, still chooses whether to include their data, and still presses Send. In a session document, pass the session id to make it an invite into that one session: the copy that travels holds only that session's rows, and none of the other sessions or of this copy's local tables. Without one, the whole document is offered.",
    shapes: ALL,
    anchor: { file: "src/runtime/bootloader.ts", contains: "requestShare: (session?: string) =>" },
  },
  {
    call: "window.dai.reportWaiting(sessions)",
    does:
      "Tells the host which sessions (hex) wait on this person, such as the games where it is their turn. The host uses the latest report to badge the home-screen icon when a move arrives while the app is closed. Send the whole set whenever it may have changed: at start-up, after a merge, after this person's move. The badge is a hint between opens, not a count to rely on.",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "reportWaiting: (sessions: unknown) =>" },
  },
  {
    call: "window.dai.replicated.insert(table, values, session?)",
    does:
      "Creates a shared row and returns its entity (32 hex characters). values is an object of your own columns. In a session document, session (hex) is required.",
    shapes: SHARED,
    anchor: { file: "src/runtime/bootloader.ts", contains: "insert: (table: string, values: Any, sessionHex?: string): string =>" },
  },
  {
    call: "window.dai.replicated.change(table, entity, values)",
    does:
      "Writes a new version of a shared row, naming every current version as its parent — which is also how a conflict is resolved. values carries every one of your columns. Returns the entity.",
    shapes: SHARED,
    anchor: { file: "src/runtime/bootloader.ts", contains: "change: (table: string, entityHex: string, values: Any): string =>" },
  },
  {
    call: "window.dai.replicated.remove(table, entity)",
    does: "Deletes a shared row by writing a tombstone. The row leaves t_current. Returns the entity.",
    shapes: SHARED,
    anchor: { file: "src/runtime/bootloader.ts", contains: "remove: (table: string, entityHex: string): string =>" },
  },
  {
    call: "window.dai.replicated.session.create()",
    does: "Starts a session: seats this copy and leaves one open seat. Returns { session, seat } as hex.",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "create: (): { session: string; seat: string } =>" },
  },
  {
    call: "window.dai.replicated.session.join(session, seat)",
    does: "Binds this copy to an open seat. Call it when this copy opens an invite (SESSION-JOIN-ON-OPEN).",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "join: (sessionHex: string, seatHex: string): void =>" },
  },
  {
    call: "window.dai.replicated.session.close(session)",
    does: "Closes a session at what this copy has seen. Throws CLOSE_NOT_PERMITTED for a non-creator under close=creator.",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "close: (sessionHex: string): void =>" },
  },
  {
    call: "window.dai.replicated.session.reseat(session)",
    does:
      "The creator's repair for a contested seat: replaces the open seat so a fresh invite can be taken. Throws NOT_SEAT_CREATOR for anyone else and CANNOT_RESEAT when no seat is contested.",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "reseat: (sessionHex: string): void =>" },
  },
  {
    call: 'window.addEventListener("dai:merged", fn)',
    does:
      'Fired when another copy\'s rows arrive. event.detail: { applied, duplicate, rejected, newReplicas, conflicts, via } — via is "carrier" (a file or link was opened) or "mailbox" (rows arrived in the background).',
    shapes: SHARED,
    anchor: { file: "src/frame.ts", contains: 'MERGED: "dai:merged"' },
  },
  {
    call: "window.daiKit.refresh()",
    does: "Re-runs every kit query on the page. Call it in the dai:merged listener when the page uses <dai-rows> or <dai-value>.",
    shapes: ALL,
    anchor: { file: "src/kit.ts", contains: "window.daiKit = { db: db, run: run, refresh: refresh };" },
  },
];

/**
 * The four custom properties a host sets on the application's own root, for
 * EDGE-TO-EDGE. Zero on a screen with nothing in the way.
 */
export const CSS_VARS: { name: string; is: string }[] = [
  { name: "--dai-safe-top", is: "How much of the top edge a status bar covers." },
  { name: "--dai-safe-right", is: "How much of the right edge is covered." },
  { name: "--dai-safe-bottom", is: "How much of the bottom edge a home indicator covers." },
  { name: "--dai-safe-left", is: "How much of the left edge is covered." },
];

/* ------------------------------------------------------------ the schema */

export interface ViewEntry {
  name: string;
  shapes: readonly Shape[];
  holds: string;
  read: string;
  anchor: Anchor;
}

/** What the rewrite creates, for a replicated table t and for the document. */
export const VIEWS: readonly ViewEntry[] = [
  {
    name: "t_current",
    shapes: SHARED,
    holds:
      "One row per live entity: the latest version, with your columns, the _r_ columns, and _r_conflicted (1 when the entity has more than one current version). In a session document, only admitted rows.",
    read: "Read this for everything the application shows.",
    anchor: { file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS ${q}_current AS" },
  },
  {
    name: "t_conflicts",
    shapes: SHARED,
    holds: "One row per entity edited concurrently on two copies: _r_entity, heads (how many versions), head_ids.",
    read: "Read this to list what needs a person's decision.",
    anchor: { file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS ${q}_conflicts AS" },
  },
  {
    name: "t_heads",
    shapes: SHARED,
    holds: "Every current version of every entity, including a deleted entity's tombstone. In a session document, only admitted rows.",
    read: "Read this only to show the competing versions of a conflicted entity.",
    anchor: { file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS ${q}_heads AS" },
  },
  {
    name: "t",
    shapes: SHARED,
    holds: "Every row ever written, superseded and deleted ones included, and — in a session — non-member and late rows.",
    read: "Never read it for display or logic. Never write to it.",
    anchor: { file: "src/replicated.ts", contains: "_r_superseded INTEGER NOT NULL DEFAULT 0" },
  },
  {
    name: "_dai_replica",
    shapes: SHARED,
    holds: "The author this copy writes under: id (16 bytes, the fingerprint of this device's person key, handed over by the host on every open), seq, lc, label. One row once this copy has written anything or arrived from somebody else; empty in a brand-new document before its first write, so read it as possibly absent. The same id on every copy this device holds.",
    read: "SELECT lower(hex(id)) AS id FROM _dai_replica — this copy's replica id.",
    anchor: { file: "src/replicated.ts", contains: "CREATE TABLE IF NOT EXISTS _dai_replica" },
  },
  {
    name: "_dai_seat_current",
    shapes: SESSION,
    holds: "The seats the creator minted: seat, and _r_session. _r_replica is the creator.",
    read: "Who created a session, and which seats exist.",
    anchor: { file: "src/replicated.ts", contains: "_dai_seat" },
  },
  {
    name: "_dai_binding_current",
    shapes: SESSION,
    holds: "The seats joiners bound: seat, _r_session; _r_replica is the joiner.",
    read: "Which seat is open (minted, not bound) and which is contested (bound by more than one replica).",
    anchor: { file: "src/replicated.ts", contains: "_dai_binding" },
  },
  {
    name: "_dai_member",
    shapes: SESSION,
    holds: "session, replica: the replicas admitted to each session — each binds a minted seat that exactly one replica binds.",
    read: "Whether this copy may write in a session.",
    anchor: { file: "src/replicated.ts", contains: "CREATE VIEW IF NOT EXISTS _dai_member AS" },
  },
  {
    name: "_dai_close_current",
    shapes: SESSION,
    holds: "The close of each closed session: one row per replica the closer had seen, with its highest seq.",
    read: "Whether a session is closed: any row for it.",
    anchor: { file: "src/replicated.ts", contains: "CREATE TABLE IF NOT EXISTS _dai_close" },
  },
];

export interface MarkerEntry {
  marker: string;
  where: string;
  does: string;
  shapes: readonly Shape[];
  anchor: Anchor;
}

export const MARKERS: readonly MarkerEntry[] = [
  {
    marker: "-- dai:replicated",
    where: "In schema.sql, directly above a CREATE TABLE, with only whitespace between.",
    does: "Makes that table replicated: append-only, merged by union, read through t_current.",
    shapes: SHARED,
    anchor: { file: "src/replicated.ts", contains: 'export const REPLICATED_MARKER = "dai:replicated"' },
  },
  {
    marker: "-- dai:profile session max_parties=N close=any|creator",
    where: "In schema.sql, any line comment (not inside a string or a block comment). close is optional and defaults to any.",
    does: "Makes the document a session document: every replicated row carries a session, and only members' rows are admitted.",
    shapes: SESSION,
    anchor: { file: "src/replicated.ts", contains: 'export const SESSION_PROFILE_MARKER = "dai:profile session"' },
  },
  {
    marker: "-- dai:replicated author=creator|joiner",
    where: "In place of -- dai:replicated, directly above a CREATE TABLE, in a document with a session profile.",
    does: "Makes the table replicated and writable by one party only: the session's creator, or the member who took the invite. The wrong party's write is refused with ROLE_NOT_PERMITTED; its rows, if they arrive another way, are never admitted.",
    shapes: SESSION,
    anchor: { file: "src/replicated.ts", contains: "const AUTHOR_CLAUSE = /^dai:replicated\\s+author\\s*=\\s*([A-Za-z]+)$/i;" },
  },
];

/* -------------------------------------------------- refusals an app meets */

export interface AppRefusal {
  code: string;
  when: string;
  then: string;
  shapes: readonly Shape[];
  anchor: Anchor;
}

/**
 * The refusals an application author meets, in the frame or at build.
 *
 * Kept here, beside the constraints they enforce, because the registry in
 * refusals.ts is the host's vocabulary and does not yet carry these (backlog
 * D2). Each is anchored to the line that throws it.
 */
export const APP_REFUSALS: readonly AppRefusal[] = [
  {
    code: "REPLICATED_TABLE_IMMUTABLE",
    when: "An UPDATE or DELETE ran against a replicated table.",
    then: "Write through window.dai.replicated.change or .remove instead (SHARED-WRITE-SURFACE).",
    shapes: SHARED,
    anchor: { file: "src/replicated.ts", contains: "RAISE(ABORT, 'REPLICATED_TABLE_IMMUTABLE')" },
  },
  {
    code: "NOT NULL constraint failed: t._r_replica",
    when: "A raw INSERT ran against a replicated table — by hand, from a kit control, or from a seed block. SQLite's own message, not a named refusal.",
    then: "Insert through window.dai.replicated.insert (SHARED-WRITE-SURFACE, SHARED-KIT-READS).",
    shapes: SHARED,
    anchor: { file: "src/replicated.ts", contains: "_r_replica    BLOB    NOT NULL" },
  },
  {
    code: "ROW_REJECTED",
    when:
      "The write rules refused a row. From an application, almost always an insert in a session document that did not name its session (\"… carries no session, but <table> declares the session profile\"); otherwise a raw UPDATE that tried to mark a superseded row current again.",
    then: "Pass the session as the third argument of insert (SESSION-ROW-CARRIES-SESSION), and never UPDATE a replicated table.",
    shapes: SHARED,
    anchor: { file: "src/replicated-rows.ts", contains: 'readonly code = "ROW_REJECTED";' },
  },
  {
    code: "WRITE_SURFACE_UNAVAILABLE",
    when: "A shared write ran without the host's write rules — usually a document opened straight in a browser.",
    then: "Tell the person to open the document in the DAI opener (SHARED-NEEDS-HOST).",
    shapes: SHARED,
    anchor: { file: "src/runtime/bootloader.ts", contains: 'error.name = "WRITE_SURFACE_UNAVAILABLE";' },
  },
  {
    code: "NO_DOCUMENT_OPEN",
    when: "A shared write ran before window.dai.openDatabase() resolved.",
    then: "Await openDatabase() before the first write.",
    shapes: SHARED,
    anchor: { file: "src/runtime/bootloader.ts", contains: 'throw new Error("NO_DOCUMENT_OPEN")' },
  },
  {
    code: "CLOSE_NOT_PERMITTED",
    when: "A non-creator called session.close under close=creator.",
    then: "Offer the close control only to the creator (SESSION-CLOSE).",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: 'throw new Error("CLOSE_NOT_PERMITTED")' },
  },
  {
    code: "ROLE_NOT_PERMITTED",
    when: "A copy wrote a table whose marker names the other party (author=creator or author=joiner), or wrote a role table with no session.",
    then: "Offer the table's controls only to the party its marker names, and pass the session on insert (SESSION-AUTHOR-ROLES).",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: "ROLE_NOT_PERMITTED (the creator wrote ${table}" },
  },
  {
    code: "NOT_SEAT_CREATOR",
    when: "Someone other than the session's creator called session.reseat.",
    then: "Offer the fresh-invite repair only to the creator (SESSION-CONTESTED-SEAT).",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: 'throw new Error("NOT_SEAT_CREATOR")' },
  },
  {
    code: "CANNOT_RESEAT",
    when: "session.reseat was called on a session with no contested seat.",
    then: "Offer the repair only when a seat is contested (SESSION-CONTESTED-SEAT).",
    shapes: SESSION,
    anchor: { file: "src/runtime/bootloader.ts", contains: 'throw new Error("CANNOT_RESEAT")' },
  },
  {
    code: "REPLICATION_SCHEMA_INVALID",
    when: "At build: a replicated table declared a PRIMARY KEY, AUTOINCREMENT or an _r_ column, or the session profile was malformed or had no replicated table.",
    then: "Fix schema.sql (SHARED-NO-KEY, SHARED-NO-R-COLUMNS, SESSION-PROFILE).",
    shapes: SHARED,
    anchor: { file: "src/replicated.ts", contains: 'readonly code = "REPLICATION_SCHEMA_INVALID";' },
  },
];
