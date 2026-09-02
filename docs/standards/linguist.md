# GitHub Linguist — proposed entry

Status: **draft, not submittable yet.** The acceptance bar is not met; see below.
The `.gitattributes` section, however, solves the immediate problem today and
needs nobody's approval.

---

## What you probably want first

The stated goal is "clean repository language breakdowns". A Linguist entry is
the slow way to get that, and not obviously the right one.

A cartridge is a **build artifact**: one file, tens of kilobytes to over a
megabyte, most of it a base64 payload containing a compiled application and a
WebAssembly build of SQLite. Nobody writes one by hand. Counting it as source of
any language misrepresents the repository — including as a hypothetical "DAI"
language, which would report this project as mostly DAI when almost none of it
is authored that way.

Linguist already offers the correct answer, and it takes one line:

```gitattributes
# .gitattributes
*.dai        linguist-generated=true
*.dai.html   linguist-generated=true
```

`linguist-generated` excludes the file from language statistics *and* collapses
it in diffs — which is what you want for a megabyte of base64 that changes
wholesale on every build. `linguist-vendored=true` is the alternative if you
would rather they appear in diffs.

This repository should carry that file regardless of what happens with the
upstream submission.

## The acceptance bar

Linguist's `CONTRIBUTING.md` requires a new language to be **in use in hundreds
of repositories on GitHub**, discoverable by a code search they will run
themselves. At the time of writing, `.dai` appears in one repository: this one.

There is no route around that, and submitting early is counterproductive — a
rejected pull request is a public record that the language was judged not in use,
which is a worse starting point than not having asked. Revisit when a search for
the extension returns a few hundred distinct repositories.

Two further requirements to prepare in the meantime:

- **A grammar.** Highlighting needs a TextMate or tree-sitter grammar, referenced
  by `tm_scope`. A cartridge is HTML, so `text.html.basic` is the honest scope;
  inventing a `source.dai` scope would mean writing and maintaining a grammar
  that duplicates HTML's.
- **Samples.** A file under `samples/` for the detection heuristics. This is
  awkward here: a real cartridge is far larger than anything in that directory,
  and a hand-trimmed sample is not a real cartridge. A minimal container with an
  empty database and no engine is the reasonable compromise, and it should be
  generated reproducibly rather than checked in by hand.

## Proposed `languages.yml` entry

```yaml
DAI Cartridge:
  type: data
  color: "#3b82f6"
  extensions:
  - ".dai"
  tm_scope: text.html.basic
  ace_mode: html
  codemirror_mode: htmlmixed
  codemirror_mime_type: text/html
  language_id: 000000  # assigned by maintainers; must be unique
```

Notes on each choice, since a reviewer will ask:

- **`type: data`**, not `markup` or `programming`. Linguist counts only
  `programming` and `markup` toward the repository breakdown, so `data` keeps
  cartridges out of the statistics — which is the outcome being asked for. It is
  also true: the file is a container, and its interesting content is a compressed
  archive, not the markup wrapping it.
- **`extensions: [".dai"]` only.** `.dai.html` resolves to `.html` under any
  extension-matching scheme, and claiming it would mean claiming HTML.
- **`tm_scope: text.html.basic`**, because the outer document genuinely is HTML.
  The payload is base64 and has no syntax to highlight.
- **No `group:`.** A cartridge is not a dialect of HTML; it is a distinct format
  that happens to be expressible as one.
- **`language_id`** is assigned by the maintainers from their sequence. Leave the
  placeholder rather than inventing a number.

## Detection beyond the extension

Extension alone is weak here, since `.dai` is short and unclaimed elsewhere. If
the submission progresses, Linguist supports content heuristics in
`heuristics.yml`, and this format has an unusually good one:

```yaml
# heuristics.yml
disambiguations:
- extensions: ['.dai']
  rules:
  - language: DAI Cartridge
    pattern: '<script[^>]*id="dai-payload"'
```

That marker is structural, appears in every cartridge, and is unlikely to occur
by accident in an unrelated file.
