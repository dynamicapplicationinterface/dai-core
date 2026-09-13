// Agreement -- a session document. Each agreement is a session of two: the
// creator is the first party, the invitee takes the open seat. Terms,
// acceptances and seals are rows; the version, whether it is agreed, and who
// accepted what are derived every time they are drawn.

const $ = (id) => document.getElementById(id);
const db = await window.dai.openDatabase();
const shared = window.dai.replicated;
const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));
const one = (sql, bind) => rows(sql, bind)[0] ?? null;

/** The entity of the term whose wording is being edited on this screen. */
let editing = null;
/** Whether the seal confirmation is showing. */
let confirmingSeal = false;

function say(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}

/** Runs writes and says what went wrong, rather than failing silently. */
function write(fn) {
  try {
    const result = fn();
    say("");
    return result ?? true;
  } catch (error) {
    const message = String(error?.message ?? error);
    say(
      message.startsWith("WRITE_SURFACE_UNAVAILABLE")
        ? "Open this document in the DAI opener to make changes to the agreement."
        : `That did not save: ${message}`,
    );
    return false;
  }
}

function button(label, onClick, id, className = "quiet") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  if (id) b.id = id;
  b.addEventListener("click", onClick);
  return b;
}

// ---- reading ------------------------------------------------------------

/** This copy's replica id, or null before this copy has written anything. */
const myReplica = () => one("SELECT lower(hex(id)) AS id FROM _dai_replica")?.id ?? null;

function agreements() {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, lower(hex(_r_session)) AS session,
            title, first_party, second_party
       FROM agreements_current ORDER BY _r_lc`,
  );
}

function activeAgreement() {
  const list = agreements();
  const id = one("SELECT active_agreement FROM settings WHERE id = 1")?.active_agreement;
  return list.find((a) => a.id === id) ?? list[list.length - 1] ?? null;
}

/** Everything about the seats of a session, as this copy sees it. */
function seats(session) {
  const mine = myReplica();
  const creator = one(
    "SELECT lower(hex(_r_replica)) AS r FROM _dai_seat_current WHERE lower(hex(_r_session)) = ? LIMIT 1",
    [session],
  )?.r ?? null;
  const isMember = (replica) =>
    !!replica &&
    !!one(
      "SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?",
      [session, replica],
    );
  const bound = !!mine &&
    !!one(
      "SELECT 1 AS x FROM _dai_binding_current WHERE lower(hex(_r_session)) = ? AND lower(hex(_r_replica)) = ?",
      [session, mine],
    );
  const contested = rows(
    `SELECT 1 AS x FROM _dai_binding_current b
       JOIN _dai_seat_current s ON s._r_session = b._r_session AND s.seat = b.seat
      WHERE lower(hex(b._r_session)) = ?
      GROUP BY b.seat HAVING count(DISTINCT b._r_replica) > 1`,
    [session],
  ).length > 0;
  const openSeat = one(
    `SELECT lower(hex(s.seat)) AS seat FROM _dai_seat_current s
      WHERE lower(hex(s._r_session)) = ?
        AND s.seat NOT IN (SELECT b.seat FROM _dai_binding_current b WHERE b._r_session = s._r_session)
      LIMIT 1`,
    [session],
  )?.seat ?? null;
  const opponent = one(
    `SELECT lower(hex(replica)) AS r FROM _dai_member
      WHERE lower(hex(session)) = ? AND lower(hex(replica)) <> ? LIMIT 1`,
    [session, creator ?? ""],
  )?.r ?? null;
  const closed = !!one(
    "SELECT 1 AS x FROM _dai_close_current WHERE lower(hex(_r_session)) = ? LIMIT 1",
    [session],
  );
  const amCreator = !!mine && mine === creator;
  const member = isMember(mine);
  return {
    mine, creator, opponent, amCreator, member, closed, contested, openSeat,
    // Bound once, not admitted now: the seat was contested or replaced.
    seatLost: bound && !member,
    // Holds the rows but was never invited: forwarded, not joined.
    notIn: !amCreator && !bound,
  };
}

function termsOf(agreementId) {
  return rows(
    `SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_replica)) AS rep, _r_seq AS seq,
            body, position, _r_conflicted AS conflicted
       FROM terms_current WHERE agreement_id = ?
      ORDER BY position, lower(hex(_r_entity))`,
    [agreementId],
  );
}

/**
 * The version of an agreement: every live term, named by the exact row
 * version that is showing. Identical on every copy that holds the same rows,
 * and different after any add, edit or removal. Null while there is nothing
 * to accept, or while a term was changed on both copies and not yet settled.
 */
function versionOf(terms) {
  if (terms.length === 0 || terms.some((t) => t.conflicted)) return null;
  return terms
    .map((t) => `${t.entity}.${t.rep}.${t.seq}`)
    .sort()
    .join("|");
}

/** Derives everything about one agreement. Nothing here is stored. */
function state(a) {
  const s = seats(a.session);
  const terms = termsOf(a.id);
  const version = versionOf(terms);
  const accepts = rows(
    `SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_replica)) AS by, version
       FROM acceptances_current WHERE agreement_id = ?`,
    [a.id],
  );
  const acceptanceOf = (replica) => ({
    now: !!replica && !!version && accepts.some((x) => x.by === replica && x.version === version),
    before: !!replica && accepts.some((x) => x.by === replica),
  });
  const first = acceptanceOf(s.creator);
  const second = acceptanceOf(s.opponent);
  const agreed = !!version && !!s.creator && !!s.opponent && first.now && second.now;
  const sealed = s.closed;
  const canWrite = s.member && !sealed;
  const mineAccepted = acceptanceOf(s.mine).now;
  const myAcceptances = accepts.filter((x) => x.by === s.mine);
  return { seats: s, terms, version, first, second, agreed, sealed, canWrite, mineAccepted, myAcceptances };
}

// ---- joining ------------------------------------------------------------

/**
 * Take the open seat of the agreement showing, if this copy arrived with an
 * invite. Called at start-up and when a file or link is opened -- never on a
 * background mailbox merge. The sent copy carries the sender's local settings,
 * so the agreement showing is the one the invite was sent from.
 */
function joinIfInvited() {
  const a = activeAgreement();
  if (!a) return;
  const s = seats(a.session);
  if (s.member || s.amCreator || s.seatLost || !s.openSeat) return;
  write(() => shared.session.join(a.session, s.openSeat));
}

// ---- drawing ------------------------------------------------------------

function drawList() {
  const list = $("agreement-list");
  const current = activeAgreement();
  list.replaceChildren();
  for (const a of agreements()) {
    const option = document.createElement("option");
    option.value = a.id;
    option.textContent = a.title;
    option.selected = a.id === current?.id;
    list.append(option);
  }
  list.hidden = list.options.length < 2;
}

function drawStatus(a, st) {
  const status = $("agreement-status");
  let text;
  let stateName;
  if (st.sealed) {
    stateName = "sealed";
    text = "Sealed. Nothing in it can change.";
  } else if (st.agreed) {
    stateName = "agreed";
    text = "Agreed. You have both accepted this version. Either of you can seal it.";
  } else if (st.terms.some((t) => t.conflicted)) {
    stateName = "open";
    text = "Not agreed. A term was changed on both copies; settle it below first.";
  } else if (st.terms.length === 0) {
    stateName = "open";
    text = "Not agreed yet. Add the first term.";
  } else {
    stateName = "open";
    text = "Not agreed yet. It is agreed when you have both accepted it as it stands.";
  }
  status.textContent = text;
  status.dataset.state = stateName;
  $("view").dataset.agreed = st.agreed ? "true" : "false";
  $("view").dataset.sealed = st.sealed ? "true" : "false";
  $("agreement-title").textContent = a.title;
  $("parties").textContent = `Between ${a.first_party} and ${a.second_party}`;
}

function drawSeat(a, st) {
  const s = st.seats;
  let text = "";
  $("reseat").hidden = true;
  if (s.contested && s.amCreator && !s.closed) {
    text = "Two devices opened this invite, so neither can take part. Send a fresh invite to the one person you meant.";
    $("reseat").hidden = false;
  } else if (s.seatLost) {
    text = `Your place in this agreement was taken on another device or replaced. Nothing you did lost it -- ${a.first_party} can send you a fresh invite.`;
  } else if (s.notIn) {
    text = `This agreement reached you, but you have not been invited into it, so you can read it but not change or accept it. Open an invite from ${a.first_party} to take part.`;
  }
  $("seat-text").textContent = text;
  $("seat").hidden = !text;
}

function saveEdit(a, t, text) {
  const body = text.trim();
  if (!body) {
    say("A term needs some wording. To take it out, use Remove.");
    return;
  }
  if (body !== t.body) {
    // change() takes every column, not only the ones that changed.
    if (!write(() => shared.change("terms", t.entity, { agreement_id: a.id, body, position: t.position }))) return;
  }
  editing = null;
  draw();
}

function drawConflict(a, t, st, li) {
  const versions = rows(
    `SELECT body, position, _r_deleted AS deleted
       FROM terms_heads WHERE lower(hex(_r_entity)) = ?
      ORDER BY _r_lc DESC`,
    [t.entity],
  );
  const box = document.createElement("div");
  box.className = "conflict";
  const p = document.createElement("p");
  p.textContent = "This term was changed on both copies before they met. Keep the version that is right:";
  box.append(p);
  const choices = document.createElement("div");
  choices.className = "choices column";
  versions.forEach((v, k) => {
    const label = v.deleted ? "Removed on one copy -- remove it" : `Keep: ${v.body}`;
    const b = button(label, () => {
      // Writing the choice settles it: a change or a remove names every
      // current version as its parent.
      const ok = write(() =>
        v.deleted
          ? shared.remove("terms", t.entity)
          : shared.change("terms", t.entity, { agreement_id: a.id, body: v.body, position: v.position }),
      );
      if (ok) draw();
    }, `term-keep-${t.entity}-${k}`);
    b.disabled = !st.canWrite;
    choices.append(b);
  });
  box.append(choices);
  li.append(box);
}

function drawTerms(a, st) {
  const list = $("terms");
  list.replaceChildren();
  $("terms-empty").hidden = st.terms.length > 0;
  let focusMe = null;

  st.terms.forEach((t, i) => {
    const li = document.createElement("li");
    li.id = `term-${t.entity}`;
    li.className = "term" + (t.conflicted ? " conflicted" : "");
    li.dataset.entity = t.entity;

    if (editing === t.entity && st.canWrite) {
      const area = document.createElement("textarea");
      area.id = `term-edit-text-${t.entity}`;
      area.rows = 3;
      area.maxLength = 1000;
      area.value = t.body;
      area.setAttribute("aria-label", `Wording of term ${i + 1}`);
      area.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          saveEdit(a, t, area.value);
        } else if (event.key === "Escape") {
          editing = null;
          draw();
        }
      });
      const actions = document.createElement("div");
      actions.className = "choices";
      actions.append(
        button("Save wording", () => saveEdit(a, t, area.value), `term-save-${t.entity}`, ""),
        button("Cancel", () => { editing = null; draw(); }, `term-cancel-${t.entity}`),
      );
      li.append(area, actions);
      focusMe = area;
    } else {
      const body = document.createElement("p");
      body.className = "body";
      body.id = `term-text-${t.entity}`;
      body.textContent = t.body;
      li.append(body);
      if (st.canWrite) {
        const actions = document.createElement("div");
        actions.className = "choices";
        actions.append(
          button("Edit", () => { editing = t.entity; confirmingSeal = false; draw(); }, `term-edit-${t.entity}`),
          button("Remove", () => {
            if (write(() => shared.remove("terms", t.entity))) draw();
          }, `term-remove-${t.entity}`),
        );
        li.append(actions);
      }
      if (t.conflicted) drawConflict(a, t, st, li);
    }
    list.append(li);
  });

  if (editing && !st.terms.some((t) => t.entity === editing)) editing = null;
  if (focusMe) focusMe.focus();
  $("add-term-form").hidden = !st.canWrite;
}

function drawAcceptance(a, st) {
  const s = st.seats;
  const list = $("acceptances");
  list.replaceChildren();
  const line = (id, name, who, acc, joined) => {
    const li = document.createElement("li");
    li.id = id;
    let text;
    if (!joined) text = `${name} has not opened the invite yet.`;
    else if (acc.now) text = `${name} accepts this version.`;
    else if (acc.before) text = `${name} accepted an earlier version. It changed since, so that no longer counts.`;
    else text = `${name} has not accepted it.`;
    li.className = acc.now ? "yes" : "no";
    li.dataset.accepted = acc.now ? "true" : "false";
    li.textContent = (who ? `${who}: ` : "") + text;
    list.append(li);
  };
  line("acceptance-first", a.first_party, s.amCreator ? "You" : "", st.first, !!s.creator);
  line("acceptance-second", a.second_party, !s.amCreator && s.member ? "You" : "", st.second, !!s.opponent);

  const hint = $("accept-hint");
  let hintText = "";
  if (st.canWrite && !st.version) {
    hintText = st.terms.length === 0
      ? "Add at least one term before accepting."
      : "Settle the term changed on both copies before accepting.";
  } else if (st.canWrite && st.mineAccepted && !st.agreed) {
    hintText = s.opponent
      ? `Send it to ${s.amCreator ? a.second_party : a.first_party} so they can accept it too.`
      : "Send the invite so the other person can accept it too.";
  }
  hint.textContent = hintText;
  hint.hidden = !hintText;

  $("accept").hidden = !st.canWrite || st.mineAccepted;
  $("accept").disabled = !st.version;
  $("withdraw").hidden = !st.canWrite || !st.mineAccepted || st.agreed;
  $("seal").hidden = !(st.agreed && st.canWrite) || confirmingSeal;
  $("seal-confirm").hidden = !(st.agreed && st.canWrite && confirmingSeal);
  if (!(st.agreed && st.canWrite)) confirmingSeal = false;
}

function draw() {
  drawList();
  const a = activeAgreement();
  $("empty-state").hidden = !!a;
  $("view").hidden = !a;
  if (!a) return;
  const st = state(a);
  drawStatus(a, st);
  drawSeat(a, st);
  drawTerms(a, st);
  drawAcceptance(a, st);
  const s = st.seats;
  const canInvite = s.amCreator && !!s.openSeat && !s.contested && !s.closed;
  $("invite").hidden = !canInvite;
  $("invite-hint").hidden = !canInvite;
  $("send").hidden = !(s.member && s.opponent && !s.closed);
}

// ---- acting -------------------------------------------------------------

$("new-agreement").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("agreement-name").value.trim();
  const you = $("you").value.trim();
  const them = $("them").value.trim();
  if (!title || !you || !them) return;
  const made = write(() => {
    db.exec("BEGIN");
    try {
      // A new agreement is a new session: this copy is seated, one seat is left open.
      const { session } = shared.session.create();
      const id = shared.insert("agreements", { title, first_party: you, second_party: them }, session);
      db.exec({ sql: "UPDATE settings SET active_agreement = ? WHERE id = 1", bind: [id] });
      db.exec("COMMIT");
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  if (made) {
    $("new-agreement").reset();
    editing = null;
    confirmingSeal = false;
  }
  draw();
  if (made) $("new-term").focus();
});

$("agreement-list").addEventListener("change", () => {
  db.exec({ sql: "UPDATE settings SET active_agreement = ? WHERE id = 1", bind: [$("agreement-list").value] });
  editing = null;
  confirmingSeal = false;
  draw();
});

function addTerm() {
  const a = activeAgreement();
  const body = $("new-term").value.trim();
  if (!a || !body) return;
  const s = seats(a.session);
  const position =
    one("SELECT coalesce(max(position), 0) + 1 AS p FROM terms_current WHERE agreement_id = ?", [a.id])?.p ?? 1;
  if (write(() => shared.insert("terms", { agreement_id: a.id, body, position }, a.session))) {
    $("new-term").value = "";
  }
  draw();
  if (s.member) $("new-term").focus();
}

$("add-term-form").addEventListener("submit", (event) => {
  event.preventDefault();
  addTerm();
});

$("new-term").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    addTerm();
  }
});

$("accept").addEventListener("click", () => {
  const a = activeAgreement();
  if (!a) return;
  const st = state(a);
  if (!st.canWrite || !st.version || st.mineAccepted) return;
  write(() => shared.insert("acceptances", { agreement_id: a.id, version: st.version }, a.session));
  draw();
});

$("withdraw").addEventListener("click", () => {
  const a = activeAgreement();
  if (!a) return;
  const st = state(a);
  if (!st.canWrite) return;
  write(() => {
    for (const x of st.myAcceptances) shared.remove("acceptances", x.entity);
  });
  draw();
});

$("seal").addEventListener("click", () => {
  confirmingSeal = true;
  draw();
  $("seal-confirm-yes").focus();
});

$("seal-cancel").addEventListener("click", () => {
  confirmingSeal = false;
  draw();
});

$("seal-confirm-yes").addEventListener("click", () => {
  const a = activeAgreement();
  if (!a) return;
  const st = state(a);
  confirmingSeal = false;
  if (!st.agreed || !st.canWrite) {
    draw();
    return;
  }
  write(() => {
    // The seal is the finishing act; closing the session is what makes it
    // final -- no row written after what this copy has seen is admitted.
    const already = one(
      "SELECT 1 AS x FROM seals_current WHERE agreement_id = ? AND version = ? LIMIT 1",
      [a.id, st.version],
    );
    if (!already) shared.insert("seals", { agreement_id: a.id, version: st.version }, a.session);
    shared.session.close(a.session);
  });
  draw();
});

// The host makes the invite: it mints the key and the link.
$("invite").addEventListener("click", () => window.dai.requestShare());
$("send").addEventListener("click", () => window.dai.requestShare());

$("reseat").addEventListener("click", () => {
  const a = activeAgreement();
  if (a && write(() => shared.session.reseat(a.session))) window.dai.requestShare();
  draw();
});

// The other person's changes arrive here, and nowhere else. Join only when a
// file or link was opened; a background mailbox merge never takes a seat.
window.addEventListener("dai:merged", (event) => {
  if (event.detail?.via === "carrier") joinIfInvited();
  draw();
});

joinIfInvited();
draw();
