---
layout: home

hero:
  name: "DAI"
  text: "An app that is just a file"
  tagline: "Build something with AI, and get back one file that opens by double-clicking. It holds the app, its database and your data — and it cannot send any of it anywhere."
  actions:
    - theme: brand
      text: I made something with AI
      link: /make-one
    - theme: alt
      text: My team wants to use these
      link: /tamper-proof
    - theme: alt
      text: Read the specification
      link: /docs/specification
---

<div class="content-container" style="max-width: 1152px; margin: 0 auto; padding: 0 24px;">

## Three reasons people use it

### 1. Nothing to set up

No servers, no hosting, no accounts, no database to configure. The database
is *inside the file* — real SQLite, compiled in — so an app you make in the
morning is a document you can use in the afternoon. If you can save a
spreadsheet, you can ship one of these.

### 2. Safe to hand to anyone

A DAI file cannot reach the network. Not by policy — by construction: it
declares its permitted connections as none and the browser enforces it. It
also carries a fingerprint of every byte it contains, so tampering with one
makes it refuse to open. That is what makes it something an IT department
can allow rather than block.

<a href="/tamper-proof">Break one yourself →</a>

### 3. It goes where you go

Email it, put it on a USB stick, drop it in a shared folder, keep it for ten
years. It opens on a laptop with no wifi, on a machine with nothing
installed, on any operating system with a browser. Your data travels inside
the same file, so there is no account to lose access to and no service that
can shut down and take it with them.

---

## Try it without reading anything else

<DownloadCard />

## For the people who have to approve this

If staff are going to build their own tools with AI, the question is not
whether they will — it is what they will be running. DAI answers the four
things that usually come up:

| Concern | What the format does |
| :--- | :--- |
| Can it exfiltrate our data? | `connect-src 'none'`, enforced by the browser. It has no way to open a connection. |
| Can someone tamper with one? | Every entry is SHA-256 fingerprinted in both directions. A modified file will not run. [Demonstrated here](/tamper-proof). |
| Do we know who built it? | ECDSA P-256 publisher signatures, with keys pinned on first use. |
| Can we see what is being run? | The [host bridge](/docs/host-bridge) reports mounts, refusals and saves to software you control. |

The [security model](/docs/security) is written to be argued with, including
the parts the format deliberately does not solve.

## What is actually in the file

```html
<!doctype html>
<html>
  <head>
    <meta name="dai-integrity" content="required">
    <meta name="dai-public-key" content="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...">
  </head>
  <body>
    <script id="dai-bootloader">/* zero-dependency bootloader */</script>
    <script id="dai-payload">
      /* base64 ZIP: app/**, sqlite3.wasm, manifest.json */
    </script>
  </body>
</html>
```

A single HTML document that happens to contain a compressed archive. Which
is why it opens anywhere, and why it will still open in twenty years.
[The full specification](/docs/specification) is short.

</div>
