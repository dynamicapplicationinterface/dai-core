# The ten cold apps: runs

`ten-apps.spec.ts` drives each app in `apps/` through the real runtime: two
devices write through the page, exchange files, reopen, and a third recovers
from one file (the spec's header has the steps). The apps are parsed from
`replies/` by `extract.mjs`.

## Build 2a (21 October)

**The generations.** Ten Sonnet subagents, each reading only the model file
of R-Y (33,955 bytes, sha256
`e2db23c9322707054958d7dce662f1bdaeecfa6e35f1da14617ca0dc3445f510`, the
`RECIPE` of `fbe37aa5`) and answering "Make me a …" with the spike's ten names:
a packing list, a workout log, a reading list, a budget with categories, a
recipe box, a habit tracker, a chore chart, a plant-care log, an inventory, a
trip planner. The spike kept the names, not its exact wording. One provider,
n=1 per prompt, and the subagents carried an agent's system prompt. All ten
pass `dai check`.

**Run 1** (`04946c1c`): 5 of 10. **Run 2** (`3f87c07b`): the same generations,
not asked again, after the fixes below: 10 of 10.

| App | Run 1 | Run 2 | Cause of the run 1 failure | The fact |
|---|---|---|---|---|
| packing list | fail: reopen, recovery | pass | harness | Device B's typing wrote nothing (0 inserts). Its add form is a select, an input and `<button type="button">`, as the model file's own example writes it; the harness clicked only a submit-type button and otherwise pressed Enter in the first field, the select. The kit runs a form on its own button whatever its type: the harness now clicks it. With the old submit, the kit's ready signal alone still wrote 0 rows; with the button, 2. |
| workout log | pass | pass | — | |
| reading list | pass | pass | — | |
| budget | fail: reopen | pass | harness | The other copy's typing was on screen, drawn into editable fields (`<input data-text="name">`); the harness read the page's `innerText`, which leaves out what a field holds. It now reads field values too. |
| recipe box | pass | pass | — | |
| habit tracker | fail: reopen, recovery | pass | harness | Both of the above: its add form's first field is a select (so B wrote nothing), and its names are drawn into editable fields. |
| chore chart | fail: build | pass | compiler | `DEFAULT '🙂'` before a table: the schema scanner read by UTF-16 unit and searched a copy built by code point, so the closing bracket was never found (D289, fixed). |
| plant-care log | pass | pass | — | |
| inventory | fail: open, reopen, recovery | pass | harness | Its seed notes read "Opening count", shown in its recent changes; the harness took any line beginning "Opening" for the start-up line. Started is now the kit's ready signal (`data-dai-kit="ready"`), and without the kit only a line that is "Opening…" alone. |
| trip planner | pass | pass | — | |

No failure was the model file's or an app's own choice. What the apps reached
for that the model file did not show is the next section's.

**A control, the earlier apps on the new runtime.** To tell the boundary from
the apps, the earlier ten apps (the spike's replies, as `main` holds them) ran
once under run 1's harness and the new runtime: 6 of 10. The six are every
earlier app built from the kit alone. Budget, the habit tracker and the trip
planner open the database through `openDatabase()` in their own scripts,
which the ordinary data interface now refuses with the sentence that names
`database()` (R-Y); the chore chart declares shared tables, refused at build
since R-R.

**What the apps assumed.** Each subagent listed what it assumed the kit did.
All ten put `data-run` on a plain button, and most hid elements with
`data-when` and drew values into fields with `data-text`; the kit does all
three, and the model file showed none of them. Two needed a select filled from
a table, which the kit could not do: the budget gave each category its own
amount field instead, and the chore chart filled one in a script of its own.
The kit now fills `<select data-options="SELECT id, name FROM people">`, and
the model file shows all four (`ec4d79d9`, 33,959 bytes). These replies were
not asked again; the next cold run asks from the amended file (D290).
