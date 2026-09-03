---
title: The recipe
---

# What to tell an AI

An assistant writing an app for a DAI container needs to know three things it
would not otherwise assume: there is no network, storage goes through SQLite
inside the file, and top-level `await` needs a module script. Give it this and
it will produce something that works the first time.

If you use the [MCP server](/docs/making-files#with-an-assistant), you do not
need this page — the model receives these instructions with the tools, and the
server refuses code that would open blank. This is the same text, for anyone
working with an assistant that has no connection to it.

<Recipe />

## Why these rules exist

**No network.** The container declares its permitted connections as none, and
the browser enforces it. A CDN script does not load slowly — it never arrives,
and the app does nothing. Because that failure is silent, it lands on whoever
opened the file rather than on whoever built it.

**SQLite, not browser storage.** `localStorage` belongs to the browser, not to
the document. Data kept there stays on the machine that created it, so a file
sent to somebody else arrives empty — which defeats the point of a format whose
whole purpose is to travel.

**`type="module"` for top-level `await`.** Without it the script is a syntax
error and the page renders nothing at all. It is the single most common way an
otherwise correct app opens blank.

## A worked example

[`examples/tasks`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/tasks)
in the repository is a complete application built to these rules — projects,
priorities, tags, filtering and sorting, all in SQL, saved back into its own
file. It is the app the [walkthrough](/make-one) compiles.

```bash
npx dai build ./examples/tasks -n Tasks
```
