---
title: See it break
---

# See it break

A signed cartridge is only worth something if altering it is noticed. This page
does not describe that happening — it lets you do it.

Everything below is computed in your browser from a real cartridge: the digests
are SHA-256 of the actual entries, and the verdict comes from `auditContainer`,
the same function a desktop host runs before it will mount anything.

<TamperProof />

## Try it against a host

The two files below came from a single compile, so the only difference between
them is the tampering — not a timestamp, not an identifier.

<ul>
  <li><a href="/sample-intact.dai" download>sample-intact.dai</a> — verifies</li>
  <li>
    <a href="/sample-tampered.dai" download>sample-tampered.dai</a> — one entry
    replaced, every other byte identical
  </li>
</ul>

Open the second in the desktop host and it refuses before anything runs. Drop
either into the [playground](/playground) for the full report.

## What this stops, and what it does not

Worth stating plainly, because a page that only lists strengths is not one a
security team can use.

**Enforced by the browser.** A container declares `connect-src 'none'`, so
requests, sockets and beacons are refused by the engine rather than by our code.
It runs in a frame with no origin of its own and no permission to open windows,
navigate the page, or download — so the usual ways of moving data out are closed
too. Scripts run only if the compiler sealed them: content stored in the
database cannot become code.

An app built entirely from the kit gets one more turn of the screw. It is sealed
with Trusted Types, which makes the handful of browser calls that turn a string
into markup refuse a plain string outright — so even a mistake in the app cannot
render a stored value as HTML. An app with JavaScript of its own is left as it
is and told where those calls are, because switching it on under code that uses
them would break the app rather than protect it.

**Detected, not prevented.** Alteration. Every entry is fingerprinted, and the
signature covers that list of fingerprints along with the document's name, icon
and identity — so a changed file fails its own check, and every host here
refuses on that basis before anything runs.

What that proves is that the file has not changed since it was signed, *not* who
signed it: a container carries its own key, so somebody who alters one can
re-sign it with a key of their own. Recognising a publisher needs something from
outside the file, and there are three of those, in order of how much they
actually establish.

**What your device remembers.** It records the key each publisher signs with,
not just each document. So the second app from someone you have opened before
says so — "you've opened 3 of their apps" — and a stranger using a key you have
never seen is simply new, with a short number you can read back to them over a
call to check you have the same one. You can give a publisher a name of your
own, which stays on your device and is shown ahead of anything the file claims.

**A name that collides with one you know.** If a document arrives under a name
your device already knows, signed by a different key, it goes red and says treat
it as a stranger. That includes names spelled to look identical — a Cyrillic
letter inside a Latin word, a full-width variant — because the comparison is
done on the Unicode confusable skeleton rather than on the characters.

**Somebody else vouching.** A publisher who signs in with GitHub or Google at
build time can attach a Sigstore proof binding that identity to their key. Your
device checks it offline, against roots it already holds, and never fetches
anything; if it holds no root for that proof, it says nothing rather than
guessing. Where it does, the card reads *signed in as* — not "verified", which
would be a claim about the world this software cannot make.

What none of this fixes is the first document from a publisher nobody has
vouched for. It is new, and it says new.

**Not signed at all.** A container built on this website is unsigned, and says
so on the card. A page has nowhere to keep a key, and one minted for a single
build and discarded signs nothing anybody can check — worse, it would make your
own next version look like an impersonation, since the key that made the first
one no longer exists. A publisher who wants to be recognised uses a key they
keep, through the [command line](/docs/quickstart).

**Not closed, in a browser host.** DNS prefetch, speculation rules and WebRTC
are not governed by `connect-src`, and a page cannot switch them off for a frame
it hosts. A native host can and should disable them at the webview layer. We
would rather name them here than have you find them.

**Sent, not stored.** When a document is too large to travel inside a link, it
can be put in a store — and the store is handed ciphertext under the hash of
that ciphertext, with the key in the part of the link after the `#`, which no
browser ever sends to any server. Whoever runs the store can count documents and
measure them. They cannot read one, cannot tell which link opens which, and
cannot substitute one: the hash is checked before the key is even used.

**Not addressed at all.** A malicious application. The sandbox bounds what code
can reach; it does not make the code benign, and an app that asks you for a
password and stores the answer in its own database is doing nothing the format
prevents.
