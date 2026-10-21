# Does an assistant actually produce a working container?

It is the first question anybody asks about this project, and until now the
honest answer was that nobody had counted.

This is how it gets counted.

## What is measured

Four stages, in order, stopping at the first failure — because "it failed" is
not a finding. An application that will not compile and one that compiles but
loses your data are different problems with different fixes.

| Stage | The question |
|---|---|
| `checked` | Would this work inside a container at all? No network, no browser storage, no inline handlers. |
| `built` | Does it compile into a container? |
| `mounted` | Does it open and run, with nothing in the console? |
| `usable` | Somebody typed into it and pressed save — **is it in the file?** |

Only `usable` counts as working. An application that mounts beautifully and
saves nothing is a demonstration, not a document.

## Shared prompts, retired

Every prompt asks for one person's application. The shared prompts (a
`"shape"` of `passable` or `session`, among them `two-player-game`) asked a
model for the policy layer: tables marked `-- dai:replicated`, a session
profile, writes through `window.dai.replicated`. Under one shape (R-O) an
authored schema no longer declares those. A document's data is shared by the
ordinary data interface, ordinary tables and signed changesets, whatever the
application writes, so there is no separate shared shape for a model to get
right or wrong. They were retired on 19 October, with the `shaped` stage that
scored them.

The examples built on the policy layer stay: they build through its own path
(`--policy-layer`, R-R) and are driven across devices by
`tests/examples-shared.spec.ts`. The candidates already answered for the
retired prompt stay in `eval/candidates` as they were written; the harness no
longer scores them.

```bash
node scripts/evaluate.mjs eval/candidates/reference --json
```

## The prompts are the test

`eval/prompts.json` holds each task and its acceptance test together: what to
ask for, which controls the application must expose, what to do with them, and
what should be in the database afterwards.

Requiring stable ids (`#what`, `#add`, `#save`) is part of the task rather than
a concession to automation. An application nobody can drive cannot be scored,
and one whose controls have names is easier for a person to automate too.

The expectations are about shape rather than vocabulary. A model may reasonably
call a column `title` or `name`, and refusing it for that would be scoring
English rather than working software.

## Where the applications come from

The evaluation does not call a model. Completions are an input: a directory per
prompt, holding the source a model wrote, committed alongside the score.

Three reasons, in order:

1. **A score anybody can reproduce is worth more than one only we can produce.**
   With the completions committed, somebody who doubts the number recomputes it
   in a minute, with no keys and nothing to spend.
2. **Calling an API is the only step that costs money**, and it should be a
   decision somebody makes rather than something a script does on their behalf.
3. **Model endpoints change; the scoring does not.** A pipeline that spoke three
   SDKs would break on somebody else's release schedule.

So producing candidates is a separate, deliberate act:

```
eval/candidates/<model>/<prompt id>/index.html, app.js, …
```

Send `RECIPE_AS_PROMPT` from `src/recipe.ts` — the model file, the same text
the MCP server hands a model and the site publishes at `/llms-full.txt` —
followed by the prompt's `ask` and its `requires`. Send nothing else: the
question is what the model file alone produces. What comes back should be a
bundle — the model file asks for one — so `parseBundle` turns it into the
directory:

```js
import { parseBundle } from "dai-core";
const { files } = parseBundle(completion);
```

Write those files into that directory. Record the model
and the date beside it, because a score without them is a rumour.

## A blind run: the documentation's own defect list

The most useful thing a run produces is often not the application. Give a fresh
model **only the model file** — no repository, no earlier conversation — ask it
for something hard, and ask it to report, quoting the passage, everything in
the instructions it found unclear, contradictory or missing. Treat that list as
a defect list:

1. **Verify each point against the code**, not against the documentation — the
   documentation is the thing under test. Some points will be the model's
   misreading; those are worth a sentence too, since the next model will
   misread the same way.
2. **Fix the real ones in `src/rules.ts`**, so the model file and the pages
   change together, and anchor any new claim to the code it depends on.
3. **Commit the run** under `eval/candidates/<model>-blind/` with the model, the
   date, the exact input, the output unedited, and what the run did and did not
   cover.

Two cautions, both learned from the first run. Ask for something **unlike every
example** in the model file: an application that mirrors the nearest example
shows the instructions teach by imitation, not that a model can reason from the
constraints. And a candidate that lints clean has not been shown to work — drive
it on more than one device in the real host, through the paths an author cannot
check alone: the mailbox, a close, a conflict the person must settle.

The first run (Connect Four, 13 September) found seven real gaps, each fixed in
the change that recorded it. The second (a two-person agreement, unlike any
example) showed the model reasoning from the constraints to a design no example
had, and, driven over the mailbox on three engines, found a bug the first could
not: a redraw on `dai:merged` that threw away what the person was typing —
traced to SHARED-REDRAW-ON-MERGE saying nothing about work in progress. Both
runs are in `eval/candidates/`.

## Reading the result

The number to publish is the `usable` rate. The number to *act* on is the stage
where things failed:

- Failures at `checked` are the recipe's fault, not the model's. If applications
  keep reaching for `localStorage`, the instructions are not saying so clearly
  enough, and that is a fix on this side.
- Failures at `mounted` are usually a module or top-level-await mistake.
- Failures at `usable` are the interesting ones: the application looked right
  and did not keep anything, which is the failure a person discovers a week
  later.

## What this is not

A benchmark of models. It measures how well a set of instructions travels, using
models as the medium — and the instructions are ours. A low rate is our result
before it is anybody else's.

The starter set is four prompts, which is enough
to prove the pipeline and far too few to publish. A real run wants several hundred, and the cost of that is
the completions rather than the scoring.
