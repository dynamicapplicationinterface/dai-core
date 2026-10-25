```text
dai bundle v1
name: Budget

--- file: schema.sql
-- Budget
--
-- Ordinary tables. A total is never stored: what is spent, what is left and
-- what a category has used are all worked out by the queries that show them.

-- One row: what comes in each month.
CREATE TABLE IF NOT EXISTS plan (
  id      INTEGER PRIMARY KEY,
  income  REAL NOT NULL DEFAULT 0
);

-- A place money goes, with the most it should take each month.
CREATE TABLE IF NOT EXISTS categories (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  monthly_limit  REAL NOT NULL DEFAULT 0,
  position       INTEGER NOT NULL DEFAULT 0
);

-- One row per thing spent. Times are UTC text; the page shows them as words.
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  amount       REAL NOT NULL CHECK (amount > 0),
  note         TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS transactions_by_category
  ON transactions (category_id, at);

-- Each category with what it has taken so far this month (UTC months).
CREATE VIEW IF NOT EXISTS category_month AS
SELECT
  c.id            AS id,
  c.name          AS name,
  c.position      AS position,
  c.monthly_limit AS monthly_limit,
  COALESCE((SELECT SUM(t.amount)
              FROM transactions t
             WHERE t.category_id = c.id
               AND strftime('%Y-%m', t.at) = strftime('%Y-%m', 'now')), 0) AS spent,
  (SELECT count(*) FROM transactions x WHERE x.category_id = c.id) AS entries_ever
FROM categories c;

--- file: index.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="description" content="Plan your month and see what each category has left" />
  <meta name="dai:does" content="Set a monthly limit for each spending category" />
  <meta name="dai:does" content="Log what you spend and watch each category fill up" />
  <meta name="dai:does" content="See what is left this month and what is still unplanned" />
  <meta name="theme-color" content="#f6f7f3" />
  <title>Budget</title>
  <link rel="icon" href="./icon.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="./app.css" />
</head>
<body>
  <!-- Starting rows. The tables are declared in schema.sql; this block runs once, when the document is created. -->
  <script type="application/sql">
    INSERT INTO plan (income) VALUES (3200);

    INSERT INTO categories (name, monthly_limit, position) VALUES
      ('Housing', 1200, 1),
      ('Groceries', 450, 2),
      ('Transport', 180, 3),
      ('Eating out', 150, 4),
      ('Fun', 120, 5),
      ('Savings', 500, 6);

    INSERT INTO transactions (category_id, amount, note, at)
    SELECT c.id, s.amount, s.note,
           max(datetime('now', 'start of month'), datetime('now', s.ago))
      FROM (
        SELECT 'Housing' AS cat, 1200.0 AS amount, 'Rent' AS note, '-5 days' AS ago
        UNION ALL SELECT 'Groceries', 86.40, 'Weekly shop', '-4 days'
        UNION ALL SELECT 'Groceries', 54.20, 'Farmers market', '-1 day'
        UNION ALL SELECT 'Transport', 38.00, 'Fuel', '-3 days'
        UNION ALL SELECT 'Transport', 24.50, 'Bus pass top-up', '-6 hours'
        UNION ALL SELECT 'Eating out', 41.30, 'Dinner with friends', '-2 days'
        UNION ALL SELECT 'Eating out', 62.80, 'Birthday lunch', '-1 day'
        UNION ALL SELECT 'Eating out', 38.00, 'Takeout', '-2 hours'
        UNION ALL SELECT 'Fun', 138.00, 'Concert tickets', '-3 days'
        UNION ALL SELECT 'Savings', 200.00, 'Moved to savings', '-4 days'
      ) s
      JOIN categories c ON c.name = s.cat;
  </script>

  <main>
    <header>
      <dai-rows class="plain" query="
        SELECT
          CASE strftime('%m', 'now')
            WHEN '01' THEN 'January' WHEN '02' THEN 'February' WHEN '03' THEN 'March'
            WHEN '04' THEN 'April'   WHEN '05' THEN 'May'      WHEN '06' THEN 'June'
            WHEN '07' THEN 'July'    WHEN '08' THEN 'August'   WHEN '09' THEN 'September'
            WHEN '10' THEN 'October' WHEN '11' THEN 'November' ELSE 'December'
          END || ' ' || strftime('%Y', 'now') AS month_label,
          CASE WHEN left_amt < 0 THEN '-$' || printf('%.2f', -left_amt)
               ELSE printf('$%.2f', left_amt) END AS left_text,
          printf('$%.2f', spent) AS spent_text,
          CASE WHEN free >= 0
               THEN printf('$%.2f of your income has no category limit yet', free)
               ELSE printf('Limits total $%.2f more than your income', -free) END AS free_text,
          left_amt < 0 AS negative
        FROM (
          SELECT round(income - spent, 2) AS left_amt, spent, round(income - planned, 2) AS free
          FROM (
            SELECT
              COALESCE((SELECT income FROM plan ORDER BY id LIMIT 1), 0) AS income,
              COALESCE((SELECT SUM(amount) FROM transactions
                         WHERE strftime('%Y-%m', at) = strftime('%Y-%m', 'now')), 0) AS spent,
              COALESCE((SELECT SUM(monthly_limit) FROM categories), 0) AS planned
          )
        )">
        <template>
          <div class="hero">
            <p class="eyebrow" data-text="month_label"></p>
            <h1>Budget</h1>
            <p class="hero-label">Left this month</p>
            <p class="hero-num" data-text="left_text"></p>
            <p class="hero-sub"><span data-text="spent_text"></span> spent so far</p>
            <p class="hero-free" data-text="free_text"></p>
            <span class="neg" data-when="negative"></span>
          </div>
        </template>
      </dai-rows>

      <dai-rows class="plain" query="SELECT id, printf('%.2f', income) AS income_edit FROM plan ORDER BY id LIMIT 1">
        <template>
          <label class="income">
            <span>Income each month</span>
            <input
              inputmode="decimal"
              autocomplete="off"
              data-text="income_edit"
              data-run="UPDATE plan SET income = CAST(REPLACE(REPLACE(:typed, '$', ''), ',', '') AS REAL) WHERE id = :id"
            />
          </label>
        </template>
      </dai-rows>
    </header>

    <section>
      <h2>Categories</h2>
      <dai-rows class="cats" empty="No categories yet. Add your first one below." query="
        SELECT
          id,
          name,
          printf('%.2f', monthly_limit) AS limit_edit,
          printf('$%.2f of $%.2f', spent, monthly_limit) AS spent_of,
          CASE WHEN round(spent, 2) > round(monthly_limit, 2)
               THEN printf('$%.2f over', spent - monthly_limit)
               ELSE printf('$%.2f left', monthly_limit - spent) END AS status,
          replace(hex(zeroblob(f)), '00', '▰') || replace(hex(zeroblob(10 - f)), '00', '▱') AS bar,
          round(spent, 2) > round(monthly_limit, 2) AS is_over,
          entries_ever = 0 AS removable
        FROM (
          SELECT id, name, position, monthly_limit, spent, entries_ever,
                 CAST(CASE WHEN monthly_limit > 0 THEN min(10, round(10.0 * spent / monthly_limit))
                           WHEN spent > 0 THEN 10
                           ELSE 0 END AS INTEGER) AS f
          FROM category_month
        )
        ORDER BY position, name">
        <template>
          <div class="cat">
            <div class="cat-head">
              <input
                class="name"
                aria-label="Category name"
                maxlength="40"
                data-text="name"
                data-run="UPDATE categories SET name = trim(:typed) WHERE id = :id AND trim(:typed) &lt;&gt; ''"
              />
              <span class="status" data-text="status"></span>
            </div>
            <div class="bar" aria-hidden="true" data-text="bar"></div>
            <p class="spent-of" data-text="spent_of"></p>
            <div class="controls">
              <label class="field">
                <span>Monthly limit</span>
                <input
                  inputmode="decimal"
                  autocomplete="off"
                  data-text="limit_edit"
                  data-run="UPDATE categories SET monthly_limit = CAST(REPLACE(REPLACE(:typed, '$', ''), ',', '') AS REAL) WHERE id = :id"
                />
              </label>
              <label class="field">
                <span>Add spending</span>
                <input
                  inputmode="decimal"
                  autocomplete="off"
                  placeholder="Amount, then Enter"
                  data-run="INSERT INTO transactions (category_id, amount) SELECT :id, CAST(REPLACE(REPLACE(:typed, '$', ''), ',', '') AS REAL) WHERE CAST(REPLACE(REPLACE(:typed, '$', ''), ',', '') AS REAL) &gt; 0"
                />
              </label>
              <span data-when="removable">
                <button type="button" class="link" data-run="DELETE FROM categories WHERE id = :id AND NOT EXISTS (SELECT 1 FROM transactions WHERE category_id = :id)">Remove</button>
              </span>
            </div>
            <span class="over" data-when="is_over"></span>
          </div>
        </template>
      </dai-rows>

      <dai-form class="add" run="INSERT INTO categories (name, monthly_limit, position) VALUES (trim(:name), CAST(REPLACE(REPLACE(:limit, '$', ''), ',', '') AS REAL), (SELECT COALESCE(MAX(position), 0) + 1 FROM categories))">
        <input name="name" aria-label="New category name" placeholder="New category, like Health" required maxlength="40" />
        <input name="limit" aria-label="Monthly limit for the new category" inputmode="decimal" autocomplete="off" placeholder="Monthly limit" />
        <button>Add</button>
      </dai-form>
      <p class="hint">A category can be removed until it has spending in it.</p>
    </section>

    <section>
      <h2>Spending this month</h2>
      <dai-rows class="entries" empty="Nothing spent yet this month. Type an amount under any category above." query="
        SELECT
          t.id AS id,
          t.note AS note,
          printf('$%.2f', t.amount) AS amount_text,
          c.name || ' · ' ||
          CASE WHEN date(t.at) = date('now') THEN 'Today'
               WHEN date(t.at) = date('now', '-1 day') THEN 'Yesterday'
               ELSE substr('JanFebMarAprMayJunJulAugSepOctNovDec',
                           (CAST(strftime('%m', t.at) AS INTEGER) - 1) * 3 + 1, 3)
                    || ' ' || CAST(strftime('%d', t.at) AS INTEGER)
          END AS meta
        FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE strftime('%Y-%m', t.at) = strftime('%Y-%m', 'now')
        ORDER BY t.at DESC
        LIMIT 40">
        <template>
          <div class="entry">
            <div class="entry-main">
              <span class="entry-meta" data-text="meta"></span>
              <input
                class="note"
                aria-label="Note"
                placeholder="Add a note"
                maxlength="80"
                data-text="note"
                data-run="UPDATE transactions SET note = :typed WHERE id = :id"
              />
            </div>
            <span class="amount" data-text="amount_text"></span>
            <button type="button" class="x" aria-label="Remove this entry" data-run="DELETE FROM transactions WHERE id = :id">×</button>
          </div>
        </template>
      </dai-rows>
    </section>

    <footer>
      <button type="button" id="share" class="ghost">Share</button>
      <dai-save>Save</dai-save>
    </footer>
  </main>

  <script type="module">
    // Sharing is the host's: this only opens its share sheet.
    const share = document.getElementById("share");
    share.addEventListener("click", () => {
      if (window.dai && typeof window.dai.requestShare === "function") {
        window.dai.requestShare();
      }
    });
  </script>
  <script type="module" src="./dai-kit.js"></script>
</body>
</html>

--- file: app.css
/* Budget: calm greens on paper, one column that grows. */
:root {
  --paper: #f6f7f3;
  --ground: #e8ebe4;
  --card: #ffffff;
  --ink: #1b2b25;
  --muted: #66756d;
  --line: #dfe5df;
  --accent: #1f7a5a;
  --accent-ink: #ffffff;
  --bad: #b4372e;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :root {
    --paper: #121815;
    --ground: #0b100d;
    --card: #1a231e;
    --ink: #e9efea;
    --muted: #93a39a;
    --line: #2b3831;
    --accent: #4fbf93;
    --accent-ink: #08221a;
    --bad: #ff8f84;
  }
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100%;
  background: var(--paper);
  color: var(--ink);
}

body {
  font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

/* Color runs to every edge; content is pushed clear of what the phone covers. */
main {
  max-width: 600px;
  margin: 0 auto;
  padding: calc(28px + var(--dai-safe-top, 0px)) calc(18px + var(--dai-safe-right, 0px))
    calc(40px + var(--dai-safe-bottom, 0px)) calc(18px + var(--dai-safe-left, 0px));
  display: flex;
  flex-direction: column;
  gap: 26px;
}

header { display: flex; flex-direction: column; gap: 14px; }
section { display: flex; flex-direction: column; gap: 10px; }

h1 {
  margin: 0;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
}

h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}

p { margin: 0; }

dai-rows { display: block; color: var(--muted); font-size: 15px; }
dai-rows.plain { font-size: inherit; color: inherit; }

:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* The summary. */
.hero {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 22px 20px;
  border-radius: 20px;
  background: var(--accent);
  color: var(--accent-ink);
}

.hero:has(.neg:not([hidden])) { background: var(--bad); }

.eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  opacity: 0.85;
}

.hero-label { margin-top: 14px; font-size: 14px; opacity: 0.9; }

.hero-num {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.1;
  overflow-wrap: anywhere;
}

.hero-sub { font-size: 15px; }
.hero-free { margin-top: 10px; font-size: 13px; opacity: 0.9; }
.neg { display: none; }

/* Income. */
.income {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  color: var(--ink);
}

.income input {
  width: 9em;
  max-width: 50%;
  text-align: right;
}

input {
  min-height: 44px;
  padding: 8px 12px;
  font: inherit;
  font-size: 16px;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 10px;
  min-width: 0;
}

.income input { background: transparent; border-color: transparent; }
.income input:hover, .income input:focus { border-color: var(--line); }

/* Categories. */
.cats { display: flex; flex-direction: column; gap: 10px; }
.cats > * + * { margin-top: 10px; }

.cat {
  padding: 14px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  color: var(--ink);
}

.cat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

input.name {
  flex: 1 1 auto;
  padding-left: 0;
  font-size: 18px;
  font-weight: 600;
  background: transparent;
  border-color: transparent;
}

input.name:hover, input.name:focus { border-color: var(--line); padding-left: 12px; }

.status { flex: 0 0 auto; font-size: 14px; font-weight: 600; color: var(--muted); }
.cat:has(.over:not([hidden])) .status { color: var(--bad); }

.bar {
  margin-top: 2px;
  font-size: 15px;
  letter-spacing: 2px;
  white-space: nowrap;
  overflow: hidden;
  color: var(--accent);
}

.cat:has(.over:not([hidden])) .bar { color: var(--bad); }

.spent-of { margin-top: 2px; font-size: 13px; color: var(--muted); }
.over { display: none; }

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-top: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 130px;
  min-width: 0;
}

.field span { font-size: 12px; font-weight: 600; color: var(--muted); }
.field input { width: 100%; }

button {
  min-height: 44px;
  min-width: 44px;
  padding: 10px 16px;
  font: inherit;
  font-weight: 600;
  border: 0;
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  cursor: pointer;
}

button.link {
  padding: 10px 6px;
  background: none;
  color: var(--muted);
  font-size: 14px;
  font-weight: 500;
  text-decoration: underline;
}

button.link:hover { color: var(--bad); }

/* Add a category. */
dai-form.add { display: flex; flex-wrap: wrap; gap: 8px; }
dai-form.add input { flex: 1 1 150px; }
dai-form.add input[name="limit"] { flex: 1 1 110px; }
dai-form.add button { flex: 0 0 auto; }

.hint { font-size: 13px; color: var(--muted); }

/* Spending. */
.entry {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--line);
  color: var(--ink);
}

.entry:first-child { border-top: 0; }

.entry-main { display: flex; flex-direction: column; min-width: 0; }
.entry-meta { font-size: 12px; font-weight: 600; color: var(--muted); }

input.note {
  width: 100%;
  padding-left: 0;
  background: transparent;
  border-color: transparent;
}

input.note:hover, input.note:focus { border-color: var(--line); padding-left: 12px; }

.amount { font-weight: 600; font-variant-numeric: tabular-nums; }

button.x {
  padding: 0;
  background: none;
  color: var(--muted);
  font-size: 22px;
  line-height: 1;
}

button.x:hover { color: var(--bad); }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

button.ghost {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--line);
}

dai-save { display: inline-block; padding: 12px 22px; border-radius: 10px; background: var(--accent); color: var(--accent-ink); font-weight: 600; cursor: pointer; }

/* On a wide window the same column becomes a card on a quieter ground. */
@media (min-width: 720px) {
  html, body { background: var(--ground); }
  main {
    margin: 40px auto;
    padding: 36px 36px 40px;
    background: var(--paper);
    border-radius: 24px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.04), 0 24px 60px -20px rgb(0 0 0 / 0.2);
  }
}

--- file: icon.svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <!-- A pie split into categories. -->
  <rect width="100" height="100" rx="22" fill="#1f7a5a"/>
  <circle cx="50" cy="50" r="30" fill="#f6f7f3"/>
  <path d="M50 50 L50 20 A30 30 0 0 1 80 50 Z" fill="#f5b942"/>
  <path d="M50 50 L80 50 A30 30 0 0 1 35 76 Z" fill="#0f4d38"/>
</svg>
```
