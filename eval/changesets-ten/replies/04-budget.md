I built this as a solo document: one person's budget, kept in one file. Nobody else adds to it, so nothing is shared. It uses ordinary tables and no sync.

You set a monthly limit for each category (Groceries, Eating out, and so on). You log each expense under a category. Each category shows what you have spent this month, what is left or how far over you are, and a bar. The budget is for the current calendar month, so a new month starts at zero on its own. Older expenses stay in the file.

```text
dai bundle v1
name: Budget

--- file: schema.sql
-- Budget · shape: solo
--
-- The decision: one person's monthly budget, kept on their own device. Nobody
-- else adds to it and no second copy's changes need keeping, so nothing is
-- shared: ordinary tables, with keys and constraints.
--
-- Nothing derived is stored. What a category has spent, what is left and
-- whether it is over are worked out from the expenses every time they are drawn.
-- An expense's date is the day the person says they spent it, not when the row
-- was written.

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  limit_cents INTEGER NOT NULL DEFAULT 0     -- monthly limit; 0 means no limit
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL,
  what        TEXT NOT NULL,
  cents       INTEGER NOT NULL,
  spent_on    TEXT NOT NULL                  -- YYYY-MM-DD, as entered
);

CREATE TABLE IF NOT EXISTS settings (
  id     INTEGER PRIMARY KEY CHECK (id = 1),
  seeded INTEGER NOT NULL DEFAULT 0
);

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="Monthly spending by category, against your limits" />
  <meta name="dai:does" content="Set a monthly limit for each category of spending" />
  <meta name="dai:does" content="Log what you spend and see what is left in each category" />
  <meta name="dai:does" content="Show when a category goes over, and start fresh each month" />
  <meta name="theme-color" content="#f3f2ec" />
  <title>Budget</title>
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <script type="application/sql">
    -- Local seed, written once. The flag keeps a second open from adding it
    -- again, even after the person has deleted the examples.
    INSERT OR IGNORE INTO settings (id) VALUES (1);

    INSERT INTO categories (id, name, limit_cents)
    SELECT * FROM (VALUES
      (1, 'Groceries', 40000),
      (2, 'Eating out', 12000),
      (3, 'Transport', 15000),
      (4, 'Fun', 10000)
    ) WHERE (SELECT seeded FROM settings WHERE id = 1) = 0;

    INSERT INTO expenses (id, category_id, what, cents, spent_on)
    SELECT * FROM (VALUES
      (1, 1, 'Weekly shop',  8640, max(date('now','localtime','start of month'), date('now','localtime','-6 days'))),
      (2, 1, 'Farmers market', 2350, max(date('now','localtime','start of month'), date('now','localtime','-3 days'))),
      (3, 2, 'Pizza night',  3800, max(date('now','localtime','start of month'), date('now','localtime','-4 days'))),
      (4, 2, 'Coffee',        675, date('now','localtime','-1 day')),
      (5, 3, 'Gas',          4200, max(date('now','localtime','start of month'), date('now','localtime','-5 days'))),
      (6, 4, 'Movie tickets', 3000, max(date('now','localtime','start of month'), date('now','localtime','-2 days')))
    ) WHERE (SELECT seeded FROM settings WHERE id = 1) = 0;

    UPDATE settings SET seeded = 1 WHERE id = 1;
  </script>

  <p id="opening" class="opening" role="status">Opening…</p>

  <main id="app" hidden inert>
    <header>
      <p class="eyebrow">
        This month ·
        <dai-value query="SELECT substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m','now','localtime') AS INTEGER) - 1) * 3 + 1, 3) || ' ' || strftime('%Y','now','localtime')"></dai-value>
      </p>
      <h1>Budget</h1>
    </header>

    <p id="notice" class="notice" role="status" hidden></p>

    <section class="stats" aria-label="This month in total">
      <div class="stat">
        <span class="stat-label">Spent</span>
        <dai-value class="stat-num" query="SELECT printf('$%.2f', COALESCE(SUM(cents), 0) / 100.0) FROM expenses WHERE substr(spent_on, 1, 7) = strftime('%Y-%m','now','localtime')"></dai-value>
      </div>
      <div class="stat">
        <span class="stat-label">Budget</span>
        <dai-value class="stat-num" query="SELECT printf('$%.2f', COALESCE(SUM(limit_cents), 0) / 100.0) FROM categories"></dai-value>
      </div>
      <div class="stat">
        <span class="stat-label">Left</span>
        <dai-value class="stat-num" query="SELECT CASE WHEN count(*) = 0 THEN 'No limits set' ELSE printf('%s$%.2f', CASE WHEN SUM(l - sp) &lt; 0 THEN '-' ELSE '' END, abs(SUM(l - sp)) / 100.0) END FROM (SELECT c.limit_cents AS l, COALESCE((SELECT SUM(e.cents) FROM expenses e WHERE e.category_id = c.id AND substr(e.spent_on, 1, 7) = strftime('%Y-%m','now','localtime')), 0) AS sp FROM categories c WHERE c.limit_cents &gt; 0)"></dai-value>
      </div>
    </section>

    <section>
      <h2>Categories</h2>
      <div id="cats">
        <dai-rows
          empty="No categories yet. Add one below, like Groceries or Rent."
          query="SELECT id, name,
                   CASE WHEN limit_cents = 0 THEN '' ELSE printf('%.2f', limit_cents / 100.0) END AS limit_dollars,
                   printf('$%.2f', sp / 100.0) AS spent_text,
                   CASE WHEN limit_cents = 0 THEN 'No limit set'
                        WHEN sp &gt; limit_cents THEN printf('$%.2f over', (sp - limit_cents) / 100.0)
                        ELSE printf('$%.2f left', (limit_cents - sp) / 100.0) END AS left_text,
                   CASE WHEN limit_cents &gt; 0 AND sp &gt; limit_cents THEN 1 ELSE 0 END AS over,
                   CASE WHEN limit_cents &gt; 0 AND sp &gt; limit_cents THEN 0 ELSE 1 END AS ok,
                   CASE WHEN limit_cents = 0 THEN ''
                        ELSE substr('&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;', 1, MIN(10, CAST(sp * 10 / limit_cents AS INTEGER)))
                          || substr('&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;&#9617;', 1, 10 - MIN(10, CAST(sp * 10 / limit_cents AS INTEGER))) END AS bar,
                   CASE WHEN NOT EXISTS (SELECT 1 FROM expenses x WHERE x.category_id = id) THEN 1 ELSE 0 END AS empty
                 FROM (SELECT c.id AS id, c.name AS name, c.limit_cents AS limit_cents,
                              COALESCE((SELECT SUM(e.cents) FROM expenses e WHERE e.category_id = c.id AND substr(e.spent_on, 1, 7) = strftime('%Y-%m','now','localtime')), 0) AS sp
                       FROM categories c)
                 ORDER BY name">
          <template>
            <div class="cat">
              <div class="cat-top">
                <strong class="cat-name" data-text="name"></strong>
                <span class="cat-left" data-text="left_text"></span>
              </div>
              <div class="bar" aria-hidden="true">
                <span class="bar-ok" data-when="ok" data-text="bar"></span>
                <span class="bar-over" data-when="over" data-text="bar"></span>
              </div>
              <div class="cat-bottom">
                <span class="spent"><span data-text="spent_text"></span> spent</span>
                <label class="limit">
                  <span>Limit</span>
                  <input inputmode="decimal" placeholder="No limit" aria-label="Monthly limit"
                         data-text="limit_dollars"
                         data-run="UPDATE categories SET limit_cents = max(0, CAST(round(:typed * 100) AS INTEGER)) WHERE id = :id" />
                </label>
                <button type="button" class="link" data-when="empty"
                        data-run="DELETE FROM categories WHERE id = :id AND NOT EXISTS (SELECT 1 FROM expenses WHERE category_id = :id)">Remove category</button>
              </div>
            </div>
          </template>
        </dai-rows>
      </div>

      <form id="category-form" class="card form" autocomplete="off">
        <h3>New category</h3>
        <div class="fields">
          <label>Name <input id="cat-name" required maxlength="40" placeholder="e.g. Rent" /></label>
          <label>Monthly limit <span class="optional">· optional</span>
            <input id="cat-limit" inputmode="decimal" placeholder="0.00" /></label>
        </div>
        <div class="actions"><button type="submit">Add category</button></div>
      </form>
    </section>

    <section>
      <h2>Add an expense</h2>
      <p id="no-cats" class="empty" hidden>Add a category first, then log what you spend in it.</p>
      <form id="expense-form" class="card form" autocomplete="off">
        <div class="fields">
          <label>Amount <input id="amount" required inputmode="decimal" placeholder="0.00" /></label>
          <label>What <input id="what" required maxlength="80" placeholder="e.g. Lunch" /></label>
          <label>Category <select id="category" required></select></label>
          <label>Date <input id="spent-on" type="date" required /></label>
        </div>
        <div class="actions"><button type="submit">Add expense</button></div>
      </form>
    </section>

    <section>
      <h2>This month&rsquo;s expenses</h2>
      <dai-rows
        empty="Nothing logged this month yet."
        query="SELECT e.id AS id, e.what AS what, printf('$%.2f', e.cents / 100.0) AS amount_text, c.name AS category,
                 CASE WHEN e.spent_on = date('now','localtime') THEN 'Today'
                      WHEN e.spent_on = date('now','localtime','-1 day') THEN 'Yesterday'
                      ELSE substr('JanFebMarAprMayJunJulAugSepOctNovDec', (CAST(strftime('%m', e.spent_on) AS INTEGER) - 1) * 3 + 1, 3) || ' ' || CAST(strftime('%d', e.spent_on) AS INTEGER) END AS day
               FROM expenses e JOIN categories c ON c.id = e.category_id
               WHERE substr(e.spent_on, 1, 7) = strftime('%Y-%m','now','localtime')
               ORDER BY e.spent_on DESC, e.id DESC LIMIT 100">
        <template>
          <div class="exp">
            <div class="exp-main">
              <strong data-text="what"></strong>
              <span class="meta"><span data-text="day"></span> · <span data-text="category"></span></span>
            </div>
            <span class="amount" data-text="amount_text"></span>
            <button type="button" class="link" data-run="DELETE FROM expenses WHERE id = :id">Delete</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <footer>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module" src="./app.js"></script>
</body>
</html>

--- file: app.js
// Budget: a solo document. The kit draws the categories, the totals and the
// expense list; this file only adds the two forms, because they need a list of
// categories to pick from, and the kit's forms cannot fill a menu.

const $ = (id) => document.getElementById(id);
let db;
let kit;

const pad = (n) => String(n).padStart(2, "0");
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function say(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

/** Dollars typed by a person, as whole cents, or null when it is not an amount. */
function toCents(text) {
  const n = Number.parseFloat(String(text).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/** The menu of categories, kept in step with the table. */
function fillCategories() {
  const keep = $("category").value;
  const cats = db.selectObjects("SELECT id, name FROM categories ORDER BY name");
  $("category").replaceChildren(
    ...cats.map((c) => {
      const option = document.createElement("option");
      option.value = String(c.id);
      option.textContent = c.name;
      return option;
    }),
  );
  if (cats.some((c) => String(c.id) === keep)) $("category").value = keep;
  $("expense-form").hidden = cats.length === 0;
  $("no-cats").hidden = cats.length > 0;
}

$("expense-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const cents = toCents($("amount").value);
  if (cents === null || cents <= 0) {
    say("Enter the amount as a number, like 12.50.");
    return;
  }
  try {
    db.exec({
      sql: "INSERT INTO expenses (category_id, what, cents, spent_on) VALUES (?, ?, ?, ?)",
      bind: [Number($("category").value), $("what").value.trim(), cents, $("spent-on").value],
    });
    say("");
    $("amount").value = "";
    $("what").value = "";
    kit.refresh();
    $("amount").focus();
  } catch (error) {
    say(`That did not save: ${error?.message ?? error}`);
  }
});

$("category-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("cat-name").value.trim();
  const typed = $("cat-limit").value.trim();
  const limit = typed === "" ? 0 : toCents(typed);
  if (!name) return;
  if (limit === null || limit < 0) {
    say("Enter the limit as a number, like 250, or leave it empty for no limit.");
    return;
  }
  try {
    db.exec({
      sql: "INSERT INTO categories (name, limit_cents) VALUES (?, ?)",
      bind: [name, limit],
    });
    say("");
    $("category-form").reset();
    kit.refresh();
    fillCategories();
    $("cat-name").focus();
  } catch (error) {
    say(
      String(error?.message ?? error).includes("UNIQUE")
        ? `You already have a category called ${name}.`
        : `That did not save: ${error?.message ?? error}`,
    );
  }
});

// Start-up: nothing can be typed into until this has finished, and if it
// fails the person is told, not left at "Opening...".
try {
  await import("./dai-kit.js");
  kit = window.daiKit;
  db = kit.db;
  $("spent-on").value = todayYmd();
  fillCategories();
  // A category added, removed or renamed through the kit's own controls
  // redraws the list; keep the menu in step with it.
  new MutationObserver(fillCategories).observe($("cats"), { childList: true, subtree: true });
  $("opening").hidden = true;
  $("app").hidden = false;
  $("app").inert = false;
} catch (error) {
  $("opening").classList.add("failed");
  $("opening").textContent =
    `This budget could not be opened: ${error?.message ?? error}. ` +
    "Try opening the document again, or ask whoever sent it for a new copy.";
}

--- file: app.css
:root {
  color-scheme: light dark;
  --bg: #f3f2ec;
  --card: #ffffff;
  --ink: #1d2a22;
  --muted: #667068;
  --line: #e0ddd0;
  --accent: #2f7a4f;
  --warn: #b3412c;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #151a17; --card: #1e2520; --ink: #e8ede9; --muted: #9ba59d; --line: #2c352e; --accent: #7cc59b; --warn: #f0937d; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; background: var(--bg); color: var(--ink); }
body { line-height: 1.45; font-size: 16px; }
main {
  max-width: 640px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: calc(24px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(16px + var(--dai-safe-left, 0px));
}
/* The top right corner belongs to the host's menu button. */
header { padding-right: 56px; }
h1 { margin: 0; font-size: 32px; letter-spacing: -0.02em; }
h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
h3 { margin: 0 0 12px; font-size: 16px; }
.eyebrow { margin: 0 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); }

.opening {
  margin: 0; color: var(--muted); text-align: center;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(16px + var(--dai-safe-right, 0px)) 0 calc(16px + var(--dai-safe-left, 0px));
}
.opening.failed { color: var(--ink); text-align: left; max-width: 36em; margin: 0 auto; }
.notice { margin: 0; background: var(--card); border-left: 4px solid var(--warn); padding: 10px 12px; border-radius: 8px; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; display: grid; gap: 2px; }
.stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.stat-num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }

#cats dai-rows { display: grid; gap: 10px; }
.cat { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; display: grid; gap: 8px; }
.cat-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.cat-name { font-size: 18px; }
.cat-left { font-variant-numeric: tabular-nums; color: var(--muted); font-weight: 600; }
.bar { font-size: 15px; letter-spacing: 2px; line-height: 1; overflow: hidden; white-space: nowrap; min-height: 1px; }
.bar-ok { color: var(--accent); }
.bar-over { color: var(--warn); }
.cat:has(.bar-over:not([hidden])) .cat-left { color: var(--warn); }
.cat-bottom { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; color: var(--muted); font-size: 14px; }
.spent { flex: 1 1 8em; font-variant-numeric: tabular-nums; }
.limit { display: flex; align-items: center; gap: 8px; }
.limit input { width: 7.5em; }

.exp { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 4px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 14px; margin-bottom: 8px; }
.exp-main { display: grid; gap: 1px; min-width: 0; }
.exp-main strong { overflow-wrap: anywhere; }
.meta { color: var(--muted); font-size: 14px; }
.amount { font-weight: 600; font-variant-numeric: tabular-nums; }
dai-rows .empty, .empty { color: var(--muted); }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.form { margin-top: 12px; }
#expense-form { margin-top: 0; }
.fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.fields label { display: grid; gap: 6px; font-size: 14px; color: var(--muted); }
.optional { font-size: 13px; opacity: 0.8; }
.actions { margin-top: 14px; display: flex; gap: 8px; }

input, select {
  font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line);
  border-radius: 10px; min-height: 44px; padding: 8px 12px; width: 100%;
}
::placeholder { color: var(--muted); opacity: 0.6; }
button {
  font: inherit; min-height: 44px; padding: 0 18px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: var(--bg); font-weight: 600;
}
button.link {
  min-height: 44px; padding: 0 4px; border: 0; background: none; color: var(--muted);
  font-weight: 400; font-size: 14px; text-decoration: underline; text-underline-offset: 3px;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

footer { display: flex; justify-content: flex-end; }
dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; background: var(--accent); color: var(--bg); font-weight: 600; cursor: pointer; }

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#2f7a4f"/><circle cx="50" cy="50" r="30" fill="#f3f2ec"/><path d="M50 22v56M38 40c0-8 24-8 24 0s-24 12-24 20 24 8 24 0" fill="none" stroke="#2f7a4f" stroke-width="7" stroke-linecap="round"/></svg>
```

A few notes on how it behaves:

- **Categories.** Four examples come with it (Groceries, Eating out, Transport, Fun). Add your own below the list, and type over any limit to change it. A category with no limit still tracks spending. A category can only be removed while it has no expenses, so nothing you logged disappears by accident.
- **Expenses.** Pick the category and the date, which defaults to today. Delete one from the list and the totals update. The list shows this month's expenses.
- **Over budget.** The bar and the "left" figure turn red and read "$X over".
- **Totals.** Spent, Budget and Left across all categories are always worked out from the expenses, never stored.
- **Sharing.** This is a one-person document. If you want to share it with a partner so both of you add expenses and both sets are kept, say so. That makes it a different kind of document, with shared tables, so it needs to be built that way from the start.
- **Untested.** I haven't run this. Open it once to check it before you rely on it.
