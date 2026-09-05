import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildContainer } from "../src/core.js";
import { breaking, lintSource } from "../src/lint.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The checks the paste page runs, called directly.
 *
 * These used to be scraped out of the component, because that was where they
 * lived and a second copy would have drifted from it. They now live in
 * src/lint.ts and are shared with the command line and the MCP server, so the
 * tests can simply call them — and `one-engine.spec.ts` is what keeps the
 * component from growing its own set again.
 */
// Flagged means it will not work; a warning is advice, not a flag.
const flags = (source: string): boolean => breaking(lintSource(source)).length > 0;

test.describe("what the paste page warns about", () => {
  // Each of these works on an ordinary web page and fails silently inside a
  // container, which is the only reason to interrupt somebody with a warning.
  const rejected: Record<string, string> = {
    "a CDN script": '<script src="https://cdn.tailwindcss.com"></script>',
    "a hosted stylesheet": '<link rel="stylesheet" href="https://fonts.googleapis.com/css2">',
    "a hosted font": '<link href="https://fonts.gstatic.com/x.woff2" rel="preload">',
    "an API call": "const r = await fetch('/api/notes');",
    "a websocket": "const s = new WebSocket('wss://example.com');",
    "a beacon": "navigator.sendBeacon('/t', data);",
    "browser storage": "localStorage.setItem('notes', JSON.stringify(notes));",
    "a hosted image": '<img src="https://example.com/logo.png">',
    // The channels connect-src does not govern. A native host can switch these
    // off at the webview layer; a browser cannot, so the compiler refuses to
    // seal them.
    "a preconnect": '<link rel="preconnect" href="https://fonts.gstatic.com">',
    "a DNS prefetch": '<link rel=dns-prefetch href="//cdn.example.com">',
    "a prerender": '<link rel="prerender" href="/next.html">',
    "a meta refresh": '<meta http-equiv="refresh" content="0; url=/next">',
    "a link that opens a tab": '<a href="/docs" target="_blank">docs</a>',
    "window.open": 'button.onclick = () => window.open("https://example.com");',
    // Removing 'unsafe-inline' made these stop working, and they fail in the
    // worst way available: the control is there, it is pressed, and nothing
    // happens. Models emit them constantly.
    "an onclick attribute": '<button onclick="save()">Save</button>',
    "an onsubmit attribute": '<form onsubmit="return false"><input></form>',
    "an onerror attribute": '<img src="x" onerror="boom()">',
  };

  for (const [what, source] of Object.entries(rejected)) {
    test(`warns about ${what}`, () => {
      expect(flags(source)).toBe(true);
    });
  }

  // False positives are expensive here: the audience cannot tell a spurious
  // warning from a real one, so anything flagged has to actually be broken.
  const accepted: Record<string, string> = {
    "inline styles": "<style>body { font-family: system-ui; }</style>",
    "a relative script": '<script type="module" src="./app.js"></script>',
    "an inline SVG": '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
    "a data URI image": '<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">',
    "the database API": "const db = await window.dai.openDatabase();",
    "the word fetching in prose": "<p>Fetching is not allowed here.</p>",
    // The same word in places that are not an attribute, which must not be
    // mistaken for one.
    "a handler attached in script": '<script>b.addEventListener("click", go);</script>',
    "a handler assigned as a property": "<script>el.onclick = go;</script>",
    "a comparison before an assignment": "<script>if (a<b) { el.onclick = x; }</script>",
    "the word onclick in prose": "<p>Avoid onclick = handlers.</p>",
    // A container preloading its own font is doing something legitimate, and a
    // rule that also catches correct code teaches people to ignore the rules.
    "preloading its own font": '<link rel="preload" as="font" href="./inter.woff2" crossorigin>',
    "a stylesheet of its own": '<link rel="stylesheet" href="./app.css">',
    "an ordinary link": '<a href="/docs">docs</a>',
    "the word prefetch in prose": "<p>Prefetch hints do not work in a container.</p>",
  };

  for (const [what, source] of Object.entries(accepted)) {
    test(`stays quiet about ${what}`, () => {
      expect(flags(source)).toBe(false);
    });
  }
});

/**
 * The page tells visitors a single pasted HTML file becomes a working app.
 * This builds one the way the page does and opens it, so that claim cannot
 * quietly stop being true.
 */
test("a single pasted file becomes an app that runs", async ({ page }) => {
  const pasted = [
    "<!doctype html>",
    '<html><head><meta charset="UTF-8"><title>Notes</title></head>',
    '<body><h1>Notes</h1><form id="f"><input id="b" required></form><ul id="l"></ul>',
    '<script type="module">',
    "const db = await window.dai.openDatabase();",
    'db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");',
    "function draw() {",
    "  l.innerHTML = '';",
    '  for (const row of db.selectObjects("SELECT * FROM notes ORDER BY id")) {',
    "    const li = document.createElement('li');",
    "    li.textContent = row.body;",
    "    l.appendChild(li);",
    "  }",
    "}",
    "f.onsubmit = (e) => {",
    "  e.preventDefault();",
    '  db.exec({ sql: "INSERT INTO notes (body) VALUES (?)", bind: [b.value] });',
    "  b.value = '';",
    "  draw();",
    "};",
    "draw();",
    "</script></body></html>",
  ].join("\n");

  expect(flags(pasted)).toBe(false);

  const built = await buildContainer({
    files: { "index.html": new TextEncoder().encode(pasted) },
    template: readFileSync(resolve(repo, "dist/template.html"), "utf8"),
    runtime: readFileSync(resolve(repo, "dist/dai-runtime.js"), "utf8"),
    appName: "Notes",
    wasm: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm")),
    glue: readFileSync(resolve(repo, "node_modules/@sqlite.org/sqlite-wasm/dist/index.mjs")),
  });

  const file = resolve(mkdtempSync(resolve(tmpdir(), "dai-paste-")), "notes.dai.html");
  writeFileSync(file, built.html);

  await page.goto(pathToFileURL(file).href);
  const app = page.frameLocator("iframe");

  await expect(app.locator("h1")).toHaveText("Notes", { timeout: 20_000 });
  await app.locator("#b").fill("Ring the dentist");
  await app.locator("#b").press("Enter");
  await expect(app.locator("li")).toHaveText("Ring the dentist");
});
