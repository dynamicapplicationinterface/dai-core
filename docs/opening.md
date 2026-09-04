# Getting a document open

Every way a document reaches somebody, and what each one costs them.

A `.dai` file is an application and its data in one file. On a desktop it opens
by double-clicking, because a browser will run an HTML file off the filesystem.
On a phone it will not: a phone shows you a file, and has no way to run one. The
opener exists for that, and everything on this page is about the distance
between somebody having a document and somebody looking at it running.

That distance is the whole adoption problem. A tester's verdict on the original
route was that it does not flow, and counting the steps says why.

## The routes, worst to best

### Download, then find it, then pick it (5 steps)

Save the file. Leave the browser. Open the Files app. Find where it went. Open
the opener and pick it out of a chooser.

Everybody who ever did this was doing it because there was nothing better. It is
still what happens when somebody is *sent* a file — an email attachment, a
message — and it is why the opener's chooser has no `accept` filter: iOS greys
out anything a filter does not name, and a greyed-out file in a picker is a
person concluding the app is broken.

### A link (`?open=`) — 1 step

    https://opendai.app/?open=https://example.com/thing.dai

The opener fetches the address and runs what comes back. Any address it is
allowed to read works: Dropbox, S3, a GitHub raw URL, a company file share.
Sharing a document needs no infrastructure belonging to this project, which is
what keeps "the file needs no server" true.

The one requirement is that the host permits cross-origin reads. A server that
does not fails identically to one that is unreachable — the browser reports
neither — so the opener says so explicitly rather than letting somebody conclude
the whole thing is broken.

This is the right route for any document that already lives at a URL.

### Handed over between tabs — 1 step, and no file at all

A page that has just *built* a document has the bytes in memory. It opens the
opener in a new tab and posts them across: no download, no upload, no server,
nothing on the network. One tap and somebody is in their app.

`src/handoff-tab.ts` is both halves of that handshake, in one file, because two
copies of a handshake drift and the failure is silent — a tab that opens, waits,
and shows a chooser, with nothing anywhere saying why.

The opener accepts a handed-over document only from origins it is willing to.
Not because such a document is dangerous — everything is verified and sandboxed
on the way in regardless of how it arrived — but because without a check, any
page on the web could open the opener and put a document in front of somebody
who believes they arrived there themselves.

The sender never gets to say what the document *is*. It supplies a label; the
bytes are read and verified exactly as a chosen file is.

### Already on the home screen — 0 steps

Once a document is running, the opener offers, once, to be added to the home
screen. Android and desktop Chrome get a button; iOS gets the gesture spelled
out, because iOS has no install event and never will.

Each document kept is its own app, with its own id and a launch address that
opens that document, so three documents kept are three icons.

On Android and desktop Chrome the installed app shares the opener's storage,
and the document is simply there. **On iOS it is not.** A home-screen app on
iOS gets storage of its own, separate from Safari, so the new icon launches an
opener that has never seen the document. The honest instruction there is three
steps — save a copy to Files, add to Home Screen, open the file once from the
new icon — and the opener says exactly that. The launch address carries the
document's name, so a new icon with nothing in its library asks for that file
by name instead of showing an empty chooser. After that one open, it stays.

## What did not change

Verification. A document is read, its signature checked, and its publisher
compared against what this device remembers, before anything runs — on every one
of these routes. Where bytes arrived from says nothing about what they are, and
none of these routes is a shortcut past that.
