import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleMessage, TOOLS, DEFAULT_PROTOCOL_VERSION } from "../src/mcp.js";
import { lintSource } from "../src/lint.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const APP = [
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

const workspace = (): string => mkdtempSync(resolve(tmpdir(), "dai-mcp-"));

async function call(root: string, name: string, args: Record<string, unknown>) {
  const response = await handleMessage(
    { root },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  );
  const result = response?.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]?.text ?? "", isError: result.isError === true };
}

test.describe("protocol", () => {
  test("initialize echoes the client's version and announces tools", async () => {
    const response = await handleMessage(
      { root: workspace() },
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      },
    );

    const result = response?.result as Record<string, unknown>;
    // Echoed rather than asserted, so a newer client is not refused over a
    // version this server has no opinion about.
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
  });

  test("falls back to its own version when the client names none", async () => {
    const response = await handleMessage(
      { root: workspace() },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    );
    expect((response?.result as Record<string, unknown>).protocolVersion).toBe(
      DEFAULT_PROTOCOL_VERSION,
    );
  });

  test("notifications get no reply", async () => {
    // A response to a notification is a protocol violation, and clients differ
    // in how loudly they complain about it.
    const response = await handleMessage(
      { root: workspace() },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    );
    expect(response).toBeNull();
  });

  test("an unknown method is a JSON-RPC error, not a crash", async () => {
    const response = await handleMessage(
      { root: workspace() },
      { jsonrpc: "2.0", id: 7, method: "resources/list" },
    );
    expect(response?.error?.code).toBe(-32601);
    expect(response?.id).toBe(7);
  });

  test("every tool declares a schema a client can render", async () => {
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  test("the tool descriptions teach the constraints a model must know", () => {
    // These descriptions are the only place a model learns why its usual habits
    // will not work here. If they stop saying so, the server starts producing
    // blank apps and nobody finds out until a person opens one.
    const create = TOOLS.find((tool) => tool.name === "create_dai_app");
    expect(create?.description).toMatch(/no network/i);
    expect(create?.description).toMatch(/window\.dai\.openDatabase/);
    expect(create?.description).toMatch(/type="module"/);
    expect(create?.description).toMatch(/localStorage/);
  });
});

test.describe("create_dai_app", () => {
  test("writes a container that actually runs", async ({ page }) => {
    const root = workspace();
    const result = await call(root, "create_dai_app", {
      files: { "index.html": APP },
      appName: "Notes",
      outputPath: "notes.dai.html",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("sqlite3 + glue embedded");

    const file = resolve(root, "notes.dai.html");
    expect(existsSync(file)).toBe(true);

    await page.goto(pathToFileURL(file).href);
    const app = page.frameLocator("iframe");
    // The heading is static HTML and appears even when the application never
    // ran, so waiting on it proves nothing. The row cannot exist until SQLite
    // has booted — which on a cold runner takes longer than the default five
    // seconds, and showed up as a flake on Firefox.
    await expect(app.locator("h1")).toHaveText("Notes", { timeout: 20_000 });
    await app.locator("#b").fill("Ring the dentist");
    await app.locator("#b").press("Enter");
    await expect(app.locator("li")).toHaveText("Ring the dentist", { timeout: 20_000 });
  });

  test("tells the model what to say to the person who asked", async () => {
    const result = await call(workspace(), "create_dai_app", {
      files: { "index.html": APP },
      appName: "Notes",
    });
    // The model is the only thing that will explain this file to its owner.
    expect(result.text).toMatch(/double-click/i);
    expect(result.text).toMatch(/offline|works offline/i);
  });

  test("refuses code that would open blank, instead of writing it", async () => {
    const root = workspace();
    const result = await call(root, "create_dai_app", {
      files: { "index.html": "<html><body><script>const x = await f();</script></body></html>" },
      appName: "Broken",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/type="module"/);
    // Nothing written: the model can fix it and try again, and no half-working
    // file is left behind for somebody to find.
    //
    // The name is capitalised because that is what the compiler produces from
    // an appName of "Broken". Asserting the lower-case spelling made this pass
    // on a case-insensitive filesystem and pass *vacuously* on a case-sensitive
    // one, where it could not have failed however wrong the code was.
    expect(existsSync(resolve(root, "Broken.dai.html"))).toBe(false);
  });

  test("refuses a CDN script, which would never arrive", async () => {
    const result = await call(workspace(), "create_dai_app", {
      files: {
        "index.html": '<html><body><script src="https://cdn.tailwindcss.com"></script></body></html>',
      },
      appName: "Styled",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/CDN|internet/i);
  });

  test("warns without refusing when the problem only degrades the app", async () => {
    const root = workspace();
    const result = await call(root, "create_dai_app", {
      files: { "index.html": APP.replace("<h1>Notes</h1>", '<h1>Notes</h1><img src="https://x/y.png">') },
      appName: "Notes",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/Worth fixing/);
    // No outputPath was given, so the name comes from the appName as the
    // compiler sanitises it — "Notes", with its capital intact.
    expect(existsSync(resolve(root, "Notes.dai.html"))).toBe(true);
  });

  test("needs an entry point", async () => {
    const result = await call(workspace(), "create_dai_app", {
      files: { "main.html": APP },
      appName: "Notes",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/index\.html/);
  });
});

test.describe("the boundary", () => {
  // The arguments reach this server from a model acting on a conversation, so
  // an unconstrained outputPath is an arbitrary file write on someone's machine.
  test("refuses to write outside its root", async () => {
    const root = workspace();
    const result = await call(root, "create_dai_app", {
      files: { "index.html": APP },
      appName: "Escape",
      outputPath: "../escaped.dai.html",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/outside/i);
    expect(existsSync(resolve(root, "../escaped.dai.html"))).toBe(false);
  });

  test("refuses to read a key outside its root", async () => {
    const result = await call(workspace(), "create_dai_app", {
      files: { "index.html": APP },
      appName: "Notes",
      signingKeyPath: "../../id_rsa",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/outside/i);
  });

  test("refuses to verify a file outside its root", async () => {
    const result = await call(workspace(), "verify_dai_app", { path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/outside/i);
  });
});

test.describe("verify_dai_app", () => {
  test("passes an intact container and fails an altered one", async () => {
    const root = workspace();
    await call(root, "create_dai_app", {
      files: { "index.html": APP },
      appName: "Notes",
      outputPath: "notes.dai.html",
    });

    const intact = await call(root, "verify_dai_app", { path: "notes.dai.html" });
    expect(intact.isError).toBe(false);
    expect(intact.text).toContain("Intact");

    const file = resolve(root, "notes.dai.html");
    const html = readFileSync(file, "utf8");
    const at = html.indexOf('id="dai-payload"') + 200;
    writeFileSync(file, html.slice(0, at) + (html[at] === "A" ? "B" : "A") + html.slice(at + 1));

    const altered = await call(root, "verify_dai_app", { path: "notes.dai.html" });
    expect(altered.isError).toBe(true);
    expect(altered.text).toMatch(/altered/i);
  });
});

test.describe("check_dai_app", () => {
  test("reports the same findings the website shows", async () => {
    const source = '<html><body><script src="https://cdn.example/x.js"></script></body></html>';

    const result = await call(workspace(), "check_dai_app", { files: { "index.html": source } });
    const direct = lintSource(source);

    // One definition of what breaks, or a model is told its code is fine by one
    // tool and unusable by another.
    expect(direct).toHaveLength(1);
    expect(result.text).toContain(direct[0]?.what ?? "");
  });

  test("says so plainly when there is nothing wrong", async () => {
    const result = await call(workspace(), "check_dai_app", { files: { "index.html": APP } });
    expect(result.text).toMatch(/Nothing here will break/);
  });
});

test("speaks the protocol over stdio, as a client would launch it", async () => {
  const root = workspace();
  const server = spawn(process.execPath, [resolve(repo, "dist/mcp-bin.js"), "--root", root]);

  const replies: Record<string, unknown>[] = [];
  let buffer = "";
  server.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (const line of buffer.split("\n").slice(0, -1)) {
      if (line.trim()) replies.push(JSON.parse(line) as Record<string, unknown>);
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });

  server.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
  );
  // A notification, which must not produce a reply and so must not shift the
  // indices of anything after it.
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

  await expect.poll(() => replies.length, { timeout: 15_000 }).toBe(2);
  server.kill();

  expect(replies[0]?.id).toBe(1);
  expect(replies[1]?.id).toBe(2);
  const tools = (replies[1]?.result as { tools: { name: string }[] }).tools;
  expect(tools.map((tool) => tool.name)).toContain("create_dai_app");
});

test.describe("rebuilding an app that already exists", () => {
  /*
   * The gate that stops a version two destroying a version one. A model
   * rebuilding an app is the exact case it exists for, and until the tool
   * could be told which file it was rebuilding, the gate never ran for one.
   */
  const v1 = {
    "index.html": '<!doctype html><script type="module" src="./dai-kit.js"></script>',
    "schema.sql": "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);",
  };

  test("a changed schema with no migration is refused, and says what to write", async () => {
    const root = workspace();
    const first = await call(root, "create_dai_app", { files: v1, appName: "Notes", outputPath: "notes.dai.html" });
    expect(first.isError).toBe(false);

    const second = await call(root, "create_dai_app", {
      files: { ...v1, "schema.sql": "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, priority INTEGER);" },
      appName: "Notes",
      outputPath: "notes.dai.html",
      upgradeOf: "notes.dai.html",
    });
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/migration/i);
  });

  test("the same change with a migration is accepted", async () => {
    const root = workspace();
    await call(root, "create_dai_app", { files: v1, appName: "Notes", outputPath: "notes.dai.html" });
    const second = await call(root, "create_dai_app", {
      files: {
        ...v1,
        "schema.sql": "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, priority INTEGER);",
        "migrations/002-priority.sql": "ALTER TABLE notes ADD COLUMN priority INTEGER;",
      },
      appName: "Notes",
      outputPath: "notes-v2.dai.html",
      upgradeOf: "notes.dai.html",
    });
    expect(second.isError).toBe(false);
  });

  test("the tool tells the model to pass the previous file", () => {
    const create = TOOLS.find((tool) => tool.name === "create_dai_app")!;
    const schema = create.inputSchema as { properties: Record<string, { description: string }> };
    expect(schema.properties.upgradeOf?.description).toMatch(/previous file|already exists/i);
  });
});
