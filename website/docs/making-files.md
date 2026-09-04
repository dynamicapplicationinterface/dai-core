---
title: Making files
---

# Five ways to make one

Every one of them runs the same compiler. A container built by an assistant,
by the command line or by the website is byte-for-byte the same kind of
file — there is no "lite" version.

| | Who it suits | Needs installing |
|---|---|---|
| [Desktop app](/desktop) | Anyone who never opens a terminal | The app, once |
| [Website](/make-your-own) | Trying it out, no setup at all | Nothing |
| [Assistant (MCP)](#with-an-assistant) | Anyone who can describe what they want | Node, once |
| [Command line](#from-the-command-line) | Scripts, CI, repeatable builds | Node |
| [Vite plugin](#from-a-vite-project) | React, Vue, Svelte — anything with a build | Already have it |

## With an assistant

The shortest path for someone who does not write code. You describe the tool
you want; the assistant writes it **and produces the file**. No copying, no
pasting, no download page.

```bash
npx -y dai-core dai-mcp --root .
```

Add it to your MCP client's configuration — for Claude Desktop, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dai": {
      "command": "npx",
      "args": ["-y", "dai-core", "dai-mcp", "--root", "/path/to/your/folder"]
    }
  }
}
```

`--root` is a boundary, not a default. The server will not read or write
outside it, whatever it is asked to do — the arguments arrive from a model
acting on a conversation, and an unconstrained output path is an arbitrary
file write on your machine.

Then just ask:

> Build me a workout log I can keep on my laptop, and make it a DAI file.

### The tools it offers

| Tool | What it does |
|---|---|
| `create_dai_app` | Compiles files into a container and writes it |
| `check_dai_app` | Reports what would break, before building |
| `verify_dai_app` | Checks an existing file for tampering |

The descriptions carry the constraints — no network, storage through
`window.dai`, `type="module"` for top-level `await` — so the model writes
suitable code without being told separately. `create_dai_app` **refuses**
code that would open blank rather than writing a broken file, and returns
what to fix, so the model can correct itself and retry.

## From the command line

```bash
npx dai build ./dist
```

That writes `<name>.dai.html` beside you. It works in a bare folder of HTML —
the SQLite engine comes from the tool's own installation, so you do not need a
project.

```bash
dai build ./dist -o tasks.dai.html -n "My Tasks" -k signing-key.pem
dai verify tasks.dai.html
```

| Option | |
|---|---|
| `-o, --out` | Where to write it |
| `--dai` | Write the binary form instead of the HTML one |
| `-n, --name` | Window title, and the default file name |
| `-k, --key` | Sign with a PKCS#8 PEM private key |
| `--seed` | Start from an existing SQLite database |
| `--uuid` | Reuse a document identity instead of minting one |
| `--valid-until` | Unix seconds after which hosts should refuse it |
| `--quiet` | Print only the path, for scripting |

`verify` exits `0` when a container is intact and `1` when it is not, so a
pipeline can branch on it. It takes either form.

## Two forms of the same file

`dai build` writes `.dai.html` by default: a single HTML document that opens in
any browser with nothing installed. That is what makes this demonstrable, and
it is what the pages here hand you.

`--dai` writes the binary form instead. Same application, same signature — it
is a second encoding of one build, not a second build. Two reasons to prefer
it:

**Mail systems pass it.** Many gateways quarantine `.html` attachments
outright, which is awkward for a file whose point is that you can send it to
somebody.

**Saving does not rewrite it.** The HTML form rebuilds the whole document on
every save, which starts to stall around twenty megabytes. In the binary form
the database is its own section, so a save replaces that and leaves everything
else untouched — including the manifest, which means **a signed document stays
signed after somebody saves it, without anyone holding the key**.

```bash
dai build ./dist --dai -o my-app.dai
dai verify my-app.dai
```

The trade is that a `.dai` needs something that knows how to open it — the
[desktop app](/desktop), or the runner. A `.dai.html` needs nothing at all.

## From a Vite project

For anything with a build step — React, Vue, Svelte:

```ts
import { defineConfig } from 'vite';
import dai from 'dai-core';

export default defineConfig({
  plugins: [dai({ appName: 'My Tasks' })],
});
```

`vite build` then emits the container alongside the usual output.

## What every route enforces

A container has no network access, and that is not advice — the browser
enforces it. Code that reaches for a CDN, a hosted font or an API will fail
**silently**, leaving a blank or half-drawn app in front of whoever opened
the file, far from the line that caused it.

So all four routes check first, against one shared list:

- Scripts, stylesheets, fonts or images loaded by URL
- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
- `localStorage`, `sessionStorage`, `indexedDB` — browser storage does not
  travel with the file, so a document sent to somebody arrives empty
- Top-level `await` in a script that is not `type="module"`, which is a syntax
  error and opens a blank page

Store data with `window.dai.openDatabase()` instead, and it lives inside the
file.

## One compiler

All four are wrappers. The format is implemented once, in `buildContainer`,
and reached through one of two doors: `compile.ts` for anything with a
filesystem, `browser.ts` for anything in a page. A test fails the build if a
wrapper starts zipping, hashing or signing on its own — which it caught
within hours of being written.

## Checking source before you build it

```bash
dai check ./app          # or --json
```

Answers the question that comes before "is this container intact": will this
code work once it is inside one. A container has no network, no browser storage
and no inline event handlers, and every one of those fails *silently* — a button
that does nothing, a fetch that never returns, data that arrives empty at the
other end. This says so while it is still cheap to change.

Exit 0 when the source will work, 1 when it will not. `--json` reports each
finding with the rule it broke and what to do instead, which is the form an
assistant writing the code can act on.

## Checking one from a script

```bash
dai verify tasks.dai.html --json
```

The whole audit as data: which entries matched, whether the shell is the sealed
one, what the signature says, and — for the sectioned form — the section table
and footer. The exit code is unchanged, 0 for intact and 1 for refused, so a
pipeline can branch on the code and a report can read the reasons.

It exists because the alternative is parsing sentences written for a person, and
those sentences change. One of them changed this week, when a damaged database
stopped being reported as tampering.
