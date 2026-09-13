---
title: Your first app
---

# Your first app

A packing list for one trip, built from HTML and SQL with no JavaScript of its
own. By the end you will have a `.dai.html` file you can open, use, and send.
It is [`examples/packing-list`](https://github.com/dynamicapplicationinterface/dai-core/tree/main/examples/packing-list)
in the repository, so every file below is the real one.

## 1. Decide the shape

One family's list, kept on one phone. Nobody else adds to it and no second
copy's changes need keeping, so it is **solo**: ordinary tables, no sharing.
The decision goes at the top of the schema, where the next person to change
the application will read it.

<!--@include: ./parts/constraint/SHAPE-FIRST.md-->

## 2. Declare the tables

Every table is in `schema.sql`, and nowhere else.

<<< @/../examples/packing-list/schema.sql

<!--@include: ./parts/constraint/SCHEMA-FILE.md-->

## 3. Give it something to show

A first open should not be an empty shell. The seed rows are in a
`<script type="application/sql">` block in `index.html`, written so a second
open adds nothing — here, `INSERT OR IGNORE` with fixed ids.

<!--@include: ./parts/constraint/SEED-IDEMPOTENT.md-->

## 4. Draw it with the kit

`<dai-rows>` runs a query and repeats its template for each row;
`<dai-value>` shows one number; `<dai-form>` turns a form's fields into a
statement's parameters; a `data-run` attribute on a control runs a statement
when it is used. Every one of them redraws the page after a write.

::: details The whole index.html
<<< @/../examples/packing-list/index.html
:::

<!--@include: ./parts/constraint/KIT-FIRST.md-->

<!--@include: ./parts/constraint/NO-SAVE-BUTTON.md-->

## 5. Say what it is

The description and the three `dai:does` lines in the `<head>` are what a
person sees on the card before they open the file. `icon.svg` is its icon on a
home screen.

<!--@include: ./parts/constraint/DESCRIBE-ON-CARD.md-->

## 6. Check it, build it, open it

```bash
npx dai check ./examples/packing-list
npx dai build ./examples/packing-list -n "Beach trip"
```

`check` runs the same checks the MCP server and the website's paste page run —
the network, browser storage, and, for a shared application, the shared-table
constraints. Open the file it builds in the [DAI opener](https://opendai.app),
or double-click it.

## Next

A list two people add to is a different shape. [Choose a
shape](/docs/choose-a-shape) says which, and [Your first two-player
app](/docs/two-player-app) builds a session.
