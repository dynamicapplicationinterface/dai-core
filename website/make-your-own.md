---
title: Make your own
---

# Make your own

You do not need to know how to write code. You need an assistant to write it,
and somewhere to turn what it writes into a file. That is this page.

Nothing you paste here is uploaded. The whole thing is compiled in your
browser — there is no server behind this page: **we never see your app, and
neither does anyone else.**

<MakeYourOwn />

## If your file opens blank

Two things cause almost all of it:

- **The code tried to load something from the internet.** Fonts, an icon pack,
  a charting library. Inside a file there is no internet, so it never arrives.
  Ask your assistant to write it without.
- **It used `await` outside a `type="module"` script.** That stops the app
  before it draws anything.

The checks above catch both before you download. If something else goes wrong,
open the file, press <kbd>F12</kbd> and look at the Console tab — the error
there is usually literal about what is missing.

## When you outgrow this page

What this builds is unsigned, and whoever opens it will be told so plainly. That
is right for something personal: the file is whole, every part of it is
fingerprinted, and a host checks that before it runs anything. What it carries
no claim about is who made it.

A page cannot fix that. Signing needs a key you keep, and a web page has nowhere
to keep one — a key made for a single build and thrown away signs nothing anyone
can check, and would make your own next version look like somebody else's. So
when you publish something, and people need to know that *you* made it and not
somebody who altered it later, use a key of your own through the
[command line tool](/docs/quickstart).

Nothing changes about the file itself — the format is the same either way.
