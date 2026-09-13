// THE FOIL. Deliberately wrong; see README.md. The correct store is
// tests/fixture/chess/store.js — compare playMove here with playDraft there,
// and board() here with state() there.

import { Position } from "../../tests/fixture/chess/engine.js";

export class Store {
  constructor(db) {
    this.db = db;
  }

  // WRONG: reads the replicated table itself, so superseded and deleted rows
  // come back beside the current ones. The correct store reads moves_current.
  moves(gameId) {
    return this.db.selectObjects("SELECT ply, san FROM moves WHERE game_id = ? ORDER BY ply", [gameId]);
  }

  // WRONG: trusts the stored board instead of replaying the moves. After a
  // merge this is whichever copy's opinion was written last.
  board(gameId) {
    const game = this.db.selectObjects("SELECT fen, turn, result FROM games WHERE rowid = ?", [gameId])[0];
    return new Position(game.fen);
  }

  // WRONG, three times: a raw INSERT into a replicated table (it fails: the
  // replication columns are missing), then an UPDATE of a shared row (refused
  // with REPLICATED_TABLE_IMMUTABLE), writing derived state that a merge would
  // make wrong anyway.
  playMove(gameId, from, to) {
    const position = this.board(gameId);
    const played = position.play({ from, to });
    const ply = this.moves(gameId).length + 1;
    this.db.exec({
      sql: "INSERT INTO moves (game_id, ply, san) VALUES (?, ?, ?)",
      bind: [gameId, ply, played.move.san],
    });
    this.db.exec({
      sql: "UPDATE games SET fen = ?, turn = ?, updated_at = datetime('now') WHERE rowid = ?",
      bind: [played.position.fen(), played.position.turn, gameId],
    });
  }

  // WRONG: a tap on one copy selects the square on the other player's screen.
  select(gameId, square) {
    this.db.exec({ sql: "UPDATE games SET selected_square = ? WHERE rowid = ?", bind: [square, gameId] });
  }

  // Nothing listens for dai:merged, so the other player's move never appears
  // until the document is reopened.
}
