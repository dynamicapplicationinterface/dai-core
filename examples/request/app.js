// Request — a session document with author roles. Each request is a session of
// two: the creator writes the request and its questions and sends a link; the
// person who opens it takes the open seat and answers. The schema says which
// side writes which table (author=creator, author=joiner), and the runtime
// holds both copies to it; this file only decides what to show each side.

const $ = (id) => document.getElementById(id);
let db; // opened by the start-up at the end of this file
const shared = window.dai.replicated;
const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));
const one = (sql, bind) => rows(sql, bind)[0] ?? null;

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
        ? "Open this document in the DAI opener to use it."
        : message.startsWith("ROLE_NOT_PERMITTED")
          ? "That side of the request belongs to the other person, so this copy cannot change it."
          : `That did not save: ${message}`,
    );
    return false;
  }
}

// ---- reading ------------------------------------------------------------

/** This copy's replica id, or null before this copy has written anything. */
const myReplica = () => one("SELECT lower(hex(id)) AS id FROM _dai_replica")?.id ?? null;

function requests() {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, lower(hex(_r_session)) AS session, from_name, title, note, due_on
       FROM requests_current ORDER BY _r_lc`,
  );
}

function activeRequest() {
  const list = requests();
  const id = one("SELECT active_request FROM settings WHERE id = 1")?.active_request;
  return list.find((r) => r.id === id) ?? list[list.length - 1] ?? null;
}

/** Everything about the seats of a session, as this copy sees it. */
function seats(session) {
  const mine = myReplica();
  const creator = one(
    "SELECT lower(hex(_r_replica)) AS r FROM _dai_seat_current WHERE lower(hex(_r_session)) = ? LIMIT 1",
    [session],
  )?.r;
  const member = !!mine &&
    !!one("SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?", [session, mine]);
  const bound = !!mine &&
    !!one(
      "SELECT 1 AS x FROM _dai_binding_current WHERE lower(hex(_r_session)) = ? AND lower(hex(_r_replica)) = ?",
      [session, mine],
    );
  const contested = rows(
    `SELECT 1 AS x FROM _dai_binding_current b
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
  const answererJoined = !!one(
    `SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) <> ? LIMIT 1`,
    [session, creator ?? ""],
  );
  const closed = !!one("SELECT 1 AS x FROM _dai_close_current WHERE lower(hex(_r_session)) = ? LIMIT 1", [session]);
  const isWriter = !!mine && mine === creator;
  return {
    isWriter,
    isAnswerer: member && !isWriter,
    answererJoined, closed, contested, openSeat,
    seatLost: bound && !member,
    notIn: !isWriter && !bound,
  };
}

function questionsOf(request) {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, prompt FROM questions_current
      WHERE request_id = ? ORDER BY position, _r_lc`,
    [request.id],
  );
}

/**
 * The answers to one question. Usually one row. More than one means the answer
 * was started on two devices before they met, and conflicted means one answer
 * was edited on both: either way the answerer settles it, nothing is dropped.
 */
function answersTo(question) {
  const current = rows(
    `SELECT lower(hex(_r_entity)) AS id, body, _r_conflicted AS conflicted
       FROM answers_current WHERE question_id = ? ORDER BY _r_lc`,
    [question.id],
  );
  const versions = current.flatMap((a) =>
    a.conflicted
      ? rows(
          "SELECT body FROM answers_heads WHERE lower(hex(_r_entity)) = ? AND _r_deleted = 0",
          [a.id],
        ).map((v) => ({ id: a.id, body: v.body }))
      : [{ id: a.id, body: a.body }],
  );
  return { current, versions, unsettled: versions.length > 1 };
}

const submitted = (request) => !!one("SELECT 1 AS x FROM submissions_current WHERE request_id = ? LIMIT 1", [request.id]);

// ---- joining ------------------------------------------------------------

/**
 * Take the open seat of a request this copy was sent a link to. Called at
 * start-up and when a file or link is opened — never on a background mailbox
 * merge.
 */
function joinIfInvited() {
  const joinable = (r) => {
    const s = seats(r.session);
    return !s.isWriter && !s.isAnswerer && !!s.openSeat;
  };
  const active = activeRequest();
  const target = active && joinable(active) ? active : [...requests()].reverse().find(joinable);
  if (!target) return;
  if (write(() => shared.session.join(target.session, seats(target.session).openSeat))) {
    db.exec({ sql: "UPDATE settings SET active_request = ? WHERE id = 1", bind: [target.id] });
  }
}

// ---- drawing ------------------------------------------------------------

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function drawList() {
  const list = $("request-list");
  const current = activeRequest();
  list.replaceChildren();
  for (const r of requests()) {
    const option = document.createElement("option");
    option.value = r.id;
    option.dataset.session = r.session;
    option.textContent = r.title;
    option.selected = r.id === current?.id;
    list.append(option);
  }
  list.hidden = list.options.length < 2;
}

function drawSeat(s) {
  let text = "";
  $("reseat").hidden = true;
  if (s.contested && s.isWriter) {
    text = "Two people opened this link, so neither can answer. Send a fresh link to the one person you meant.";
    $("reseat").hidden = false;
  } else if (s.seatLost) {
    text = "Your place in this request was taken on another device or replaced. Ask the sender for a fresh link.";
  } else if (s.notIn) {
    text = "This request reached you, but not through its link. Open the link you were sent to answer it.";
  } else if (s.closed) {
    text = "This request is closed. Nothing on it can change.";
  }
  $("seat-text").textContent = text;
  $("seat").hidden = !text;
}

function drawQuestion(question, s, request) {
  const item = document.createElement("li");
  item.className = "question";

  const prompt = document.createElement("p");
  prompt.className = "prompt";
  prompt.textContent = question.prompt;
  item.append(prompt);

  const answers = answersTo(question);
  const canAnswer = s.isAnswerer && !s.closed;

  if (answers.unsettled) {
    const why = document.createElement("p");
    why.className = "saved";
    why.textContent = canAnswer
      ? "This was answered two ways on two devices. Keep one:"
      : "The answer was written two ways on two devices; they will choose one.";
    item.append(why);
    const choices = document.createElement("div");
    choices.className = "choices";
    for (const version of answers.versions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "quiet";
      b.textContent = version.body;
      b.disabled = !canAnswer;
      b.addEventListener("click", () => {
        write(() => {
          // A change names every current version as its parent, so it settles
          // an edit made on both; any second answer row is removed.
          shared.change("answers", version.id, { question_id: question.id, body: version.body });
          for (const other of answers.current) if (other.id !== version.id) shared.remove("answers", other.id);
        });
        draw();
      });
      choices.append(b);
    }
    item.append(choices);
    return item;
  }

  const answer = answers.current[0] ?? null;

  if (canAnswer) {
    const box = document.createElement("textarea");
    box.id = `answer-${question.id}`;
    box.rows = 3;
    box.maxLength = 2000;
    box.value = drafts.get(question.id) ?? answer?.body ?? "";
    box.setAttribute("aria-label", `Answer to: ${question.prompt}`);
    const row = document.createElement("div");
    row.className = "choices saving";
    const save = document.createElement("button");
    save.type = "button";
    const state = document.createElement("span");
    state.className = "saved";
    // Redrawn on every keystroke without rebuilding the box, so typing is never
    // interrupted and the send button always counts what is unsaved.
    const show = () => {
      const unsaved = isUnsaved(question.id, answer);
      save.textContent = answer ? "Save changes" : "Save answer";
      save.disabled = !unsaved;
      state.textContent = unsaved
        ? "Not saved yet"
        : drafts.has(question.id) && !drafts.get(question.id).trim() && answer
          ? "Empty answers are not saved; your saved answer stays"
          : answer
            ? "Saved"
            : "";
      state.classList.toggle("unsaved", unsaved);
    };
    box.addEventListener("input", () => {
      drafts.set(question.id, box.value);
      show();
      drawSubmit();
    });
    save.addEventListener("click", () => {
      if (saveDraft(question, answer, request)) draw();
    });
    show();
    row.append(save, state);
    item.append(box, row);
    return item;
  }

  const reply = document.createElement("p");
  reply.className = "reply" + (answer ? "" : " waiting");
  reply.textContent = answer ? answer.body : s.isWriter ? "Not answered yet." : "No answer.";
  item.append(reply);

  // Page-only, unlike the roles (see schema.sql).
  // Questions lock once the request has been opened: a question changing under
  // an answer is a change nobody could follow.
  if (s.isWriter && !s.closed && !s.answererJoined) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "link";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove question: ${question.prompt}`);
    remove.addEventListener("click", () => {
      write(() => shared.remove("questions", question.id));
      draw();
    });
    item.append(remove);
  }
  return item;
}

// ---- answers not yet saved ----------------------------------------------

/**
 * What the answerer has typed and not saved, by question. Held here, not in the
 * database: an answer is a shared row, and a row per pause in typing would send
 * half-written text to the other person. Every redraw draws from this, so a
 * merge arriving mid-sentence never replaces what is on screen.
 */
const drafts = new Map();

function isUnsaved(questionId, answer) {
  const text = drafts.get(questionId)?.trim();
  return !!text && text !== answer?.body;
}

/** Saves one question's draft. True when there was nothing to save or it saved. */
function saveDraft(question, answer, request) {
  if (!isUnsaved(question.id, answer)) return true;
  const body = drafts.get(question.id).trim();
  const saved = write(() =>
    answer
      ? shared.change("answers", answer.id, { question_id: question.id, body })
      : shared.insert("answers", { question_id: question.id, body }, request.session),
  );
  if (saved) drafts.delete(question.id);
  return !!saved;
}

/** The unsaved answers of the request showing, with what each would replace. */
function unsavedIn(request) {
  return questionsOf(request)
    .map((question) => ({ question, answer: answersTo(question).current[0] ?? null }))
    .filter(({ question, answer }) => isUnsaved(question.id, answer));
}

/**
 * The one button that sends. It never sends past text on screen: whatever is
 * unsaved is saved first, and the label says how much.
 */
function drawSubmit() {
  const request = activeRequest();
  const button = $("submit");
  if (!request) return;
  const s = seats(request.session);
  const questions = questionsOf(request);
  const answered = questions.filter((q) => answersTo(q).current.length > 0).length;
  const unsaved = unsavedIn(request).length;
  const sent = submitted(request);
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // Before anything is sent the button is always there, disabled until there is
  // something to send, so a person opening the request cold can see where it ends.
  button.hidden = !(s.isAnswerer && !s.closed && (sent ? unsaved > 0 : true));
  button.disabled = !sent && answered + unsaved === 0;
  $("hint").hidden = !(s.isAnswerer && !s.closed && !sent);
  if (sent) button.textContent = `Save ${plural(unsaved, "change")}`;
  else if (answered + unsaved === 0) button.textContent = "Send answers back";
  else if (unsaved > 0) button.textContent = `Save ${plural(unsaved, "answer")} and send back`;
  else if (answered < questions.length) button.textContent = `Send back ${answered} of ${questions.length} answers`;
  else button.textContent = "Send answers back";
}

// ---- the page -----------------------------------------------------------

/** True while the person is writing a new request over one that is open. */
let composing = false;

function draw() {
  drawList();
  const request = activeRequest();
  const writing = composing || !request;
  $("new-request").hidden = !writing;
  $("compose-cancel").hidden = !request;
  $("compose").hidden = writing;
  $("view").hidden = writing;
  if (writing) return;
  const s = seats(request.session);
  // The person answering came for this request; starting one of their own is
  // not what their screen is for.
  if (s.isAnswerer) $("compose").hidden = true;
  const questions = questionsOf(request);
  const answered = questions.filter((q) => answersTo(q).current.length > 0).length;
  const sent = submitted(request);

  $("role").textContent = s.isWriter
    ? s.answererJoined
      ? "You wrote this request · it has been opened, so the questions are locked"
      : "You wrote this request · only you can change the questions"
    : s.isAnswerer
      ? `From ${request.from_name} · only you can answer`
      : `From ${request.from_name}`;
  $("title").textContent = request.title;
  $("meta").textContent = request.due_on ? `Answers needed by ${formatDate(request.due_on)}` : "";
  $("note").textContent = request.note;

  let progress;
  const of = `${answered} of ${questions.length}`;
  if (questions.length === 0) progress = s.isWriter ? "Add your first question below." : "No questions yet.";
  else if (s.isWriter && sent) progress = `Answers sent back · ${of} answered`;
  else if (s.isWriter && !s.answererJoined) progress = `${questions.length} ${questions.length === 1 ? "question" : "questions"} · not opened yet`;
  else if (s.isWriter) progress = `Opened · ${of} answered so far`;
  else if (sent) progress = `Sent back · you can still change your answers`;
  else progress = `${of} answered`;
  $("progress").textContent = progress;
  $("progress").classList.toggle("done", sent && answered === questions.length);

  drawSeat(s);
  $("questions").replaceChildren(...questions.map((q) => drawQuestion(q, s, request)));

  $("add-question").hidden = !(s.isWriter && !s.closed && !s.answererJoined);
  $("invite").hidden = !(s.isWriter && s.openSeat && !s.contested && !s.closed && questions.length > 0);
  drawSubmit();
  $("close").hidden = !(s.isWriter && !s.closed && s.answererJoined);
}

// ---- acting -------------------------------------------------------------

$("compose").addEventListener("click", () => {
  composing = true;
  draw();
  $("new-from").focus();
});

$("compose-cancel").addEventListener("click", () => {
  composing = false;
  $("new-request").reset();
  draw();
});

$("new-request").addEventListener("submit", (event) => {
  event.preventDefault();
  const from = $("new-from").value.trim();
  const title = $("new-title").value.trim();
  if (!from || !title) return;
  const made = write(() => {
    db.exec("BEGIN");
    try {
      // A new request is a new session: this copy is seated, one seat is left open.
      const { session } = shared.session.create();
      const id = shared.insert(
        "requests",
        { from_name: from, title, note: $("new-note").value.trim(), due_on: $("new-due").value || null },
        session,
      );
      db.exec({ sql: "UPDATE settings SET active_request = ? WHERE id = 1", bind: [id] });
      db.exec("COMMIT");
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  if (made) {
    composing = false;
    $("new-request").reset();
    draw();
    $("prompt").focus();
  }
});

$("request-list").addEventListener("change", () => {
  db.exec({ sql: "UPDATE settings SET active_request = ? WHERE id = 1", bind: [$("request-list").value] });
  composing = false;
  draw();
});

$("add-question").addEventListener("submit", (event) => {
  event.preventDefault();
  const request = activeRequest();
  const prompt = $("prompt").value.trim();
  if (!request || !prompt) return;
  const position = (one("SELECT max(position) AS p FROM questions_current WHERE request_id = ?", [request.id])?.p ?? 0) + 1;
  if (write(() => shared.insert("questions", { request_id: request.id, position, prompt }, request.session))) {
    $("prompt").value = "";
  }
  draw();
  $("prompt").focus();
});

// The host makes the link: it mints the key. Naming the request's session makes
// it a link into this request only — other requests and this device's settings
// stay here.
$("invite").addEventListener("click", () => {
  const request = activeRequest();
  if (request) window.dai.requestShare(request.session);
});

$("reseat").addEventListener("click", () => {
  const request = activeRequest();
  if (request && write(() => shared.session.reseat(request.session))) window.dai.requestShare(request.session);
  draw();
});

// Saves every unsaved answer first, and sends only if all of them saved: a
// send that went ahead past a failed save would be the silent loss this button
// exists to prevent.
$("submit").addEventListener("click", () => {
  const request = activeRequest();
  if (!request) return;
  const pending = unsavedIn(request);
  const allSaved = pending.every(({ question, answer }) => saveDraft(question, answer, request));
  if (allSaved && !submitted(request)) {
    write(() => shared.insert("submissions", { request_id: request.id }, request.session));
  }
  draw();
});

$("close").addEventListener("click", () => {
  const request = activeRequest();
  if (request) write(() => shared.session.close(request.session));
  draw();
});

// The other person's rows arrive here, and nowhere else. Join only when a file
// or link was opened; a background mailbox merge never takes a seat. Unsaved
// answers survive the redraw (they are drawn from drafts); the cursor is put
// back where it was.
window.addEventListener("dai:merged", (event) => {
  if (event.detail?.via === "carrier") joinIfInvited();
  const typing = document.activeElement?.id?.startsWith("answer-") ? document.activeElement : null;
  const at = typing ? { id: typing.id, start: typing.selectionStart } : null;
  draw();
  if (at && $(at.id)) {
    $(at.id).focus();
    $(at.id).setSelectionRange(at.start, at.start);
  }
});

// Start-up (NO-INPUT-LOST-WHILE-OPENING): nothing can be pressed until this has
// finished, and if it fails the person is told, not left at "Opening…".
try {
  db = await window.dai.openDatabase();
  joinIfInvited();
  draw();
  $("opening").hidden = true;
  $("app").hidden = false;
  $("app").inert = false;
} catch (error) {
  $("opening").classList.add("failed");
  $("opening").textContent =
    `This request could not be opened: ${error?.message ?? error}. ` +
    "Try opening the link again, or ask whoever sent it for a new one.";
}
