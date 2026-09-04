# Gemini

What a model that had never seen this repository produced from the public
recipe and one sentence.

`dose-log/` came from Gemini, given the text of `/docs/the-recipe` followed by
*"I want to track my medicine, the type and time I last took it. I will use it
on my iPhone and I want it to be easy to use. I like Apple design. Include an
icon that looks like a pill."* It is kept exactly as it arrived.

Worth recording about it, because it is the first real sample:

- It used the kit for everything. There is no `app.js`; the whole application
  is HTML, CSS and SQL.
- It included `icon.svg` unprompted beyond the recipe's own section, and drew
  what was asked for.
- Its seed data uses `INSERT … SELECT … WHERE NOT EXISTS`, which is idempotent
  across opens — a better pattern than the recipe's own example.
- `dai check` told it its data would not travel. That was the checker's fault:
  it looked for `window.dai` and the kit never names it. Fixed the same day.

This directory is not scored by `scripts/evaluate.mjs`, which pairs a
candidate directory with a prompt id from `eval/prompts.json`; this app was
not made from one of those prompts. It is here as evidence, and as a fixture
for anything that wants a model-written application rather than one of ours.
