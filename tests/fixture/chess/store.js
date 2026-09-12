import {Position, START_FEN, opposite, squareName} from './engine.js';

export const playerName=(g,color)=>color==='w'?g.white_name:g.black_name;
const ORDER='ORDER BY ply, _r_lc, lower(hex(_r_replica)), _r_seq';

/**
 * All shared truth lives in three replicated tables and is read back through
 * their *_current views. Every write to them goes through `writer`, which is
 * the kit's replicated-row API in the opener and the test shim in Node:
 *   writer.insert(table, values)          -> entity hex   (create entity)
 *   writer.change(table, entity, values)  -> entity hex   (new row, parents = current heads)
 *   writer.remove(table, entity)          -> entity hex   (tombstone)
 * The board, whose turn it is, the result and any pending draw offer are
 * never stored. `state()` derives them by replaying `moves` in ply order
 * through the engine. A row the engine cannot play is ignored, not trusted.
 */
export class Store {
 constructor(db,writer){this.db=db;this.w=writer;}
 rows(sql,bind){return bind===undefined?this.db.selectObjects(sql):this.db.selectObjects(sql,bind);}
 one(sql,bind){return this.rows(sql,bind)[0]||null;}
 exec(sql,bind){if(bind===undefined)this.db.exec(sql);else this.db.exec({sql,bind});}
 tx(fn){if(this.depth){return fn();}this.depth=1;this.exec('BEGIN IMMEDIATE');try{const v=fn();this.exec('COMMIT');return v;}catch(e){try{this.exec('ROLLBACK');}catch{}throw e;}finally{this.depth=0;}}

 settings(){return this.one('SELECT * FROM settings WHERE id = 1');}
 ui(){return this.one('SELECT * FROM ui_state WHERE id = 1');}

 // ---- reads -------------------------------------------------------------
 games(){return this.rows(`SELECT lower(hex(g._r_entity)) AS id, lower(hex(g._r_session)) AS session, g.white_name, g.black_name, g.creator_color, g.initial_fen, g._r_conflicted AS names_conflicted,
   COALESCE(l.is_demo,0) AS is_demo, COALESCE(l.hidden,0) AS hidden
   FROM games_current g LEFT JOIN local_games l ON l.game_id = lower(hex(g._r_entity)) ORDER BY g._r_lc`);}
 // This copy's own replica id, hex — for deciding roster membership below.
 myReplica(){return this.one('SELECT lower(hex(id)) AS id FROM _dai_replica')?.id||null;}
 /**
  * Join a game's session by binding its open seat, exactly once (T1-D29/D32).
  *
  * Bound to the seat, not the tap: a copy that already holds a binding for this
  * session does nothing, so opening the same invite twice never writes a second
  * binding and never contests its own seat. A copy with no open seat to take —
  * a game it created, or one whose seats are all bound — also does nothing.
  */
 /**
  * Bind this copy into a session's open seat, if it holds one and is not already
  * a member (T1-D29/D34).
  *
  * Called only when this copy *opens an invite over a carrier* — a fresh arrival,
  * or a file/link merged into a copy it already holds — never on a background
  * mailbox merge. That is the whole of why a reseated invite can be rejoined
  * (opening the new invite is a carrier event) while the same fresh seat arriving
  * over the mailbox at an ejected copy does not silently re-seat it and contest
  * it again. So there is no "have I been here before" guard here: the caller,
  * gating on the carrier, is the guard.
  */
 joinIfNeeded(session){
  if(!session)return;
  const mine=this.myReplica();if(!mine)return;
  const member=this.one('SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?',[session,mine]);
  if(member)return; // already admitted; nothing to do
  const seat=this.one("SELECT lower(hex(s.seat)) AS seat FROM _dai_seat_current s WHERE lower(hex(s._r_session)) = ? AND lower(hex(s.seat)) NOT IN (SELECT lower(hex(b.seat)) FROM _dai_binding_current b WHERE lower(hex(b._r_session)) = ?) LIMIT 1",[session,session]);
  if(seat)this.w.session.join(session,seat.seat);
 }
 /** Join the active game's session if this copy has arrived at one it is not in. */
 joinActive(){const g=this.game();if(g&&!g.is_demo)this.joinIfNeeded(g.session);}
 /**
  * The seat picture for a session: is a seat contested, am I the creator, is
  * MY seat the contested one (T1-D29). A contested seat has two or more distinct
  * binders — two people opened one invite — and admits neither, so a copy whose
  * seat is contested is no longer a member and its later moves drop.
  */
 seatState(session){
  const mine=this.myReplica();
  // Any seat two or more replicas bind — the creator's cue that an invite went
  // to more than one device and needs replacing.
  const contested=this.rows("SELECT lower(hex(b.seat)) AS seat FROM _dai_binding_current b JOIN _dai_seat_current s ON s._r_session = b._r_session AND s.seat = b.seat WHERE lower(hex(b._r_session)) = ? GROUP BY b.seat HAVING count(DISTINCT lower(hex(b._r_replica))) > 1",[session]).length>0;
  const amCreator=!!this.one('SELECT 1 AS x FROM _dai_seat_current WHERE lower(hex(_r_session)) = ? AND lower(hex(_r_replica)) = ? LIMIT 1',[session,mine]);
  const haveBinding=!!this.one('SELECT 1 AS x FROM _dai_binding_current WHERE lower(hex(_r_session)) = ? AND lower(hex(_r_replica)) = ? LIMIT 1',[session,mine]);
  const member=!!this.one('SELECT 1 AS x FROM _dai_member WHERE lower(hex(session)) = ? AND lower(hex(replica)) = ?',[session,mine]);
  // Bound once, not admitted now: the seat was contested by another device, or
  // retired in a reseat. Either way this copy's place is gone until it opens a
  // fresh invite. One state, one message — a dead-end message is the hang.
  // notIn: holds the game's rows but never joined it — membership is joined, not
  // inherited (T1-D34), so a forwarded document leaves you holding a game you are
  // not in, and the app must say so rather than show an empty board.
  return {contested,amCreator,mineOut:haveBinding&&!member,notIn:!amCreator&&!haveBinding&&!member};
 }
 /**
  * The creator's half of the repair (T1-D29): mint a fresh open seat for a game
  * whose invite was opened by two people. The old open seat is superseded, so the
  * contesting bindings drop; the person then shares again and the one they meant
  * to play opens the new invite and binds the fresh seat. Only the creator can.
  */
 newInvite(){
  const g=this.game();if(!g)throw new Error('Open a game first.');
  if(g.is_demo)throw new Error('The practice board has no invite to renew.');
  if(!this.seatState(g.session).amCreator)throw new Error('Only the player who started this game can send a new invite for it.');
  this.w.session.reseat(g.session);
 }
 gameById(id){return this.games().find(g=>g.id===id)||null;}
 game(){const s=this.settings();return s.active_game_id?this.gameById(s.active_game_id):null;}
 moves(gameId){return this.rows(`SELECT lower(hex(_r_entity)) AS entity, lower(hex(_r_replica)) AS replica, game_id, ply, color, from_sq, to_sq, promotion, san, draw_offer FROM moves_current WHERE game_id = ? ${ORDER}`,[gameId]);}
 events(gameId){return this.rows(`SELECT lower(hex(_r_entity)) AS entity, game_id, after_ply, color, kind, detail FROM game_events_current WHERE game_id = ? ORDER BY after_ply, _r_lc, lower(hex(_r_replica)), _r_seq`,[gameId]);}
 draft(gameId=this.game()?.id){return gameId?this.one('SELECT * FROM drafts WHERE game_id = ?',[gameId]):null;}
 photo(gameId,color){return this.one('SELECT bytes FROM photos WHERE game_id = ? AND color = ?',[gameId,color])?.bytes||null;}

 /**
  * Derive everything the old schema used to store. Deterministic for a
  * given row set, so two merged copies show the same board.
  *   position   engine position after every applied move
  *   history    applied moves with before/after FEN
  *   conflict   {ply, candidates} when the same side has two legal moves at one ply — replay stops there
  *   ignored    rows the engine refused (wrong side, illegal move, orphaned ply)
  *   result     '*' | '1-0' | '0-1' | '1/2-1/2', with reason
  *   drawOfferBy   side whose offer is open, if any
  */
 state(gameId=this.game()?.id){
  const g=gameId&&this.gameById(gameId);if(!g)return null;
  const byPly=new Map();for(const m of this.moves(g.id)){if(!byPly.has(m.ply))byPly.set(m.ply,[]);byPly.get(m.ply).push(m);}
  let p=new Position(g.initial_fen);const history=[],ignored=[],keys=new Map([[p.key(),1]]);let conflict=null,drawOfferBy=null;
  for(let ply=1;;ply++){
   const cands=byPly.get(ply)||[];if(!cands.length)break;
   const legal=[],bad=[];
   for(const m of cands){
    let played=null;
    if(m.color===p.turn){try{played=p.play({from:m.from_sq,to:m.to_sq,promotion:m.promotion||null});}catch{played=null;}}
    (played?legal:bad).push(played?{...m,played}:m);
   }
   ignored.push(...bad.map(m=>({...m,why:m.color!==p.turn?'out of turn':'not legal here'})));
   if(!legal.length)break;
   if(legal.length>1){conflict={ply,color:legal[0].color,candidates:legal.map(m=>({entity:m.entity,replica:m.replica,san:m.played.move.san,from_sq:m.from_sq,to_sq:m.to_sq}))};
    // Everything after a conflicted ply waits for the resolution.
    for(const [q,rest] of byPly)if(q>ply)ignored.push(...rest.map(m=>({...m,why:'after an unresolved conflict'})));
    break;}
   const m=legal[0];history.push({...m.played.move,ply,entity:m.entity,replica:m.replica,draw_offer:m.draw_offer});
   p=m.played.position;keys.set(p.key(),(keys.get(p.key())||0)+1);
   drawOfferBy=m.draw_offer?m.color:null;   // an offer stands until the next move or an event answers it
  }
  const ply=history.length,repetitions=keys.get(p.key())||1;
  let result=p.terminal(repetitions),reasonFrom='engine';
  const answered=[];
  for(const e of this.events(g.id)){
   if(e.after_ply!==ply)continue;            // an event is only meaningful at the ply count it was made at
   if(result)break;
   if(e.kind==='resign'){const winner=opposite(e.color);result=p.canPossiblyMate(winner)?{result:winner==='w'?'1-0':'0-1',reason:'Resignation'}:{result:'1/2-1/2',reason:'Resignation · no possible mate'};reasonFrom=e.entity;}
   else if(e.kind==='draw-accept'&&drawOfferBy&&drawOfferBy!==e.color){result={result:'1/2-1/2',reason:'Draw by agreement'};reasonFrom=e.entity;}
   else if(e.kind==='draw-decline'&&drawOfferBy&&drawOfferBy!==e.color){drawOfferBy=null;answered.push(e);}
   else if(e.kind==='claim'){const ok=(e.detail==='Threefold repetition'&&repetitions>=3)||(e.detail==='50-move rule'&&p.halfmove>=100);if(ok){result={result:'1/2-1/2',reason:e.detail};reasonFrom=e.entity;}}
  }
  if(conflict)drawOfferBy=null;
  return {game:g,position:p,fen:p.fen(),turn:p.turn,ply,history,last:history[history.length-1]||null,conflict,ignored,
   result:result?.result||'*',resultReason:result?.reason||'',resultFrom:result?reasonFrom:null,drawOfferBy:result?null:drawOfferBy,repetitions,
   inCheck:!result&&p.inCheck()};
 }

 // ---- setup and navigation -------------------------------------------------
 bootstrap(){
  this.tx(()=>{
   const s=this.settings();
   if(!s.seed_completed){this.seedDemo();this.exec('UPDATE settings SET seed_completed = 1 WHERE id = 1');}
   this.faceMover();
   this.exec('UPDATE ui_state SET selected_square = NULL, promotion_from = NULL, promotion_to = NULL WHERE id = 1');
  });
 }
 seedDemo(){
  // The practice board is a session too — this copy is its only member, so its
  // own moves must be admitted, which means seating itself in a fresh session.
  const {session}=this.w.session.create();
  const id=this.w.insert('games',{white_name:'Alex',black_name:'John',creator_color:'w',initial_fen:START_FEN},session);
  this.exec('INSERT INTO local_games(game_id,is_demo) VALUES (?,1)',[id]);
  let p=new Position();
  for(const [ply,[from,to]] of [['e2','e4'],['e7','e5'],['g1','f3'],['b8','c6']].entries()){
   const r=p.play({from,to});
   this.w.insert('moves',{game_id:id,ply:ply+1,color:r.move.color,from_sq:from,to_sq:to,promotion:null,san:r.move.san,draw_offer:0},session);
   p=r.position;
  }
  if(!this.settings().active_game_id)this.exec('UPDATE settings SET active_game_id = ? WHERE id = 1',[id]);
 }
 faceMover(){const st=this.state();if(st)this.exec('UPDATE ui_state SET orientation = ? WHERE id = 1',[st.turn]);}
 switchView(view){if(!['board','games','settings'].includes(view))return;this.exec('UPDATE ui_state SET current_view = ? WHERE id = 1',[view]);}
 openGame(id){this.tx(()=>{this.exec('UPDATE settings SET active_game_id = ? WHERE id = 1',[id]);this.faceMover();this.exec("UPDATE ui_state SET current_view = 'board', selected_square = NULL, promotion_from = NULL, promotion_to = NULL WHERE id = 1");});}

 createGame(){
  const s=this.settings(),you=s.setup_you.trim(),them=s.setup_them.trim();
  if(!you||!them||you.length>40||them.length>40)throw new Error('Add both player names, up to 40 characters each.');
  const color=s.setup_color==='random'?(crypto.getRandomValues(new Uint8Array(1))[0]&1?'w':'b'):s.setup_color;
  const white=color==='w'?you:them,black=color==='b'?you:them;
  return this.tx(()=>{
   // A new game is a new session: mint it, seat the creator, leave an open seat
   // for the invitee — then the games row, all under the one session. All in
   // this transaction, so a failure leaves no half-formed game (T1-D29/D32).
   const {session}=this.w.session.create();
   const id=this.w.insert('games',{white_name:white,black_name:black,creator_color:color,initial_fen:START_FEN},session);
   this.exec('INSERT INTO local_games(game_id) VALUES (?)',[id]);
   this.exec('UPDATE settings SET active_game_id = ? WHERE id = 1',[id]);
   this.exec("UPDATE ui_state SET current_view = 'board', orientation = 'w', selected_square = NULL, promotion_from = NULL, promotion_to = NULL WHERE id = 1");
   return id;
  });
 }
 rename(white,black){const g=this.game();if(!g)return;white=white.trim();black=black.trim();if(!white||!black||white.length>40||black.length>40)throw new Error('Both names are needed, up to 40 characters each.');
  this.w.change('games',g.id,{white_name:white,black_name:black,creator_color:g.creator_color,initial_fen:g.initial_fen});}

 // ---- playing ----------------------------------------------------------------
 /** A game accepts a move only when it has no result and no unresolved conflict. */
 playable(st=this.state()){
  if(!st)throw new Error('Start a game first.');
  if(st.result!=='*')throw new Error('This game has ended. Start a new match to play again.');
  if(st.conflict)throw new Error('Two moves were made at the same turn. Choose which one stands first.');
  return st;
 }
 select(square){const st=this.playable();if(this.draft(st.game.id))throw new Error('Choose Change move to try a different move.');this.exec('UPDATE ui_state SET selected_square = ? WHERE id = 1',[square]);}
 startPromotion(from,to){this.playable();this.exec('UPDATE ui_state SET promotion_from = ?, promotion_to = ? WHERE id = 1',[from,to]);}
 cancelPromotion(){this.exec('UPDATE ui_state SET promotion_from = NULL, promotion_to = NULL WHERE id = 1');}
 setDraft(from,to,promotion=null){
  const st=this.playable();if(this.draft(st.game.id))throw new Error('Change your tentative move first.');
  const r=st.position.play({from,to,promotion});
  this.tx(()=>{
   this.exec('INSERT INTO drafts(game_id,from_sq,to_sq,promotion) VALUES (?,?,?,?)',[st.game.id,from,to,promotion]);
   this.exec('UPDATE ui_state SET selected_square = NULL, promotion_from = NULL, promotion_to = NULL WHERE id = 1');
  });return r.move;
 }
 clearDraft(gameId=this.game()?.id){if(gameId)this.exec('DELETE FROM drafts WHERE game_id = ?',[gameId]);}
 toggleDrawOffer(){const d=this.draft();if(!d)throw new Error('Choose a move first; the offer travels with it.');this.exec('UPDATE drafts SET draw_offer = 1 - draw_offer WHERE game_id = ?',[d.game_id]);return !d.draw_offer;}
 /** Preview what the draft becomes if played: the next state's terminal, and any claim it enables. */
 previewDraft(st=this.state()){const d=st&&this.draft(st.game.id);if(!d)return null;const r=st.position.play({from:d.from_sq,to:d.to_sq,promotion:d.promotion});
  const count=st.history.filter(h=>new Position(h.after).key()===r.position.key()).length+(new Position(st.game.initial_fen).key()===r.position.key()?1:0)+1;
  return {move:r.move,position:r.position,terminal:r.position.terminal(count),repetitions:count,claim:count>=3?'Threefold repetition':r.position.halfmove>=100?'50-move rule':null};}
 /** Commit the tentative move as a shared row. This is the moment the move becomes a fact. */
 playDraft(){
  const st=this.playable(),d=this.draft(st.game.id);if(!d)throw new Error('Choose a move first.');
  const pv=this.previewDraft(st);
  return this.tx(()=>{
   const entity=this.w.insert('moves',{game_id:st.game.id,ply:st.ply+1,color:st.turn,from_sq:d.from_sq,to_sq:d.to_sq,promotion:d.promotion||null,san:pv.move.san,draw_offer:d.draw_offer?1:0},st.game.session);
   this.exec('DELETE FROM drafts WHERE game_id = ?',[st.game.id]);
   this.exec('UPDATE ui_state SET selected_square = NULL WHERE id = 1');
   return {entity,move:pv.move,terminal:pv.terminal};
  });
 }
 /** The same side made two legal moves at one ply on two copies. Keep one; the rest are tombstoned. */
 resolveConflict(keepEntity){
  const st=this.state();if(!st?.conflict)throw new Error('There is no conflict to resolve.');
  if(!st.conflict.candidates.some(c=>c.entity===keepEntity))throw new Error('That move is not one of the candidates.');
  this.tx(()=>{for(const c of st.conflict.candidates)if(c.entity!==keepEntity)this.w.remove('moves',c.entity);});
 }
 claimEligibility(st=this.state()){
  if(!st||st.result!=='*'||st.conflict)return null;
  if(st.repetitions>=3)return {where:'current',reason:'Threefold repetition'};
  if(st.position.halfmove>=100)return {where:'current',reason:'50-move rule'};
  const pv=this.previewDraft(st);if(pv?.claim)return {where:'draft',reason:pv.claim};
  return null;
 }
 event(kind,detail=''){const st=this.playable();this.w.insert('game_events',{game_id:st.game.id,after_ply:st.ply,color:st.turn,kind,detail},st.game.session);this.clearDraft(st.game.id);}
 resign(){this.event('resign');}
 /** Whether this game's session has been closed — a `_dai_close` row names it. */
 isClosed(session){return !!this.one('SELECT 1 AS x FROM _dai_close_current WHERE lower(hex(_r_session)) = ? LIMIT 1',[session]);}
 /**
  * Close the match: the heavier, separate act from a resignation (T1-D31/D32).
  *
  * A resignation is a game row and the board stays readable; a close ends the
  * session — no more rows, eligible for compaction. So it is offered only on a
  * finished game, never as the way to end a live one, and it is idempotent: a
  * game already closed does nothing. Chess declares `close=any`, so either
  * player may close; the frame refuses a close the policy forbids.
  */
 closeMatch(){
  const g=this.game();if(!g)throw new Error('Open a game first.');
  if(g.is_demo)throw new Error('The practice board is yours alone; there is no match to close.');
  const st=this.state();if(st.result==='*')throw new Error('This game is still going. A match is closed after it ends, not to end it — resign if you mean to.');
  if(this.isClosed(g.session))return;
  this.w.session.close(g.session);
 }
 acceptDraw(){const st=this.playable();if(!st.drawOfferBy||st.drawOfferBy===st.turn)throw new Error('There is no opponent draw offer to accept.');this.event('draw-accept');}
 declineDraw(){const st=this.playable();if(!st.drawOfferBy||st.drawOfferBy===st.turn)return;this.event('draw-decline');}
 claimDraw(){const st=this.playable(),e=this.claimEligibility(st);if(!e)throw new Error('A draw cannot be claimed in this position.');
  if(e.where==='current'){this.event('claim',e.reason);return e;}
  // The claim rides on the intended move: play it, then claim at the new ply.
  this.tx(()=>{this.playDraft();this.w.insert('game_events',{game_id:st.game.id,after_ply:st.ply+1,color:opposite(st.turn),kind:'claim',detail:e.reason},st.game.session);});return e;
 }

 // ---- local housekeeping -------------------------------------------------------
 hideGame(id){this.exec('INSERT INTO local_games(game_id,hidden) VALUES (?,1) ON CONFLICT(game_id) DO UPDATE SET hidden = 1',[id]);}
 /** Clears what this copy owns. Shared rows are append-only and cannot be deleted; games are hidden instead. */
 clearAll(){this.tx(()=>{
  this.exec('DELETE FROM drafts');this.exec('DELETE FROM photos');
  this.exec('UPDATE local_games SET hidden = 1');
  this.exec("UPDATE settings SET active_game_id = NULL, theme = 'system', animations = 1, setup_you = '', setup_them = '', setup_color = 'random' WHERE id = 1");
  this.exec("UPDATE ui_state SET current_view = 'board', orientation = 'w', selected_square = NULL, promotion_from = NULL, promotion_to = NULL WHERE id = 1");
 });}
}
export {squareName};
