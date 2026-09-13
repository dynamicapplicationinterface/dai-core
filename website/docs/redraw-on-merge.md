---
title: Redraw when rows arrive
---

# Redraw when rows arrive

A shared document changes under the application when the other copy's rows
arrive — from a file or link somebody opened, or in the background. The
application finds out from one event, and nowhere else.

<!--@include: ./parts/constraint/SHARED-REDRAW-ON-MERGE.md-->

## Carrier or mailbox

`event.detail.via` says where the rows came from. `"carrier"` means a person
opened a file or a link — a deliberate act, and in a session document the one
moment to take an open seat. `"mailbox"` means rows arrived in the background,
and must never make a copy join anything.

<!--@include: ./parts/constraint/SESSION-JOIN-ON-OPEN.md-->

## With the kit

The kit's `<dai-rows>` and `<dai-value>` redraw after the kit's own writes, not
after a merge. Call `window.daiKit.refresh()` from the listener.

<!--@include: ./parts/constraint/SHARED-KIT-READS.md-->
