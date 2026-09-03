---
title: The desktop app
---

# The desktop app

A DAI file already works with nothing installed — it opens in any browser.
This makes it feel like a document instead of a download.

<div class="shot">
  <img src="/shots/desktop-light.png" alt="The desktop app waiting for a document" />
</div>

<a class="dl" href="https://github.com/dynamicapplicationinterface/dai-core/releases">Download for Windows and macOS</a>

## What it adds

**Files become documents.** `.dai` gets its own icon and opens on double-click,
like a spreadsheet. Without it, the browser form works but a bare `.dai` asks
Windows what to open it with.

**A clean window.** No address bar, no tabs. It looks like an application
because it is one.

**Saving happens in place.** Press save and the file on disk is updated —
written to a temporary file and swapped in, so a crash mid-save cannot leave
you with half a document. In a browser tab, saving means downloading a new copy
and tidying up the old one yourself.

**It remembers who signed what.** The first time you open a document from
someone, it records their key. If a later file claims to be from them but was
signed by somebody else, it refuses and says so. Nothing to configure — it
just notices.

## It builds them too

<div class="shot">
  <img src="/shots/desktop-create.png" alt="The create dialog, with a folder dropped in" />
</div>

Drop in the folder or zip your assistant gave you and it compiles and signs on
your machine. **No terminal, no npm, no configuration file** — and nothing is
uploaded, because there is nothing to upload to.

It runs the same checks as everywhere else, so code that would open blank is
refused with the reason, rather than turned into a file that quietly does
nothing.

## What it does not change

The format. A file built here is the same file the command line builds, and
opens perfectly well on a machine that has never heard of this app. That
matters: if the desktop app disappeared tomorrow, every document made with it
would keep working.

## Building it yourself

It is a [Tauri](https://tauri.app) application, so you need Rust and Node:

```bash
cd apps/desktop
npm install
npm run tauri build
```

That produces an installer for the platform you build on. The
[source](https://github.com/dynamicapplicationinterface/dai-core/tree/main/apps/desktop)
is in the repository.
