---
title: Writing apps
---

# Writing an app that runs in a container

This is the reference for the code *inside* a `.dai` file — the application
itself, not the tooling that builds one and not the host that opens it. If you
are building a host, you want the [host bridge](/docs/host-bridge) instead.

An assistant writing one of these should be given
[the recipe](/docs/the-recipe), which is the same text the MCP server hands a
model. This page is that recipe's reasoning, for a person who wants to know why
the rules are what they are before following them.

**For an AI:** the plain-text sources are at
[`/recipe.txt`](/recipe.txt) and [`/llms.txt`](/llms.txt). Fetch those rather
than scraping this page.

## The surface

Everything an application is given, and nothing else.

<AppSurface />

## What an application cannot do

The list is short and it is the point of the format, not a set of gaps waiting
to be filled.

**It cannot reach the network.** The container declares its permitted
connections as none and the browser enforces it. There is no fetch, no CDN, no
telemetry, no update check. A script tag pointing at a CDN does not load slowly
— it never arrives, and because that failure is silent it lands on whoever
opened the file rather than on whoever built it. Everything the app needs ships
inside the file.

**It cannot see the device, other tabs, or other documents.** It runs in a
frame with no origin of its own. `localStorage` is not shared with anything and
should not be used at all: data kept there belongs to the browser rather than
to the document, so a file sent to somebody else arrives empty, which defeats
the point of a format whose purpose is to travel.

**It cannot create a second document.** See [one document](#one-document).

**It cannot share, install, or save on its own initiative.** It can *ask* — see
[sharing](#sharing) — and the person decides.

## Storage

All state goes in the SQLite database inside the file. Declare every table in
`schema.sql` with `IF NOT EXISTS`; the compiler seals a digest of the
normalised schema, and a host reconciles it before handing over a database
handle, so an application that cannot account for the data it is opening does
not get to write over it.

Under a host, `window.dai.autosaves` is true and every write is saved as it
happens. There is no Save button to build and no dirty flag to track. Opened as
a plain file with no host, saving is a deliberate act and
`window.dai.saveDatabase(db)` is the only way to do it — which is why the kit's
own `<dai-save>` shows itself in that case and hides itself under a host.

## One document {#one-document}

A DAI document is one sealed file with one database. Nothing spawns a second
one from inside a running application, and no call in the surface above
creates, forks, or duplicates a document.

So a "New Game", a new match, a new save slot, a second list — anything a
person might call "a new one" — is a row in your own schema, not a new file:

```sql
CREATE TABLE IF NOT EXISTS games (
  id        INTEGER PRIMARY KEY,
  started   TEXT NOT NULL,
  state     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

"New Game" inserts a row into `games` and writes its id to the `app` row that
records which game is showing. The UI reads that id to decide what to draw.
Every game the person has played is still in the file, which is what makes the
file worth keeping and worth sending.

## Sharing {#sharing}

`window.dai.requestShare()` opens the host's own share sheet — the same one
behind the host's menu. It is not a way to share. It is a way to ask the host
to offer to.

The host builds the link, shows the card with the name and icon from the sealed
manifest, asks whether to include the person's data, and waits for them to press
Send. The request carries nothing of the application's choosing: no data, no
recipient, no answer to the data question. What it saves is the two taps it
takes to find the menu.

Put a Share button wherever it belongs in your own interface and wire it to
that call. Do not build a substitute share flow with the browser's own share
API and present it as this one — it would not carry the card, the link, or the
choice, and the person would have no way to tell the difference until it
mattered.

## The screen

The application gets the whole screen, under the status bar and past the home
indicator, the way a phone's own apps do. Nothing is reserved for the host
except one round menu button floating in the top right corner, so keep anything
tappable out of that corner.

Safe-area insets read as zero inside a frame, always, so an application cannot
measure them for itself. The host measures them and sets the four custom
properties listed above on your root element. The rule is: **the background
fills those strips, the content is pushed clear of them.**

```css
body { background: #faf7ef; }                                   /* to the edge */
header { padding-top: calc(16px + var(--dai-safe-top, 0px)); }  /* content clear */
.bottom-bar { padding-bottom: calc(12px + var(--dai-safe-bottom, 0px)); }
```

Build one layout, not two. A file is sent as a link and the person who opens it
is on whatever they are on — a phone in a message, a tablet, a desktop browser
— and the sender does not choose. One column that holds from about 320px to a
wide desktop window, tap targets no smaller than 44px, no fixed pixel widths on
anything holding content. Check it at 390 and again at 1280.

## Telling a person what it is

Two things in the `<head>` are read by the host and shown before anybody opens
the file, on the screen where they decide whether to trust it:

```html
<meta name="description" content="Who does what this week, and a star when it is done">
<meta name="dai:does" content="Give each person their jobs for the week">
<meta name="dai:does" content="Tap a job to star it the moment it is done">
<meta name="dai:does" content="Starts the week over on Monday with the stars cleared">
<meta name="theme-color" content="#f4f8f4">
```

The description is one line under the name. The three `dai:does` lines are what
the app says it does, and they are most of that screen — write the three things
that would make somebody want to open it, not the technology. Three or none:
two is a page with a gap in it.

`theme-color` is the colour a phone paints the status bar above your app. If
you declare none the host measures the top edge of what you painted and uses
that, which usually works and is not as good as saying.

## A worked example

[`examples/tasks`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/tasks)
is a complete application built to these rules — projects, priorities, tags,
filtering and sorting, all in SQL, saved back into its own file. The three
smaller ones beside it (`chore-chart`, `meal-plan`, `packing-list`) are shorter
reads and show the screen rules above in place.
