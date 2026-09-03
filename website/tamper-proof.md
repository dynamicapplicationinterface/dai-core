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

**Detected, not prevented.** Alteration. Every entry is fingerprinted and the
signature covers the manifest, so a changed file fails its own check — and every
host here refuses on that basis before anything runs. What that proves is that
the file has not changed since it was signed, *not* who signed it: a container
carries its own key, so somebody who alters one can re-sign it with a key of
their own. Recognising a publisher needs something from outside the file. The
desktop app pins a key the first time it sees a document and refuses a different
one afterwards.

**Not closed, in a browser host.** DNS prefetch, speculation rules and WebRTC
are not governed by `connect-src`, and a page cannot switch them off for a frame
it hosts. A native host can and should disable them at the webview layer. We
would rather name them here than have you find them.

**Not addressed at all.** A malicious application. The sandbox bounds what code
can reach; it does not make the code benign, and an app that asks you for a
password and stores the answer in its own database is doing nothing the format
prevents.
