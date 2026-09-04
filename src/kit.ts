/**
 * Four elements, so an application can be HTML and SQL.
 *
 * Most of what a model gets wrong is not the idea, it is the wiring: query the
 * database, build the DOM, attach a handler, mutate, remember to redraw. That
 * loop is written from scratch in every application, it is where the mistakes
 * are, and none of it is the part anybody wanted.
 *
 * So it is written once here:
 *
 *     <dai-rows query="SELECT id, title, done FROM tasks ORDER BY id">
 *       <template>
 *         <li>
 *           <input type="checkbox" data-run="UPDATE tasks SET done = 1 - done WHERE id = :id">
 *           <span data-text="title"></span>
 *         </li>
 *       </template>
 *     </dai-rows>
 *
 *     <dai-value query="SELECT count(*) AS n FROM tasks WHERE done = 0"></dai-value>
 *
 *     <dai-form run="INSERT INTO tasks (title) VALUES (:title)">
 *       <input name="title" required>
 *       <button>Add</button>
 *     </dai-form>
 *
 *     <dai-save>Save</dai-save>
 *
 * The schema goes in the document too, so an application can have no JavaScript
 * at all:
 *
 *     <script type="application/sql">
 *       CREATE TABLE IF NOT EXISTS tasks (
 *         id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
 *       );
 *     </script>
 *
 * Two rules are enforced rather than advised, because they are the two that
 * matter and the two nobody remembers under time pressure.
 *
 * Parameters are always bound and never interpolated. There is no way to build
 * a statement out of a value in this kit, which removes the injection that a
 * model writing string concatenation would otherwise reintroduce every time.
 *
 * Values are written with textContent, never as markup. A task titled
 * `<img onerror=…>` is a task with an odd name, not script — and since a
 * container's whole promise is that it is safe to open something a stranger
 * sent, that has to be true of what the application renders as well as of what
 * the format seals.
 *
 * It is not a framework and should not become one. Anything an application
 * needs beyond these four is written in ordinary JavaScript against
 * `window.dai`, which is still there.
 */

/**
 * The kit, as source.
 *
 * Kept as a string rather than a file so there is one copy: the compiler ships
 * it into every container, the tests exercise it, and the recipe describes it.
 * A second copy on disk would be a second version of the answer.
 */
export const KIT_SOURCE = `/**
 * dai-kit — four elements, so an application can be HTML and SQL.
 *
 * Shipped inside every container. Reference it with:
 *   <script type="module" src="./dai-kit.js"></script>
 */
const db = await window.dai.openDatabase();

/*
 * The schema, run before anything reads.
 *
 * An unknown script type is not executed by the browser and not governed by the
 * policy — the same reason the container carries its payload that way — so this
 * is SQL sitting in the document rather than JavaScript that runs it. Without
 * it every application needs a script whose only job is CREATE TABLE, which has
 * to run before the elements draw and silently does not when somebody puts the
 * tags in the other order. That is the wiring this kit exists to remove, and
 * leaving one strand of it in place would be leaving the trap.
 */
for (const block of document.querySelectorAll('script[type="application/sql"]')) {
  db.exec(block.textContent);
}

/** Everything that reads from the database, so a change can redraw them all. */
const views = new Set();

/** Re-runs every query on the page. Called after anything writes. */
function refresh() {
  for (const view of views) view.draw();
}

/**
 * Reads :name parameters out of a statement.
 *
 * Bound, never interpolated: there is deliberately no way to build a statement
 * out of a value here.
 */
function parametersIn(sql) {
  const names = [];
  const pattern = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let found = pattern.exec(sql);
  while (found) {
    if (!names.includes(found[1])) names.push(found[1]);
    found = pattern.exec(sql);
  }
  return names;
}

/** Runs a statement, binding each :name from the values it was given. */
function run(sql, values) {
  const names = parametersIn(sql);
  const bind = {};
  for (const name of names) {
    if (!(name in values)) {
      throw new Error('dai-kit: nothing to bind for :' + name + ' in ' + sql);
    }
    bind[':' + name] = values[name];
  }
  if (names.length === 0) db.exec(sql);
  else db.exec({ sql: sql, bind: bind });
  refresh();
}

/** Fills an element's [data-text] descendants from a row. */
function fill(element, row) {
  const targets = element.querySelectorAll('[data-text]');
  for (const target of targets) {
    const column = target.getAttribute('data-text');
    const value = row[column];
    // textContent rather than innerHTML, always: a value in the database is
    // somebody's text and must not become markup.
    target.textContent = value === null || value === undefined ? '' : String(value);
  }

  const conditionals = element.querySelectorAll('[data-when]');
  for (const target of conditionals) {
    target.hidden = !row[target.getAttribute('data-when')];
  }
}

/** Wires every [data-run] inside a rendered row or the page. */
function wire(element, values) {
  const triggers = element.querySelectorAll('[data-run]');
  for (const trigger of triggers) {
    const sql = trigger.getAttribute('data-run');
    const event = trigger.tagName === 'INPUT' || trigger.tagName === 'SELECT' ? 'change' : 'click';
    trigger.addEventListener(event, (e) => {
      if (trigger.tagName === 'BUTTON') e.preventDefault();
      const withOwn = Object.assign({}, values);
      for (const attribute of trigger.attributes) {
        if (attribute.name.startsWith('data-') && attribute.name !== 'data-run') {
          withOwn[attribute.name.slice(5)] = attribute.value;
        }
      }
      run(sql, withOwn);
    });
  }
}

/** A row per result, from a template. */
class DaiRows extends HTMLElement {
  connectedCallback() {
    this.template = this.querySelector('template');
    views.add(this);
    this.draw();
  }

  disconnectedCallback() {
    views.delete(this);
  }

  draw() {
    if (!this.template) return;
    const rows = db.selectObjects(this.getAttribute('query'));

    const empty = this.getAttribute('empty');
    while (this.lastChild && this.lastChild !== this.template) this.removeChild(this.lastChild);

    if (rows.length === 0 && empty) {
      const message = document.createElement('p');
      message.className = 'dai-empty';
      message.textContent = empty;
      this.appendChild(message);
      return;
    }

    for (const row of rows) {
      const copy = this.template.content.cloneNode(true);
      const holder = document.createElement('div');
      holder.appendChild(copy);
      fill(holder, row);
      wire(holder, row);
      while (holder.firstChild) this.appendChild(holder.firstChild);
    }
  }
}

/** One number or one string, from the first column of the first row. */
class DaiValue extends HTMLElement {
  connectedCallback() {
    views.add(this);
    this.draw();
  }

  disconnectedCallback() {
    views.delete(this);
  }

  draw() {
    const rows = db.selectObjects(this.getAttribute('query'));
    const row = rows[0];
    const value = row ? row[Object.keys(row)[0]] : '';
    this.textContent = value === null || value === undefined ? '' : String(value);
  }
}

/** A form whose fields become the parameters of one statement. */
class DaiForm extends HTMLElement {
  connectedCallback() {
    this.addEventListener('submit', (event) => event.preventDefault());

    const submit = () => {
      const values = {};
      const fields = this.querySelectorAll('[name]');
      for (const field of fields) {
        values[field.getAttribute('name')] =
          field.type === 'checkbox' ? (field.checked ? 1 : 0) : field.value;
      }

      for (const field of fields) {
        if (field.required && !String(values[field.getAttribute('name')]).trim()) {
          field.focus();
          return;
        }
      }

      run(this.getAttribute('run'), values);

      for (const field of fields) {
        if (field.type !== 'checkbox') field.value = '';
      }
    };

    const button = this.querySelector('button');
    if (button) button.addEventListener('click', submit);

    for (const field of this.querySelectorAll('input')) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
    }
  }
}

/** Writes the database back into the file. */
class DaiSave extends HTMLElement {
  connectedCallback() {
    if (!this.textContent.trim()) this.textContent = 'Save';
    this.setAttribute('role', 'button');
    this.setAttribute('tabindex', '0');

    const save = async () => {
      const before = this.textContent;
      this.textContent = 'Saving…';
      const result = await window.dai.saveDatabase(db);
      this.textContent = result.saved ? 'Saved' : before;
      if (result.saved) setTimeout(() => { this.textContent = before; }, 1500);
    };

    this.addEventListener('click', save);
    this.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') save();
    });
  }
}

customElements.define('dai-rows', DaiRows);
customElements.define('dai-value', DaiValue);
customElements.define('dai-form', DaiForm);
customElements.define('dai-save', DaiSave);

// Anything outside these four is ordinary JavaScript against window.dai, which
// is still there. This is a shortcut, not a framework.
window.daiKit = { db: db, run: run, refresh: refresh };
`;

/** Where the compiler puts it, and what an application references. */
export const KIT_ENTRY = "dai-kit.js";
