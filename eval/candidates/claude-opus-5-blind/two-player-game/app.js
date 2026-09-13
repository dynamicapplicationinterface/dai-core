// Connect Four — a session document. Each game is a session of two: the
// creator plays Red, the invitee takes the open seat and plays Yellow. The
// board, the turn and the winner are derived from the drops every time;
// shared rows are written through window.dai.replicated and read from the
// _current views.

const $ = (id) => document.getElementById(id);
const db = await window.dai.openDatabase();
const shared = window.dai.replicated;
const rows = (sql, bind) => (bind === undefined ? db.selectObjects(sql) : db.selectObjects(sql, bind));
const one = (sql, bind) => rows(sql, bind)[0] ?? null;

const COLS = 7;
const ROWS = 6;
const SIDES = { R: "Red", Y: "Yellow" };

/** The column the keyboard is on; about this screen only, never data. */
let focusCol = 3;

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

const myReplica = () => one("SELECT lower(hex(id)) AS id FROM _dai_replica")?.id ?? null;

function games() {
  return rows(
    `SELECT lower(hex(_r_entity)) AS id, lower(hex(_r_session)) AS session,
            red_name, yellow_name, _r_conflicted AS conflicted
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
  )?.r ?? null;
  const member = !!mine &&
    !!one(
      "SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?",
      [session, mine],
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
  const closed = !!one("SELECT 1 AS x FROM _dai_close_current WHERE lower(hex(_r_session)) = ? LIMIT 1", [session]);
  const amCreator = !!mine && mine === creator;
  return {
    creator, opponent, amCreator, member, closed, contested, openSeat,
    // Bound once, not admitted now: the seat was contested or replaced.
    seatLost: bound && !member,
    // Holds the rows but was never invited: forwarded, not joined.
    notIn: !amCreator && !bound,
  };
}

/** Where a disc dropped in this column lands, or -1 when the column is full. */
function landing(board, col) {
  for (let r = 0; r < ROWS; r += 1) if (board[r][col] === null) return r;
  return -1;
}

/** The four (or more) in a row, as [row, col] pairs, or null. */
function findLine(board) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const side = board[r][c];
      if (!side) continue;
      for (const [dr, dc] of dirs) {
        const cells = [[r, c]];
        let rr = r + dr;
        let cc = c + dc;
        while (rr >= 0 && rr < ROWS && cc >= 0 && cc < COLS && board[rr][cc] === side) {
          cells.push([rr, cc]);
          rr += dr;
          cc += dc;
        }
        if (cells.length >= 4) return { side, cells };
      }
    }
  }
  return null;
}

/** Replays the drops. Nothing here is stored. Row 0 is the bottom. */
function state(game) {
  const s = seats(game.session);
  const drops = rows(
    `SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_replica)) AS by, turn, col
       FROM drops_current WHERE game_id = ?
      ORDER BY turn, _r_lc, lower(hex(_r_replica)), _r_seq`,
    [game.id],
  );
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  let turn = 1;
  let collision = null;
  let last = null;
  let line = null;
  for (;;) {
    const side = turn % 2 === 1 ? "R" : "Y";
    const author = side === "R" ? s.creator : s.opponent;
    const candidates = drops.filter(
      (d) => d.turn === turn && d.by === author && d.col >= 0 && d.col < COLS && landing(board, d.col) >= 0,
    );
    if (candidates.length === 0) break;
    if (candidates.length > 1) {
      collision = { turn, side, candidates };
      break;
    }
    const col = candidates[0].col;
    const row = landing(board, col);
    board[row][col] = side;
    last = [row, col];
    turn += 1;
    line = findLine(board);
    if (line) break;
  }
  const winner = line ? line.side : null;
  const full = board.every((r) => r.every(Boolean));
  const toMove = turn % 2 === 1 ? "R" : "Y";
  const mySide = s.amCreator ? "R" : s.member ? "Y" : null;
  const over = Boolean(winner) || full;
  // Red may move before Yellow has joined: a Red drop only needs the creator
  // to be known. Yellow's drops arrive in the same file as Yellow's binding.
  const canPlay = s.member && !s.closed && !over && !collision && mySide === toMove;
  return { seats: s, board, turn, toMove, mySide, collision, winner, line, last, over, canPlay };
}

// ---- joining ------------------------------------------------------------

/**
 * Take the open seat of the game showing, if this copy arrived with an invite.
 * Called at start-up and when a file or link is opened — never on a
 * background mailbox merge.
 */
function joinIfInvited() {
  const game = activeGame();
  if (!game) return;
  const s = seats(game.session);
  if (s.member || s.amCreator || s.seatLost || !s.openSeat) return;
  write(() => shared.session.join(game.session, s.openSeat));
}

// ---- drawing ------------------------------------------------------------

const nameOf = (game, side) => (side === "R" ? game.red_name : game.yellow_name);

function drawGameList() {
  const list = $("game-list");
  const current = activeGame();
  list.replaceChildren();
  for (const g of games()) {
    const option = document.createElement("option");
    option.value = g.id;
    option.textContent = `${g.red_name} v ${g.yellow_name}`;
    option.selected = g.id === current?.id;
    list.append(option);
  }
  list.hidden = list.options.length < 2;
}

function drawSeat(game, st) {
  const s = st.seats;
  let text = "";
  $("reseat").hidden = true;
  if (s.contested && s.amCreator) {
    text = "Two devices opened this invite, so neither can play. Send a fresh invite to the one person you meant.";
    $("reseat").hidden = false;
  } else if (s.contested && !s.member && !s.amCreator) {
    text = `This invite was opened on more than one device, so nobody holds the seat. Nothing you did caused it — ${game.red_name} can send a fresh invite.`;
  } else if (s.seatLost) {
    text = `Your seat in this game was taken on another device or replaced. Nothing you did lost it — ${game.red_name} can send you a fresh invite.`;
  } else if (s.notIn) {
    text = `This game reached you, but you were not invited into it, so you can watch but not play. Ask ${game.red_name} for an invite.`;
  } else if (s.closed) {
    text = "This match is closed. It stays here to look back on.";
  }
  $("seat-text").textContent = text;
  $("seat").hidden = !text;
}

function drop(game, st, col) {
  if (!st.canPlay || landing(st.board, col) < 0) return;
  write(() => shared.insert("drops", { game_id: game.id, turn: st.turn, col }, game.session));
  draw();
}

function drawBoard(game, st) {
  const board = $("board");
  const hadFocus = board.contains(document.activeElement);
  board.replaceChildren();
  const winning = new Set((st.line?.cells ?? []).map(([r, c]) => `${r}:${c}`));
  for (let col = 0; col < COLS; col += 1) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "col";
    const free = landing(st.board, col) >= 0;
    b.disabled = !st.canPlay || !free;
    b.tabIndex = col === focusCol ? 0 : -1;
    const count = st.board.reduce((n, r) => n + (r[col] ? 1 : 0), 0);
    b.setAttribute(
      "aria-label",
      `Column ${col + 1}, ${free ? `${count} of ${ROWS} filled` : "full"}`,
    );
    if (st.canPlay && free) b.classList.add(st.mySide === "R" ? "hover-r" : "hover-y");
    // Top row first on screen.
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      const slot = document.createElement("span");
      const side = st.board[row][col];
      slot.className = "slot" + (side ? ` disc ${side === "R" ? "red" : "yellow"}` : "");
      if (winning.has(`${row}:${col}`)) slot.classList.add("win");
      if (st.last && st.last[0] === row && st.last[1] === col) slot.classList.add("last");
      slot.setAttribute("aria-hidden", "true");
      b.append(slot);
    }
    b.addEventListener("click", () => {
      focusCol = col;
      drop(game, st, col);
    });
    b.addEventListener("focus", () => {
      focusCol = col;
    });
    board.append(b);
  }
  if (hadFocus) board.children[focusCol]?.focus();
}

$("board").addEventListener("keydown", (event) => {
  const cols = $("board").children;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    focusCol = (focusCol + (event.key === "ArrowLeft" ? COLS - 1 : 1)) % COLS;
    for (const c of cols) c.tabIndex = -1;
    cols[focusCol].tabIndex = 0;
    cols[focusCol].focus();
  }
});

function drawStatus(game, st) {
  const s = st.seats;
  let status;
  if (st.winner) {
    status = st.winner === st.mySide ? `You win, ${nameOf(game, st.winner)}!` : `${nameOf(game, st.winner)} wins.`;
  } else if (st.over) status = "The board is full — a draw.";
  else if (st.collision) status = "Two discs at one turn — settle it below.";
  else if (st.canPlay) {
    status = `Your turn, ${nameOf(game, st.mySide)}.${s.opponent ? "" : " Drop a disc, then send the invite."}`;
  } else if (!s.member) status = `${nameOf(game, st.toMove)}'s turn. You are not playing in this game.`;
  else if (!s.opponent) status = `Waiting for ${game.yellow_name} to open your invite.`;
  else status = `${nameOf(game, st.toMove)}'s turn. Send them the game.`;
  $("status").textContent = status;
  $("status").className = "status " + (st.winner ? (st.winner === "R" ? "is-red" : "is-yellow") : st.over ? "" : st.toMove === "R" ? "is-red" : "is-yellow");

  const players = $("players");
  players.replaceChildren();
  for (const side of ["R", "Y"]) {
    const tag = document.createElement("span");
    tag.className = `player ${side === "R" ? "red" : "yellow"}` + (!st.over && st.toMove === side ? " to-move" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `${nameOf(game, side)}${st.mySide === side ? " (you)" : ""}`;
    tag.append(dot, label);
    players.append(tag);
  }
}

function drawCollision(game, st) {
  const panel = $("collision");
  panel.hidden = !st.collision;
  if (!st.collision) return;
  const c = st.collision;
  $("collision-text").textContent =
    `${nameOf(game, c.side)} dropped ${c.candidates.length} discs at the same turn, on two copies. Keep the one that should stand; the other is taken back.`;
  const choices = $("collision-choices");
  choices.replaceChildren();
  for (const d of c.candidates) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `Keep column ${d.col + 1}`;
    b.disabled = !st.seats.member || st.seats.closed;
    b.addEventListener("click", () => {
      write(() => {
        for (const other of c.candidates) if (other.entity !== d.entity) shared.remove("drops", other.entity);
      });
      draw();
    });
    choices.append(b);
  }
}

function drawNamesConflict(game, st) {
  const panel = $("names-conflict");
  panel.hidden = !game.conflicted;
  if (!game.conflicted) return;
  const versions = rows(
    "SELECT red_name, yellow_name FROM games_heads WHERE lower(hex(_r_entity)) = ? AND _r_deleted = 0",
    [game.id],
  );
  const choices = $("name-versions");
  choices.replaceChildren();
  for (const v of versions) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${v.red_name} v ${v.yellow_name}`;
    b.disabled = !st.seats.member || st.seats.closed;
    b.addEventListener("click", () => {
      // A change names every current version as its parent, so it settles it.
      write(() => shared.change("games", game.id, { red_name: v.red_name, yellow_name: v.yellow_name }));
      draw();
    });
    choices.append(b);
  }
}

function draw() {
  drawGameList();
  const game = activeGame();
  $("play").hidden = !game;
  $("empty").hidden = !!game;
  if (!game) return;
  const st = state(game);
  drawStatus(game, st);
  drawBoard(game, st);
  drawCollision(game, st);
  drawNamesConflict(game, st);
  drawSeat(game, st);
  const s = st.seats;
  $("invite").hidden = !(s.amCreator && s.openSeat && !s.contested && !s.closed);
  $("send").hidden = !(s.member && s.opponent && !s.closed);
  $("rename").hidden = !s.member || s.closed;
  $("close-match").hidden = !(st.over && s.member && !s.closed);
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
      const id = shared.insert("games", { red_name: you, yellow_name: them }, session);
      db.exec({ sql: "UPDATE settings SET active_game = ? WHERE id = 1", bind: [id] });
      db.exec("COMMIT");
      return id;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  if (made) {
    $("new-game").reset();
    focusCol = 3;
  }
  draw();
});

$("game-list").addEventListener("change", () => {
  db.exec({ sql: "UPDATE settings SET active_game = ? WHERE id = 1", bind: [$("game-list").value] });
  draw();
});

// The host makes the invite: it mints the key and the link. The same sheet
// sends the game back after a move.
$("invite").addEventListener("click", () => window.dai.requestShare());
$("send").addEventListener("click", () => window.dai.requestShare());

$("reseat").addEventListener("click", () => {
  const game = activeGame();
  if (game && write(() => shared.session.reseat(game.session))) window.dai.requestShare();
  draw();
});

$("rename").addEventListener("click", () => {
  const game = activeGame();
  if (!game) return;
  $("rename-red").value = game.red_name;
  $("rename-yellow").value = game.yellow_name;
  $("rename-form").hidden = false;
  $("rename-red").focus();
});

$("rename-cancel").addEventListener("click", () => {
  $("rename-form").hidden = true;
});

$("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const game = activeGame();
  const red = $("rename-red").value.trim();
  const yellow = $("rename-yellow").value.trim();
  if (!game || !red || !yellow) return;
  // change() takes every column, not only the ones that changed.
  if (write(() => shared.change("games", game.id, { red_name: red, yellow_name: yellow }))) {
    $("rename-form").hidden = true;
  }
  draw();
});

$("close-match").addEventListener("click", () => {
  const game = activeGame();
  if (game) write(() => shared.session.close(game.session));
  draw();
});

// The other player's drops arrive here, and nowhere else. Join only when a
// file or link was opened; a background mailbox merge never takes a seat.
window.addEventListener("dai:merged", (event) => {
  if (event.detail?.via === "carrier") joinIfInvited();
  draw();
});

joinIfInvited();
draw();
