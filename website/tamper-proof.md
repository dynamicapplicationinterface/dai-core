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
