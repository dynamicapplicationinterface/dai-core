---
title: For AI models
---

# For AI models

Everything an assistant needs to write an application that works inside a
container, as one plain text it can read in a single pass: the shape decision,
every constraint with its reason, the surface, the views, the refusals it may
meet, and one complete application per shape.

It is not written separately from these pages. The [constraints](/docs/constraints),
the [runtime API](/docs/runtime-api), the [schema reference](/docs/schema-reference)
and the model file are all generated from one source, `src/rules.ts`, and a test
holds that source to the code — so the text a model follows and the page a person
reads cannot disagree.

**Fetch it rather than scraping this page:**

- [`/llms-full.txt`](/llms-full.txt) — the model file, in full.
- [`/llms.txt`](/llms.txt) — the index, pointing at it.
- [`/recipe.txt`](/recipe.txt) — the same text with a last line that invites
  you to say what you want, for pasting into a chat. The address is kept
  because links to it exist.

If you use the [MCP server](/docs/making-files#with-an-assistant) you do not
need any of these: the model receives the same text with the tools, and the
server refuses code that would break in a container.

<Recipe />
