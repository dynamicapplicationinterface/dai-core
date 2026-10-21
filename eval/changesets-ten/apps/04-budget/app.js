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
