// Receipts — a passable document. Shared rows are written through
// window.dai.replicated and read from receipts_current; totals are derived,
// never stored; a merge redraws; a conflict is shown, not decided silently.

const $ = (id) => document.getElementById(id);
const db = await window.dai.openDatabase();
const shared = window.dai.replicated;

/** The entity of the receipt being edited, or null when adding. */
let editing = null;

const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));

function myName() {
  return rows("SELECT name FROM me WHERE id = 1")[0]?.name ?? "";
}

function money(cents) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function dayWords(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return day.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function todayYmd() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function say(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

/** Runs a shared write and says what went wrong, rather than failing silently. */
function write(fn) {
  try {
    fn();
    say("");
    return true;
  } catch (error) {
    const message = String(error?.message ?? error);
    say(
      message.startsWith("WRITE_SURFACE_UNAVAILABLE")
        ? "Open this document in the DAI opener to add or change receipts."
        : `That did not save: ${message}`,
    );
    return false;
  }
}

// ---- drawing ------------------------------------------------------------

function drawBalance() {
  // Derived from the rows every time. Nothing here is stored.
  const people = rows(
    "SELECT paid_by, sum(cents) AS paid FROM receipts_current GROUP BY paid_by ORDER BY paid DESC",
  );
  const box = $("balance");
  box.replaceChildren();
  if (people.length === 0) return;
  const total = people.reduce((sum, p) => sum + p.paid, 0);
  const share = total / people.length;

  const headline = document.createElement("p");
  headline.className = "total";
  headline.textContent = `${money(total)} spent`;
  box.append(headline);

  for (const person of people) {
    const line = document.createElement("p");
    const over = person.paid - share;
    line.textContent =
      people.length === 1
        ? `${person.paid_by} paid all of it`
        : `${person.paid_by} paid ${money(person.paid)} · ${
            Math.abs(over) < 1 ? "even" : over > 0 ? `is owed ${money(over)}` : `owes ${money(-over)}`
          }`;
    box.append(line);
  }
}

function drawList() {
  const list = $("list");
  list.replaceChildren();
  const receipts = rows(
    `SELECT lower(hex(_r_entity)) AS entity, spent_on, store, cents, paid_by, _r_conflicted AS conflicted
       FROM receipts_current
      ORDER BY spent_on DESC, store`,
  );
  $("empty").hidden = receipts.length > 0;

  for (const r of receipts) {
    const item = document.createElement("li");
    item.className = r.conflicted ? "receipt conflicted" : "receipt";

    const main = document.createElement("div");
    main.className = "what";
    const store = document.createElement("strong");
    store.textContent = r.store;
    const meta = document.createElement("span");
    meta.textContent = `${dayWords(r.spent_on)} · ${r.paid_by}`;
    main.append(store, meta);

    const amount = document.createElement("span");
    amount.className = "amount";
    amount.textContent = money(r.cents);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (r.conflicted) {
      const choose = button("Changed twice — choose", () => openConflict(r.entity));
      choose.className = "warn";
      actions.append(choose);
    }
    actions.append(
      button("Edit", () => startEdit(r)),
      button("Delete", () => write(() => shared.remove("receipts", r.entity)) && draw()),
    );

    item.append(main, amount, actions);
    list.append(item);
  }
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "quiet";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function draw() {
  $("me").value = myName();
  if (!editing && !$("paid-by").value) $("paid-by").value = myName();
  drawBalance();
  drawList();
}

// ---- adding and editing -------------------------------------------------

function readForm() {
  const amount = Number.parseFloat($("amount").value.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    say("Enter the amount as a number, like 12.50.");
    return null;
  }
  return {
    spent_on: $("spent-on").value,
    store: $("store").value.trim(),
    cents: Math.round(amount * 100),
    paid_by: $("paid-by").value.trim(),
  };
}

function resetForm() {
  editing = null;
  $("entry").reset();
  $("spent-on").value = todayYmd();
  $("paid-by").value = myName();
  $("entry-title").textContent = "Add a receipt";
  $("save-entry").textContent = "Add";
  $("cancel-edit").hidden = true;
}

function startEdit(r) {
  editing = r.entity;
  $("spent-on").value = r.spent_on;
  $("store").value = r.store;
  $("amount").value = (r.cents / 100).toFixed(2);
  $("paid-by").value = r.paid_by;
  $("entry-title").textContent = "Edit receipt";
  $("save-entry").textContent = "Save changes";
  $("cancel-edit").hidden = false;
  $("store").focus();
}

$("entry").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = readForm();
  if (!values) return;
  // change() takes every column, not only the ones that changed.
  const ok = write(() =>
    editing ? shared.change("receipts", editing, values) : shared.insert("receipts", values),
  );
  if (ok) {
    resetForm();
    draw();
  }
});

$("cancel-edit").addEventListener("click", () => resetForm());

$("me").addEventListener("change", () => {
  // Local table: an ordinary UPDATE is right here.
  db.exec({ sql: "UPDATE me SET name = ? WHERE id = 1", bind: [$("me").value.trim()] });
  if (!editing) $("paid-by").value = myName();
});

$("share").addEventListener("click", () => window.dai.requestShare());

// ---- conflicts ----------------------------------------------------------

function openConflict(entity) {
  // The competing versions are the current heads of this entity. A tombstone
  // among them means the other copy deleted it while this one edited it.
  const versions = rows(
    `SELECT spent_on, store, cents, paid_by, _r_deleted AS deleted
       FROM receipts_heads WHERE lower(hex(_r_entity)) = ?
      ORDER BY _r_lc DESC`,
    [entity],
  );
  const list = $("versions");
  list.replaceChildren();
  for (const v of versions) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = v.deleted
      ? "Deleted on one copy"
      : `${v.store} · ${money(v.cents)} · ${dayWords(v.spent_on)} · ${v.paid_by}`;
    const keep = button(v.deleted ? "Delete it" : "Keep this", () => {
      // Writing the choice resolves the conflict: a change or a remove names
      // every current version as its parent.
      const ok = write(() =>
        v.deleted
          ? shared.remove("receipts", entity)
          : shared.change("receipts", entity, {
              spent_on: v.spent_on,
              store: v.store,
              cents: v.cents,
              paid_by: v.paid_by,
            }),
      );
      if (ok) {
        $("conflict").close();
        draw();
      }
    });
    item.append(text, keep);
    list.append(item);
  }
  $("conflict").showModal();
}

$("conflict-close").addEventListener("click", () => $("conflict").close());

// ---- the other copy's rows ----------------------------------------------

// Nothing else says the other person's receipts arrived.
window.addEventListener("dai:merged", () => draw());

resetForm();
draw();
