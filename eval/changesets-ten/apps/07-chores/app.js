// The kit draws and writes everything on the page. This script does the two
// things it cannot: fill the "who does it" menu from the people table, and
// wire the Share button. It holds no state of its own; the database is the state.

const opening = document.getElementById("opening");
const app = document.getElementById("app");

try {
  const db = await window.dai.database();
  const select = document.getElementById("who");
  const peopleList = document.getElementById("people-list");
  let shown = "";

  async function fillPeople() {
    const people = await db.query("SELECT id, emoji, name FROM people ORDER BY name");
    const signature = JSON.stringify(people);
    if (signature === shown) return;
    shown = signature;
    const keep = select.value;
    select.replaceChildren(
      ...people.map((p) => {
        const option = document.createElement("option");
        option.value = String(p.id);
        option.textContent = p.emoji + " " + p.name;
        return option;
      })
    );
    if (people.some((p) => String(p.id) === keep)) select.value = keep;
  }

  await fillPeople();

  // The kit redraws the people list after every write to it; follow it.
  new MutationObserver(() => {
    fillPeople().catch(() => {});
  }).observe(peopleList, { childList: true, subtree: true, characterData: true });

  window.addEventListener("dai:merged", () => {
    fillPeople().catch(() => {});
    if (window.daiKit) window.daiKit.refresh();
  });

  document.getElementById("share").addEventListener("click", () => {
    window.dai.requestShare();
  });

  opening.hidden = true;
  app.hidden = false;
  app.inert = false;
  app.removeAttribute("hidden");
  app.removeAttribute("inert");
} catch (err) {
  opening.textContent =
    "The chart could not open: " +
    (err && err.message ? err.message : String(err)) +
    ". Close this document and open it again.";
  opening.setAttribute("role", "alert");
}
