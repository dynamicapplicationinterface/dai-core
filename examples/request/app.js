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
    `SELECT lower(hex(_r_entity)) AS id, lower(hex(_r_session)) AS session, title, note, due_on
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
    box.value = answer?.body ?? "";
    box.setAttribute("aria-label", `Answer to: ${question.prompt}`);
    const row = document.createElement("div");
    row.className = "choices";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = answer ? "Save changes" : "Save answer";
    save.addEventListener("click", () => {
      const body = box.value.trim();
      if (!body || body === answer?.body) return;
      write(() =>
        answer
          ? shared.change("answers", answer.id, { question_id: question.id, body })
          : shared.insert("answers", { question_id: question.id, body }, request.session),
      );
      draw();
    });
    row.append(save);
    item.append(box, row);
    return item;
  }

  const reply = document.createElement("p");
  reply.className = "reply" + (answer ? "" : " waiting");
  reply.textContent = answer ? answer.body : s.isWriter ? "Not answered yet." : "No answer.";
  item.append(reply);

  if (s.isWriter && !s.closed && !answer) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quiet";
    remove.textContent = "Remove question";
    remove.addEventListener("click", () => {
      write(() => shared.remove("questions", question.id));
      draw();
    });
    const row = document.createElement("div");
    row.className = "choices";
    row.append(remove);
    item.append(row);
  }
  return item;
}

function draw() {
  drawList();
  const request = activeRequest();
  $("view").hidden = !request;
  if (!request) return;
  const s = seats(request.session);
  const questions = questionsOf(request);
  const answered = questions.filter((q) => answersTo(q).current.length > 0).length;
  const sent = submitted(request);

  $("role").textContent = s.isWriter
    ? "You wrote this request · only you can change the questions"
    : s.isAnswerer
      ? "Sent to you · only you can answer"
      : "Request";
  $("title").textContent = request.title;
  $("meta").textContent = request.due_on ? `Answers needed by ${formatDate(request.due_on)}` : "";
  $("note").textContent = request.note;

  let progress;
  if (questions.length === 0) progress = s.isWriter ? "Add your first question below." : "No questions yet.";
  else if (sent) progress = s.isWriter ? `Answers received · ${answered} of ${questions.length}` : `Sent back · ${answered} of ${questions.length} answered`;
  else if (s.isWriter && !s.answererJoined) progress = `${questions.length} ${questions.length === 1 ? "question" : "questions"} · not opened yet`;
  else progress = `${answered} of ${questions.length} answered`;
  $("progress").textContent = progress;
  $("progress").classList.toggle("done", sent);

  drawSeat(s);
  $("questions").replaceChildren(...questions.map((q) => drawQuestion(q, s, request)));

  $("add-question").hidden = !(s.isWriter && !s.closed);
  $("invite").hidden = !(s.isWriter && s.openSeat && !s.contested && !s.closed && questions.length > 0);
  $("submit").hidden = !(s.isAnswerer && !s.closed && !sent && answered > 0);
  $("submit").textContent = answered < questions.length
    ? `Send back ${answered} of ${questions.length} answers`
    : "Send answers back";
  $("close").hidden = !(s.isWriter && !s.closed && s.answererJoined);
}

// ---- acting -------------------------------------------------------------

$("new-request").addEventListener("submit", (event) => {
  event.preventDefault();
  const title = $("new-title").value.trim();
  if (!title) return;
  const made = write(() => {
    db.exec("BEGIN");
    try {
      // A new request is a new session: this copy is seated, one seat is left open.
      const { session } = shared.session.create();
      const id = shared.insert(
        "requests",
        { title, note: $("new-note").value.trim(), due_on: $("new-due").value || null },
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
    $("new-request").reset();
    draw();
    $("prompt").focus();
  }
});

$("request-list").addEventListener("change", () => {
  db.exec({ sql: "UPDATE settings SET active_request = ? WHERE id = 1", bind: [$("request-list").value] });
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

$("submit").addEventListener("click", () => {
  const request = activeRequest();
  if (request) write(() => shared.insert("submissions", { request_id: request.id }, request.session));
  draw();
});

$("close").addEventListener("click", () => {
  const request = activeRequest();
  if (request) write(() => shared.session.close(request.session));
  draw();
});

// The other person's rows arrive here, and nowhere else. Join only when a file
// or link was opened; a background mailbox merge never takes a seat. A merge
// redraws everything but an answer being typed: a redraw would replace it.
window.addEventListener("dai:merged", (event) => {
  if (event.detail?.via === "carrier") joinIfInvited();
  const typing = document.activeElement?.id?.startsWith("answer-") ? document.activeElement : null;
  const draft = typing ? { id: typing.id, value: typing.value, start: typing.selectionStart } : null;
  draw();
  if (draft && $(draft.id)) {
    $(draft.id).value = draft.value;
    $(draft.id).focus();
    $(draft.id).setSelectionRange(draft.start, draft.start);
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
