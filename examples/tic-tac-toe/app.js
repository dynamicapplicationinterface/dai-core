// Tic-tac-toe — a session document. Each game is a session of two: the
// creator plays X, the invitee takes the open seat and plays O. The board, the
// turn and the winner are derived from marks every time; shared rows are
// written through window.dai.replicated and read from the _current views.

const $ = (id) => document.getElementById(id);
let db; // opened by the start-up at the end of this file
const shared = window.dai.replicated;
const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));
const one = (sql, bind) => rows(sql, bind)[0] ?? null;

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

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
        ? "Open this document in the DAI opener to play."
        : `That did not save: ${message}`,
    );
    return false;
  }
}

// ---- reading ------------------------------------------------------------

/** This copy's replica id, or null before this copy has written anything. */
const myReplica = () => one("SELECT lower(hex(id)) AS id FROM _dai_replica")?.id ?? null;

function games() {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, lower(hex(_r_session)) AS session,
            x_name, o_name, _r_conflicted AS conflicted
       FROM games_current ORDER BY _r_lc`,
  );
}

function activeGame() {
  const list = games();
  const id = one("SELECT active_game FROM settings WHERE id = 1")?.active_game;
  return list.find((g) => g.id === id) ?? list[list.length - 1] ?? null;
}

/** Everything about the seats of a session, as this copy sees it. */
function seats(session) {
  const mine = myReplica();
  const creator = one(
    "SELECT lower(hex(_r_replica)) AS r FROM _dai_seat_current WHERE lower(hex(_r_session)) = ? LIMIT 1",
    [session],
  )?.r;
  const isMember = (replica) =>
    !!replica &&
    !!one("SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?", [session, replica]);
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
  const closed = !!one("SELECT 1 AS x FROM _dai_close_current WHERE lower(hex(_r_session)) = ? LIMIT 1", [session]);
  const amCreator = !!mine && mine === creator;
  const member = isMember(mine);
  return {
    creator, opponent, amCreator, member, closed, contested, openSeat,
    // Bound once, not admitted now: the seat was contested or replaced.
    seatLost: bound && !member,
    // Holds the rows but was never invited: forwarded, not joined.
    notIn: !amCreator && !bound,
  };
}

/** Replays the marks. Nothing here is stored. */
function state(game) {
  const s = seats(game.session);
  const marks = rows(
    `SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_replica)) AS by, turn, cell
       FROM marks_current WHERE game_id = ?
      ORDER BY turn, _r_lc, lower(hex(_r_replica)), _r_seq`,
    [game.id],
  );
  const board = Array(9).fill(null);
  let turn = 1;
  let collision = null;
  for (;;) {
    const side = turn % 2 === 1 ? "X" : "O";
    const author = side === "X" ? s.creator : s.opponent;
    const candidates = marks.filter((m) => m.turn === turn && m.by === author && board[m.cell] === null);
    if (candidates.length === 0) break;
    if (candidates.length > 1) {
      collision = { turn, side, candidates };
      break;
    }
    board[candidates[0].cell] = side;
    turn += 1;
  }
  const line = LINES.find(([a, b, c]) => board[a] && board[a] === board[b] && board[a] === board[c]);
  const winner = line ? board[line[0]] : null;
  const full = board.every(Boolean);
  const toMove = turn % 2 === 1 ? "X" : "O";
  const mySide = s.amCreator ? "X" : s.member ? "O" : null;
  const over = Boolean(winner) || full;
  // X may move before O has joined: an X mark only needs the creator to be
  // known. O's marks arrive in the same file as O's binding.
  const canPlay = s.member && !s.closed && !over && !collision && mySide === toMove;
  return { seats: s, board, turn, toMove, mySide, collision, winner, line, over, canPlay };
}

// ---- joining ------------------------------------------------------------

/**
 * Take the open seat of the game showing, if this copy arrived with an invite.
 * Called at start-up and when a file or link is opened — never on a background
 * mailbox merge. The sent copy carries the sender's local settings (local
 * tables travel; they are never merged), so the game showing is the one the
 * invite was sent from.
 */
function joinIfInvited() {
  // An invite carries only the game it was sent for, and none of the sender's
  // local rows — so the game to join is one this copy can join: not its own,
  // not one it is already in, with a seat open. That includes a copy whose seat
  // was contested and replaced: opening the creator's fresh invite is how it
  // gets back in. Prefer the game showing, if it is one.
  const joinable = (g) => {
    const s = seats(g.session);
    return !s.member && !s.amCreator && !!s.openSeat;
  };
  const active = activeGame();
  const target = active && joinable(active) ? active : [...games()].reverse().find(joinable);
  if (!target) return;
  const seat = seats(target.session).openSeat;
  if (write(() => shared.session.join(target.session, seat))) {
    db.exec({ sql: "UPDATE settings SET active_game = ? WHERE id = 1", bind: [target.id] });
  }
}

// ---- drawing ------------------------------------------------------------

function nameOf(game, side) {
  return side === "X" ? game.x_name : game.o_name;
}

function drawGameList() {
  const list = $("game-list");
  const current = activeGame();
  list.replaceChildren();
  for (const g of games()) {
    const option = document.createElement("option");
    option.value = g.id;
    option.textContent = `${g.x_name} v ${g.o_name}`;
    option.selected = g.id === current?.id;
    list.append(option);
  }
  list.hidden = list.options.length < 2;
}

function drawSeat(game, st) {
  const panel = $("seat");
  const s = st.seats;
  let text = "";
  $("reseat").hidden = true;
  if (s.contested && s.amCreator) {
    text = "Two people opened this invite, so neither can play. Send a fresh invite to the one person you meant.";
    $("reseat").hidden = false;
  } else if (s.seatLost) {
    text = `Your seat in this game was taken on another device or replaced. Nothing you did lost it — ${game.x_name} can send you a fresh invite.`;
  } else if (s.notIn) {
    // Said so it is true for both people this copy could be: someone the game was
    // forwarded to, or a player on a new device or browser. The copy cannot tell
    // them apart, and "you were not invited" is false for the second.
    text = "Both seats in this game belong to other devices, so this copy can't play. If you played it on another device or in another browser, keep playing there.";
  } else if (s.closed) {
    text = "This match is closed.";
  }
  $("seat-text").textContent = text;
  panel.hidden = !text;
}

function drawBoard(game, st) {
  const board = $("board");
  board.replaceChildren();
  const canPlay = st.canPlay;
  st.board.forEach((mark, cell) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cell" + (st.line?.includes(cell) ? " win" : "");
    b.textContent = mark ?? "";
    b.setAttribute("aria-label", mark ? `Square ${cell + 1}, ${mark}` : `Square ${cell + 1}, empty`);
    b.disabled = !canPlay || mark !== null;
    b.addEventListener("click", () => {
      write(() => shared.insert("marks", { game_id: game.id, turn: st.turn, cell }, game.session));
      draw();
    });
    board.append(b);
  });
}

function drawStatus(game, st) {
  const s = st.seats;
  let status;
  if (st.winner) status = `${nameOf(game, st.winner)} wins.`;
  else if (st.over) status = "A draw.";
  else if (st.collision) status = "Two marks at one turn — settle it below.";
  else if (st.canPlay) status = `Your move, ${nameOf(game, st.mySide)}.${s.opponent ? "" : " Then send the invite."}`;
  else if (!s.member) status = "You are not playing in this game.";
  else if (!s.opponent) status = "Waiting for your invite to be opened.";
  else status = `${nameOf(game, st.toMove)}'s move. Send them this game.`;
  $("status").textContent = status;
  $("players").textContent = `${game.x_name} (X) v ${game.o_name} (O)`;
}

function drawCollision(game, st) {
  const panel = $("collision");
  panel.hidden = !st.collision;
  if (!st.collision) return;
  const c = st.collision;
  $("collision-text").textContent =
    `${nameOf(game, c.side)} marked two squares at the same turn, on two copies. Keep the one that should stand.`;
  const choices = $("collision-choices");
  choices.replaceChildren();
  for (const m of c.candidates) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `Keep square ${m.cell + 1}`;
    b.disabled = !st.seats.member;
    b.addEventListener("click", () => {
      write(() => {
        for (const other of c.candidates) if (other.entity !== m.entity) shared.remove("marks", other.entity);
      });
      draw();
    });
    choices.append(b);
  }
}

function drawNamesConflict(game) {
  const panel = $("names-conflict");
  panel.hidden = !game.conflicted;
  if (!game.conflicted) return;
  const versions = rows(
    "SELECT x_name, o_name FROM games_heads WHERE lower(hex(_r_entity)) = ? AND _r_deleted = 0",
    [game.id],
  );
  const choices = $("name-versions");
  choices.replaceChildren();
  for (const v of versions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${v.x_name} v ${v.o_name}`;
    b.addEventListener("click", () => {
      // A change names every current version as its parent, so it settles it.
      write(() => shared.change("games", game.id, { x_name: v.x_name, o_name: v.o_name }));
      draw();
    });
    choices.append(b);
  }
}

/**
 * Tells the host which games wait on this player, so the home-screen icon can
 * say so when a move arrives while the app is closed. The whole set, every
 * time: a game drops out of it the moment this player moves.
 */
function reportWaiting() {
  if (typeof window.dai.reportWaiting !== "function") return;
  window.dai.reportWaiting(games().filter((g) => state(g).canPlay).map((g) => g.session));
}

function draw() {
  reportWaiting();
  drawGameList();
  const game = activeGame();
  $("play").hidden = !game;
  if (!game) return;
  const st = state(game);
  drawStatus(game, st);
  drawBoard(game, st);
  drawCollision(game, st);
  drawNamesConflict(game);
  drawSeat(game, st);
  $("invite").hidden = !(st.seats.amCreator && st.seats.openSeat && !st.seats.contested);
  $("rename").hidden = !st.seats.member || st.seats.closed;
  $("close-match").hidden = !(st.over && st.seats.member && !st.seats.closed);
}

// ---- acting -------------------------------------------------------------

$("new-game").addEventListener("submit", (event) => {
  event.preventDefault();
  const you = $("you").value.trim();
  const them = $("them").value.trim();
  if (!you || !them) return;
  const made = write(() => {
    db.exec("BEGIN");
    try {
      // A new game is a new session: this copy is seated, one seat is left open.
      const { session } = shared.session.create();
      const id = shared.insert("games", { x_name: you, o_name: them }, session);
      db.exec({ sql: "UPDATE settings SET active_game = ? WHERE id = 1", bind: [id] });
      db.exec("COMMIT");
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  if (made) $("new-game").reset();
  draw();
});

$("game-list").addEventListener("change", () => {
  db.exec({ sql: "UPDATE settings SET active_game = ? WHERE id = 1", bind: [$("game-list").value] });
  draw();
});

// The host makes the invite: it mints the key and the link. Naming the game's
// session makes it an invite into this game only — the other games and this
// device's settings stay here.
$("invite").addEventListener("click", () => {
  const game = activeGame();
  if (game) window.dai.requestShare(game.session);
});

$("reseat").addEventListener("click", () => {
  const game = activeGame();
  if (game && write(() => shared.session.reseat(game.session))) window.dai.requestShare(game.session);
  draw();
});

// An inline form, not prompt(): the application runs in a sandboxed frame,
// where the browser's own dialogs are not available.
$("rename").addEventListener("click", () => {
  const game = activeGame();
  if (!game) return;
  $("rename-x").value = game.x_name;
  $("rename-o").value = game.o_name;
  $("rename-form").hidden = false;
  $("rename-x").focus();
});

$("rename-cancel").addEventListener("click", () => {
  $("rename-form").hidden = true;
});

$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const game = activeGame();
  const x = $("rename-x").value.trim();
  const o = $("rename-o").value.trim();
  if (!game || !x || !o) return;
  // change() takes every column, not only the ones that changed.
  if (write(() => shared.change("games", game.id, { x_name: x, o_name: o }))) $("rename-form").hidden = true;
  draw();
});

$("close-match").addEventListener("click", () => {
  const game = activeGame();
  if (game) write(() => shared.session.close(game.session));
  draw();
});

// The other player's marks arrive here, and nowhere else. Join only when a
// file or link was opened; a background mailbox merge never takes a seat.
window.addEventListener("dai:merged", (event) => {
  if (event.detail?.via === "carrier") joinIfInvited();
  draw();
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
    `This game could not be opened: ${error?.message ?? error}. ` +
    "Try opening the document again in the DAI opener, or ask whoever sent it for a new copy.";
}
