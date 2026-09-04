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

Send `RECIPE_AS_PROMPT` from `src/recipe.ts` followed by the prompt's `ask` and
its `requires`, and write what comes back into that directory. Record the model
and the date beside it, because a score without them is a rumour.

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

The starter set is four prompts, which is enough to prove the pipeline and far
too few to publish. A real run wants several hundred, and the cost of that is
the completions rather than the scoring.
