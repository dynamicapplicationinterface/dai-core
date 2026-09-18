/**
 * dai-kit — five elements, so an application can be HTML and SQL.
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
  // The runtime runs these when the database opens and marks each one; a
  // container from before it did leaves them unmarked, and the kit still runs
  // those. Never twice.
  if (block.getAttribute('data-dai-ran') === '1') continue;
  block.setAttribute('data-dai-ran', '1');
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
  // Walked rather than matched with one regular expression, because a colon
  // inside a string literal is not a parameter: strftime('%H:%M') was read
  // as two bindings and threw on the first tap, in the first application a
  // model wrote with this kit — a medicine log, which is all times.
  const names = [];
  const isStart = (c) => /[a-zA-Z_]/.test(c);
  const isPart = (c) => /[a-zA-Z0-9_]/.test(c);
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === String.fromCharCode(96)) {
      // A literal or a quoted identifier, to its matching quote; a doubled
      // quote inside is an escaped quote, not the end.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf(String.fromCharCode(10), i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (c === ":" && sql[i + 1] !== ":" && sql[i - 1] !== ":" && isStart(sql[i + 1] || "")) {
      let j = i + 2;
      while (j < sql.length && isPart(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      if (!names.includes(name)) names.push(name);
      i = j;
      continue;
    }
    i++;
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

  // Somebody did something. The shell is told, and tells the host once: the
  // first use is the moment an offer to keep this document stops being an
  // interruption, and it is the number the whole thing is judged on.
  try {
    window.parent.postMessage({ type: 'dai:used' }, '*');
  } catch (error) {
    /* No parent, or one that is not listening. Neither changes the statement. */
  }
}

/** Fills an element's [data-text] descendants from a row. */
function fill(element, row) {
  const targets = element.querySelectorAll('[data-text]');
  for (const target of targets) {
    const column = target.getAttribute('data-text');
    const value = row[column];
    const text = value === null || value === undefined ? '' : String(value);

    /*
     * A control shows its value; everything else shows its text.
     *
     * Setting textContent on an input puts the text somewhere nobody can see
     * and leaves the box empty, which is the whole of what somebody looking at
     * it would call broken. This is the reading half of :typed — one attribute
     * fills the box and sends back what was typed into it.
     *
     * Named, not detected. "Has a value property" was the first test, and
     * <li>, <button>, <progress>, <meter> and <data> all have one that shows
     * nothing — so <li data-text="title">, the most natural line in a list,
     * set a number on the item and left it blank. A control is one of three.
     */
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') target.value = text;
    // textContent rather than innerHTML, always: a value in the database is
    // somebody's text and must not become markup.
    else target.textContent = text;
  }

  /*
   * A picture that lives in the document (backlog 4.5).
   *
   * A blob column holds the bytes, so a photo goes wherever the document goes:
   * exported, mailed, opened on another device, still there. Rendered through
   * an object URL rather than a data URL — a data URL of a photograph is a
   * megabyte of string in the DOM, and the object URL is revoked when the row
   * is redrawn, so a list that refreshes does not leak one per redraw.
   */
  const pictures = element.querySelectorAll('[data-blob]');
  for (const target of pictures) {
    const bytes = row[target.getAttribute('data-blob')];
    if (target.src && target.src.startsWith('blob:')) URL.revokeObjectURL(target.src);
    if (!bytes || !bytes.length) {
      target.removeAttribute('src');
      target.hidden = true;
      continue;
    }
    target.hidden = false;
    target.src = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  }

  const conditionals = element.querySelectorAll('[data-when]');
  for (const target of conditionals) {
    target.hidden = !row[target.getAttribute('data-when')];
  }
}

/**
 * Lets go of the object URLs under a node that is coming down.
 *
 * A row's picture is an object URL (see fill), and a redraw makes new rows
 * rather than refilling the old ones — so the URLs the old rows held were
 * never revoked, and a list of photographs that refreshed on every edit
 * kept every photograph it had ever shown.
 */
function release(node) {
  if (!node || !node.querySelectorAll) return;
  const held = node.matches && node.matches('[data-blob]') ? [node, ...node.querySelectorAll('[data-blob]')] : node.querySelectorAll('[data-blob]');
  for (const target of held) {
    if (target.src && target.src.startsWith('blob:')) URL.revokeObjectURL(target.src);
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

      /*
       * What somebody typed into this control, as :typed.
       *
       * Without it there is no way for an application to change a value in
       * place — only to add a row and to toggle one — because a data-run
       * carried the row it was drawn from and the attributes written into the
       * document, and never the thing in front of the person. A packing list
       * could tick an item off and could not change the dates of the trip.
       *
       * Named :typed rather than :value so it cannot quietly shadow a column
       * called value in the row this was drawn from. A checkbox is left out:
       * its value is the string "on" whether it is ticked or not, and the
       * useful thing about one is already how a toggle is written.
       */
      if (trigger.type !== 'checkbox' && (trigger.tagName === 'INPUT' || trigger.tagName === 'TEXTAREA' || trigger.tagName === 'SELECT')) withOwn.typed = trigger.value;

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
    release(this);
  }

  draw() {
    if (!this.template) return;
    const rows = db.selectObjects(this.getAttribute('query'));

    const empty = this.getAttribute('empty');
    while (this.lastChild && this.lastChild !== this.template) {
      release(this.lastChild);
      this.removeChild(this.lastChild);
    }

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

/**
 * The largest a picture may be once this has finished with it.
 *
 * A document is a thing people send each other, and a phone camera produces
 * four megabytes without being asked. Every attachment is scaled to fit inside
 * a square of `max` pixels and re-encoded as JPEG before it goes anywhere
 * near the database, which takes a modern phone photo to something in the tens
 * of kilobytes. Anything still over the cap after that is refused out loud
 * rather than quietly making a document nobody can mail.
 */
const ATTACH_MAX_PIXELS = 1280;
const ATTACH_CAP_BYTES = 512 * 1024;

/** Scales a picture to fit, and returns JPEG bytes. */
async function downscale(file, maxPixels) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPixels / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', 0.8));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * A picture, into the document itself (backlog 4.5).
 *
 *     <dai-attach run="UPDATE entries SET photo = :file WHERE id = :id" data-id="3">
 *       Add a photo
 *     </dai-attach>
 *
 * `:file` is bound to the scaled bytes; every other parameter comes from the
 * row it was drawn in and from its own data- attributes, exactly as data-run
 * does. Inside a dai-rows template that means one attribute and nothing else.
 *
 * The picture goes into a blob column, which is to say into the document —
 * not into a folder beside it, not to a server. That is the whole point: a
 * photograph attached on one device is in the file that arrives on the other.
 */
class DaiAttach extends HTMLElement {
  connectedCallback() {
    if (!this.textContent.trim()) this.textContent = 'Add a photo';
    this.setAttribute('role', 'button');
    this.setAttribute('tabindex', '0');

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    this.appendChild(input);

    const say = (message) => {
      const before = this.firstChild;
      if (before && before.nodeType === 3) before.textContent = message;
    };
    const label = this.firstChild && this.firstChild.nodeType === 3 ? this.firstChild.textContent : '';

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;

      say('Adding…');
      try {
        const max = Number(this.getAttribute('max')) || ATTACH_MAX_PIXELS;
        const bytes = await downscale(file, max);
        if (bytes.length > ATTACH_CAP_BYTES) {
          say('That picture is too large to put in this document');
          return;
        }

        const values = { file: bytes };
        for (const attribute of this.attributes) {
          if (attribute.name.startsWith('data-')) values[attribute.name.slice(5)] = attribute.value;
        }
        run(this.getAttribute('run'), values);
        say(label);
      } catch (error) {
        say('That file could not be read as a picture');
      }
    });

    const pick = () => input.click();
    this.addEventListener('click', (event) => {
      if (event.target !== input) pick();
    });
    this.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') pick();
    });
  }
}

/**
 * Writes the database back into the file — where that takes a gesture.
 *
 * Under a host every write is already saved as it happens, and a Save button
 * beside that is a question with no good answer; the element removes itself.
 * It stays for a file opened straight in a browser, where the browser insists
 * a write to disk begins with a tap.
 */
class DaiSave extends HTMLElement {
  connectedCallback() {
    if (window.dai.autosaves) {
      this.hidden = true;
      return;
    }
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
customElements.define('dai-attach', DaiAttach);
customElements.define('dai-save', DaiSave);

// Anything outside these four is ordinary JavaScript against window.dai, which
// is still there. This is a shortcut, not a framework.
window.daiKit = { db: db, run: run, refresh: refresh };
