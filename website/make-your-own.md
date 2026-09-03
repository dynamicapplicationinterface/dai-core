---
title: Make your own
---

# Make your own

You do not need to know how to write code. You need an assistant to write it,
and somewhere to turn what it writes into a file. That is this page.

Nothing you paste here is uploaded. The whole thing is compiled in your
browser — there is no server behind this page, which is the same reason the
file you get can be trusted: **we never see your app, and neither does anyone
else.**

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

This builds one HTML file with a key that is thrown away afterwards. That is
right for something personal, and not enough for something you publish, where
people need to know that *you* made it and not somebody who altered it later.
For that you want a signing key you keep, which means the
[command line tool](/docs/quickstart).

Nothing changes about the file itself — the format is the same either way.
