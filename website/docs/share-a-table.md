---
title: Share a table
---

# Share a table

For a table that more than one copy writes — a passable or session document.
Decide the shape first ([Choose a shape](/docs/choose-a-shape)); this page is
what follows once you know a table is shared. The worked example is the
receipts application in [Examples](/docs/examples#passable).

## Mark it, and take out what replication owns

Put `-- dai:replicated` directly above the table, and remove any PRIMARY KEY,
AUTOINCREMENT, UNIQUE and CHECK from it. Keep everything about one copy — a
setting, a draft, which item is showing — in ordinary local tables beside it.

<!--@include: ./parts/constraint/SHARED-MARKER.md-->

<!--@include: ./parts/constraint/SHARED-NO-KEY.md-->

<!--@include: ./parts/constraint/SHARED-NO-UNIQUE-CHECK.md-->

<!--@include: ./parts/constraint/SHARED-NO-TRAILING-COMMENT.md-->

<!--@include: ./parts/constraint/SHARED-LOCAL-STAYS-LOCAL.md-->

## Write through the write surface

<!--@include: ./parts/constraint/SHARED-WRITE-SURFACE.md-->

<!--@include: ./parts/constraint/SHARED-ENTITY-IDENTITY.md-->

<!--@include: ./parts/constraint/SHARED-KIT-READS.md-->

## Read from the view, and redraw when rows arrive

<!--@include: ./parts/constraint/SHARED-READ-CURRENT.md-->

<!--@include: ./parts/constraint/SHARED-REDRAW-ON-MERGE.md-->

## Store facts, derive the rest

<!--@include: ./parts/constraint/SHARED-NO-DERIVED-STATE.md-->

## Check it

```bash
npx dai check ./your-app
```

The lint refuses a raw write to a shared table, a read of the table itself, a
missing `dai:merged` listener, an application that edits shared rows and never
shows a conflict, and UNIQUE or CHECK on a shared table. Each finding names the
constraint it enforces.
