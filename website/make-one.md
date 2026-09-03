---
title: Make one with AI
---

# You asked an AI for a tool. Now what?

This is the part nobody explains.

An assistant will happily write you a working app in about thirty seconds.
Then you are holding a pile of code and a question no chatbot answers well:
*how do I actually use this?* Putting it online means servers, domains,
accounts and a database — weeks of work you did not sign up for, to run
something you wanted for yourself.

There is another answer. **It becomes a file.**

Like a spreadsheet: one document that holds the thing and everything in it.
You keep it in a folder. You open it by double-clicking. You email it to
somebody and they open it too. Nothing to install, nobody to sign up with,
no wifi required.

Watch it happen, then take one with you.

<MakerWalkthrough />

## What you just downloaded

One file, containing four things that normally live in four places:

- **The app** — the code from the conversation above
- **A database engine** — real SQLite, compiled into the file
- **Your data** — the tasks you add get written back into the same file
- **The runtime** — what makes it open in a browser with nothing installed

That is why it is bigger than a document and smaller than an app. There is
nothing else to download because there is nothing else.

## What it cannot do

It cannot make a request. Not "does not" — *cannot*. The file declares its
own network permissions as none, and the browser enforces that: no fetch, no
socket, no popup, no form that posts anywhere. Your tasks have no route out.
This is the property your IT department cares about, and the same one that
makes the file work on a plane.

Changing it is detectable. Every part is fingerprinted, so an altered file
fails its own check and a host that runs that check refuses to open it — which
every host here does, before anything inside it runs. You can
[try to break one yourself](/tamper-proof).

## The optional bit

Everything above works in a plain browser, which is the point. The
[desktop app](/docs/quickstart) adds three conveniences:

- `.dai` files get their own icon and open on double-click, like any other document
- Apps open in a clean window instead of a browser tab
- Saving back into the file happens in place, without a download prompt

Useful, not required. A file you make here works on a machine that has
never heard of any of this.
