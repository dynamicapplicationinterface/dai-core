---
title: Someone sent you a .dai file
---

# You have a file your computer doesn't recognise

Nothing is wrong with it. A `.dai` file is a document that contains its own
application — the thing you use it with is *inside* it — so your computer has
nothing to open it with until you give it something.

Here is how, on whatever you are holding.

## On a phone

Go to **[the opener](https://run.dynamicapplicationinterface.io)** and choose
your file. That is the whole thing: a page, nothing to install, and the file
never leaves your device.

Add it to your home screen and it behaves like an app, reopening whatever you
had open last.

## On a computer

Two ways, and the first needs nothing.

**Ask for it as a `.dai.html` instead.** Whoever sent it can save it in the
other form, which opens by double-click in any browser with nothing installed.
Same document, same data, larger file.

**Or install [the desktop app](/desktop).** It makes `.dai` files behave like
documents — their own icon, double-click to open, saved back into the same file
rather than downloaded as a copy.

## What it actually is

One file holding four things that normally live in four places: an application,
a real SQLite database engine, the data, and a record of what it all should be
so that changes are detectable.

It cannot make a network request. Not "does not" — the browser is instructed to
refuse them and does, which is why a file like this is safe to open from an
email in a way that an attachment usually is not.

There is [more about that](/tamper-proof), including what it does *not* protect
you from, which is the part worth reading if you are deciding whether to trust
one.

## Should you open it at all?

The same question as any attachment, with one difference: this one cannot call
anywhere, so it cannot report that you opened it or send anything out. What it
can still do is show you things — including a convincing form asking for a
password, which no format prevents.

Open files from people you know. If you want to look before you leap, the
[playground](/playground) will read one and tell you what is inside it without
running it.
