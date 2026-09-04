# What a person waits for

The number the mobile path is judged on is seconds from tap to interactive on a
phone that has never seen this before. The target is **under two seconds on a
mid-range Android over cellular, with nothing cached**.

Nothing measured it until now, and the guesses were wrong in an instructive
direction.

## Where the time goes

The same application, built both ways, opened in the runner on a desktop. These
are not the target device; they are the shape of the problem.

```
                size    usable    host                              container
viewer        839 KB    208 ms    verified 113  prepared 121  ...   boot 17  decoded 20  unzipped 35  interactive 84
sectioned     604 KB    189 ms    verified  63  prepared  76  ...   boot 33  decoded 38  unzipped 39  interactive 106
```

`npm test` prints this on every run — `tests/form-cost.spec.ts` — and the
runner reports the same breakdown on whatever device it is running on when the
address carries `?timing`.

## What that settled

**The costs everyone suspected are not the costs.** Decoding base64 is 3 ms.
Inflating the zip is 15 ms. Digesting every entry is 2 ms. Together they are
under a tenth of the wait.

**Verification in the host dominates** — 113 ms of a 208 ms open for the viewer
form, which is reading the file, decoding its payload and hashing every entry
before anything is allowed to mount. It is also the one part that cannot be
skipped: it is what makes the file safe to open.

**The engine is not on the critical path.** The 850 kB WebAssembly engine costs
about 36 ms to compile, and it happens *after* the application is on screen,
because an application asks for its database once it has painted. Optimising it
first — preloading, caching, deduplicating — would have moved a number nobody
is waiting on. There is a test asserting that ordering, so if an application
ever does open its database before painting, we find out.

**Base64 costs a third of the file, permanently.** The viewer form is 839 kB
against 604 kB for the same application, and that third is paid on every open,
every send, and every byte of storage.

## What it points at next

The sectioned form is faster to verify (63 ms against 113 ms) and then loses
half of that advantage inside the container (106 ms against 84 ms). The reason
is ours: a host mounting a sectioned container currently rebuilds a viewer-form
document — re-zipping the archive and base64-encoding it — because the shell
reads its payload out of its own `<script>` tag.

The obvious next move is for the host to hand the payload over as bytes rather
than encoding it into the document. That is the same change the native plan
calls a custom scheme handler, and it removes the last base64 in the path.

It is a protocol addition rather than an optimisation — a container would have
to be able to ask its host for a payload it does not carry inline — so it is
written down here rather than done quietly.

## What these numbers are not

A desktop with a warm cache is not a phone on a train. Nothing here has been
measured on the target device, so the ceiling in the test suite is loose enough
to catch order-of-magnitude regressions and nothing finer. The runner's
`?timing` output exists so the real measurement can be taken where it counts.
