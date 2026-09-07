# Brief: a home-screen web app does not reach the bottom of the screen

## What to fix

`opendai.app` is a PWA that opens a document and mounts it in a frame. Added to
an iPhone home screen and launched **as a web app** (iOS asks, and the answer
was yes — there is no Safari chrome on screen, no URL bar and no toolbar), the
application does not fill the display. Roughly 60–70 points at the bottom of the
screen are a dead band in the opener's grey, and the application's own content is
cut off at that line rather than continuing to the edge of the phone.

A normal PWA does not do this. `trellisapp.fit`, installed the same way on the
same phone, runs edge to edge: its content reaches the physical bottom of the
screen and its own bottom bar floats above the home indicator.

Fix the geometry so a launched-from-home-screen document reaches the bottom edge
of the phone, **without** reintroducing either of the two failures already seen
(below).

## The shape of the page

Three nested documents:

1. **The opener** — `apps/runner/index.html`, top-level, at `opendai.app`. This is
   the only document that can see `env(safe-area-inset-*)`.
2. **The shell** — `dist/template.html`, in `<iframe id="cartridge">`, loaded from
   a `blob:` URL, sandboxed into an opaque origin. `html, body { height: 100% }`.
3. **The application** — in `<iframe id="dai-app">` inside the shell, also
   `height: 100%`, `position: absolute; inset: 0`.

The opener's layout is a flex column: `header` (fixed height, ~38px, holds the
document icon and a menu button) then `main { flex: 1 1 auto; position: relative;
overflow: hidden }`, and `#cartridge { position: absolute; inset: 0; width: 100%;
height: 100% }`.

**A constraint that matters:** `env(safe-area-inset-*)` is `0` inside an iframe.
The application cannot pad itself around the home indicator; only the opener sees
the real insets. Any solution that expects the app to handle its own safe area has
to get the value across a document boundary (the shell is our code and could be
told by `postMessage`; the application is the user's code and mostly will not
know about it).

## The CSS as it stands

```css
html, body { margin: 0; overflow: hidden; background: var(--bg); color: var(--text); }

body {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  box-sizing: border-box;
  height: 100vh;          /* fallback */
  height: 100dvh;
  display: flex;
  flex-direction: column;
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  overscroll-behavior: none;
}

/* While a document is open, the edges of the screen are its colour. */
body.loaded { background: var(--app-ground, var(--bg)); }

main { flex: 1 1 auto; position: relative; overflow: hidden; }
```

Relevant `<head>`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

The per-document manifest (built in `apps/runner/src/install.ts`) declares
`display: "standalone"`, `scope: "<origin>/"`, and a `start_url` that carries the
document.

## Two failures already seen, either of which counts as a regression

1. **`height: 100dvh` with both safe-area insets as padding** — the state now.
   In a home-screen web app this leaves the dead band at the bottom that this
   brief is about. Recorded once before and "fixed" by changing the height rather
   than the padding.
2. **`position: fixed; inset: 0`** (no explicit height, no `dvh`) — fixes the
   home-screen case, and breaks a Safari **tab**: `inset: 0` resolves against the
   layout viewport, which runs on underneath Safari's toolbars, so the bottom
   fifth of every application sat behind the browser bar and could not be
   reached or tapped.

A correct answer has to hold in **both** contexts: a home-screen web app, and an
ordinary Safari tab where the toolbars are present and can hide and reappear as
the page scrolls.

## What is not the problem

- It is not a bookmark-instead-of-web-app. The latest screenshot has no Safari
  chrome at all: status bar, then the opener's own header, then the app.
- It is not the shell or the app frame being mis-sized *relative to what the
  opener gives them*. Measured at a 390×844 viewport in Chromium: body 844,
  header 44, `main` 800, `#cartridge` 800, shell body 800, app viewport 800. The
  chain is consistent; the question is what the opener's body height should be.
- The dead band is painted in `--bg` (light grey) rather than the app's colour
  because `--app-ground` is only set when the application declares
  `<meta name="theme-color">`, and the application in the screenshot does not.
  Making the band the right colour is a consolation, not the fix — the band
  should not exist.

## What would settle it

The honest gap is that nobody has measured what iOS actually reports in a
standalone web app with `viewport-fit=cover` and a `black-translucent` status
bar. Worth establishing, on a real iPhone, from the top-level opener document:

- `window.innerHeight`
- `document.documentElement.clientHeight`
- `visualViewport.height` and `visualViewport.offsetTop`
- the computed value of `100dvh`, `100svh`, `100lvh`
- `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` as resolved pixels
- the same six values in a Safari tab, with toolbars shown and hidden

The specific question: **does `100dvh` in an iOS standalone web app with
`viewport-fit=cover` already exclude the safe-area insets, or does it include
them?** If it excludes them, padding the body by the insets subtracts them a
second time, which is exactly a band of the bottom inset's height at the bottom —
the symptom. That is the leading hypothesis and it is unverified.

## The deliverable

One formulation — CSS, or CSS plus a small amount of JS driven by
`visualViewport` — that gives:

- a home-screen web app reaching the physical bottom edge of the phone, with the
  application's content continuing to that edge the way `trellisapp.fit` does;
- a Safari tab whose content ends above the browser toolbar and never behind it,
  including when the toolbar hides and returns on scroll;
- a header that clears the dynamic island in both;
- no dependency on the application knowing anything about safe areas, since it is
  in an iframe and cannot see them.

Say which part of it is load-bearing and why, and how to check it on a device
rather than in an emulator — the two failures above were both introduced by
reasoning that looked right at a desktop viewport.

## Where things are

- `apps/runner/index.html` — the opener: the CSS above, the `<head>` metas.
- `apps/runner/src/main.ts` — sets `--app-ground` from the application's
  `theme-color` (`describeApp` in `apps/runner/src/card.ts` reads it).
- `dist/template.html` (source `src/template.html`) — the shell inside the frame.
- `apps/runner/src/install.ts` — the per-document manifest and the launch address.
