/**
 * Velvet Chess — small, dependency-free orthodox chess rules engine.
 * Pure position values only. The app persists positions and repetition keys in SQLite.
 * Squares: a8 = 0, h1 = 63. No network, DOM, or persistent state in this module.
 */
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const opposite = c => c === 'w' ? 'b' : 'w';
export const colorOf = p => !p ? null : p === p.toUpperCase() ? 'w' : 'b';
export const squareName = i => 'abcdefgh'[i % 8] + (8 - Math.floor(i / 8));
export function squareIndex(s) {
  if (!/^[a-h][1-8]$/.test(s)) throw new Error('Invalid square');
  return (8 - Number(s[1])) * 8 + s.charCodeAt(0) - 97;
}
const KING = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
const KNIGHT = [[-2,-1],[-1,-2],[1,-2],[2,-1],[-2,1],[-1,2],[1,2],[2,1]];
const DIAGONAL = [[-1,-1],[1,-1],[-1,1],[1,1]];
const STRAIGHT = [[0,-1],[-1,0],[1,0],[0,1]];
const inside = (x,y) => x >= 0 && x < 8 && y >= 0 && y < 8;

export class Position {
  constructor(fen = START_FEN) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length !== 6) throw new Error('Invalid position: six FEN fields are required');
    const ranks = parts[0].split('/');
    if (ranks.length !== 8) throw new Error('Invalid board');
    this.board = [];
    for (const rank of ranks) {
      let width = 0;
      for (const symbol of rank) {
        if (/^[1-8]$/.test(symbol)) { const n = Number(symbol); this.board.push(...Array(n).fill(null)); width += n; }
        else if (/^[prnbqkPRNBQK]$/.test(symbol)) { this.board.push(symbol); width++; }
        else throw new Error('Invalid piece');
      }
      if (width !== 8) throw new Error('Invalid rank');
    }
    if (!/^[wb]$/.test(parts[1]) || !/^(?:-|K?Q?k?q?)$/.test(parts[2])) throw new Error('Invalid turn or castling rights');
    if (this.board.filter(p => p === 'K').length !== 1 || this.board.filter(p => p === 'k').length !== 1) throw new Error('Both kings are required');
    if ([...this.board.slice(0,8), ...this.board.slice(56)].some(p => p?.toLowerCase() === 'p')) throw new Error('A pawn on its final rank must promote');
    this.turn = parts[1];
    this.castling = parts[2] === '-' ? '' : parts[2];
    this.ep = parts[3] === '-' ? -1 : squareIndex(parts[3]);
    this.halfmove = Number(parts[4]); this.fullmove = Number(parts[5]);
    if (!Number.isInteger(this.halfmove) || this.halfmove < 0 || !Number.isInteger(this.fullmove) || this.fullmove < 1) throw new Error('Invalid move counters');
  }
  clone() {
    const p = Object.create(Position.prototype);
    p.board = this.board.slice(); p.turn = this.turn; p.castling = this.castling;
    p.ep = this.ep; p.halfmove = this.halfmove; p.fullmove = this.fullmove;
    return p;
  }
  fen() {
    const ranks = [];
    for (let y=0; y<8; y++) {
      let line='', empty=0;
      for (let x=0; x<8; x++) {
        const p = this.board[y*8+x];
        if (!p) empty++;
        else { if (empty) line += empty; empty=0; line += p; }
      }
      if (empty) line += empty;
      ranks.push(line);
    }
    return [ranks.join('/'),this.turn,this.castling || '-',this.ep < 0 ? '-' : squareName(this.ep),this.halfmove,this.fullmove].join(' ');
  }
  at(square) { return this.board[typeof square === 'number' ? square : squareIndex(square)]; }
  attacked(index, by) {
    const x = index%8, y = Math.floor(index/8);
    for (let from=0; from<64; from++) {
      const piece = this.board[from];
      if (colorOf(piece) !== by) continue;
      const sx=from%8, sy=Math.floor(from/8), dx=x-sx, dy=y-sy;
      const type = piece.toLowerCase();
      if (type === 'p') { if (Math.abs(dx) === 1 && dy === (by === 'w' ? -1 : 1)) return true; continue; }
      if (type === 'n') { if (Math.abs(dx)*Math.abs(dy) === 2) return true; continue; }
      if (type === 'k') { if (Math.max(Math.abs(dx),Math.abs(dy)) === 1) return true; continue; }
      if ((!dx && !dy) || !((type !== 'r' && Math.abs(dx) === Math.abs(dy)) || (type !== 'b' && (dx === 0 || dy === 0)))) continue;
      const vx=Math.sign(dx), vy=Math.sign(dy);
      let cx=sx+vx, cy=sy+vy, clear=true;
      while (cx !== x || cy !== y) { if (this.board[cy*8+cx]) { clear=false; break; } cx+=vx; cy+=vy; }
      if (clear) return true;
    }
    return false;
  }
  inCheck(color = this.turn) {
    const king = this.board.indexOf(color === 'w' ? 'K' : 'k');
    return king < 0 || this.attacked(king, opposite(color));
  }
  pseudoMoves(onlyFrom = null) {
    const moves = [], us = this.turn;
    const add = (from,to,flags='',promotion=null) => {
      const p=this.board[from], target=this.board[to];
      if (colorOf(target) === us || target?.toLowerCase() === 'k') return;
      const captured = flags.includes('e') ? 'p' : target?.toLowerCase() || null;
      const base = {from,to,color:us,piece:p.toLowerCase(),captured,flags:flags+(target?'c':''),promotion};
      if (p.toLowerCase()==='p' && (to<8 || to>=56) && !promotion) {
        for (const choice of ['q','r','b','n']) moves.push({...base,promotion:choice,flags:base.flags+'p'});
      } else moves.push(base);
    };
    for (let from=0; from<64; from++) {
      if (onlyFrom !== null && from !== onlyFrom) continue;
      const p=this.board[from]; if (colorOf(p)!==us) continue;
      const x=from%8,y=Math.floor(from/8),type=p.toLowerCase();
      if (type==='p') {
        const dy=us==='w'?-1:1, ny=y+dy;
        if (inside(x,ny) && !this.board[ny*8+x]) {
          add(from,ny*8+x);
          if (y===(us==='w'?6:1) && !this.board[(y+dy*2)*8+x]) add(from,(y+dy*2)*8+x,'d');
        }
        for (const dx of [-1,1]) if (inside(x+dx,ny)) {
          const to=ny*8+x+dx;
          if (this.board[to] && colorOf(this.board[to])!==us) add(from,to);
          if (to===this.ep && !this.board[to] && this.board[y*8+x+dx]===(us==='w'?'p':'P')) add(from,to,'e');
        }
        continue;
      }
      const vectors=type==='n'?KNIGHT:type==='k'?KING:type==='b'?DIAGONAL:type==='r'?STRAIGHT:KING;
      for (const [dx,dy] of vectors) {
        let nx=x+dx,ny=y+dy;
        while (inside(nx,ny)) {
          const to=ny*8+nx,target=this.board[to];
          if (colorOf(target)===us) break;
          add(from,to);
          if (target || type==='n' || type==='k') break;
          nx+=dx; ny+=dy;
        }
      }
      if (type==='k' && from===(us==='w'?60:4) && !this.inCheck(us)) {
        const row=us==='w'?56:0,rook=us==='w'?'R':'r',enemy=opposite(us);
        const canTransit = to => { const transit=this.clone(); transit.board[from]=null; transit.board[to]=p; return !transit.attacked(to,enemy); };
        if (this.castling.includes(us==='w'?'K':'k') && this.board[row+7]===rook && !this.board[row+5] && !this.board[row+6] && canTransit(row+5) && canTransit(row+6)) add(from,row+6,'k');
        if (this.castling.includes(us==='w'?'Q':'q') && this.board[row]===rook && !this.board[row+1] && !this.board[row+2] && !this.board[row+3] && canTransit(row+3) && canTransit(row+2)) add(from,row+2,'q');
      }
    }
    return moves;
  }
  afterUnchecked(move) {
    const p=this.clone(), piece=p.board[move.from];
    p.board[move.from]=null;
    if (move.flags.includes('e')) p.board[move.to+(this.turn==='w'?8:-8)]=null;
    p.board[move.to]=move.promotion ? (this.turn==='w'?move.promotion.toUpperCase():move.promotion) : piece;
    if (move.flags.includes('k')) { p.board[move.to-1]=p.board[move.to+1]; p.board[move.to+1]=null; }
    if (move.flags.includes('q')) { p.board[move.to+1]=p.board[move.to-2]; p.board[move.to-2]=null; }
    const remove = rights => { for (const r of rights) p.castling=p.castling.replace(r,''); };
    if (piece.toLowerCase()==='k') remove(this.turn==='w'?'KQ':'kq');
    const corners = [[0,'q'],[7,'k'],[56,'Q'],[63,'K']];
    for (const [index,right] of corners) {
      if ((move.from===index && piece.toLowerCase()==='r') || (move.to===index && this.board[index]?.toLowerCase()==='r')) remove(right);
    }
    p.ep=move.flags.includes('d')?(move.from+move.to)/2:-1;
    p.halfmove=piece.toLowerCase()==='p'||move.captured?0:this.halfmove+1;
    p.fullmove=this.fullmove+(this.turn==='b'?1:0);
    p.turn=opposite(this.turn);
    return p;
  }
  legalMoves(square=null) {
    const only=typeof square==='string'?squareIndex(square):square;
    return this.pseudoMoves(only).filter(m => !this.afterUnchecked(m).inCheck(this.turn));
  }
  play(input) {
    const from=typeof input.from==='number'?input.from:squareIndex(input.from);
    const to=typeof input.to==='number'?input.to:squareIndex(input.to);
    const legal=this.legalMoves();
    const move=legal.find(m=>m.from===from && m.to===to && (m.promotion||null)===(input.promotion||null));
    if (!move) throw new Error('That move is not legal in this position.');
    const next=this.afterUnchecked(move);
    let san='';
    if (move.flags.includes('k')) san='O-O';
    else if (move.flags.includes('q')) san='O-O-O';
    else {
      if (move.piece!=='p') {
        san=move.piece.toUpperCase();
        const others=legal.filter(m=>m.from!==from && m.to===to && m.piece===move.piece);
        if (others.length) {
          if (!others.some(m=>m.from%8===from%8)) san+=squareName(from)[0];
          else if (!others.some(m=>Math.floor(m.from/8)===Math.floor(from/8))) san+=squareName(from)[1];
          else san+=squareName(from);
        }
      } else if (move.captured) san+=squareName(from)[0];
      if (move.captured) san+='x';
      san+=squareName(to);
      if (move.promotion) san+='='+move.promotion.toUpperCase();
    }
    if (next.inCheck()) san+=next.legalMoves().length===0?'#':'+';
    return {position:next, move:{...move,from:squareName(from),to:squareName(to),san,before:this.fen(),after:next.fen()}};
  }
  key() {
    const parts=this.fen().split(' ');
    // Repetition distinguishes en passant only when that capture is actually legal.
    if (this.ep>=0 && !this.legalMoves().some(m=>m.flags.includes('e'))) parts[3]='-';
    return parts.slice(0,4).join(' ');
  }
  insufficientMaterial() {
    const pieces=this.board.map((p,i)=>({p:p?.toLowerCase(),i})).filter(x=>x.p && x.p!=='k');
    if (!pieces.length) return true;
    if (pieces.length===1 && ['n','b'].includes(pieces[0].p)) return true;
    if (pieces.every(x=>x.p==='b')) return new Set(pieces.map(x=>(x.i%8+Math.floor(x.i/8))%2)).size===1;
    return false;
  }
  canPossiblyMate(color) {
    const own=this.board.filter(p=>colorOf(p)===color && p.toLowerCase()!=='k').map(p=>p.toLowerCase());
    if (!own.length) return false;
    if (this.insufficientMaterial()) return false;
    if (own.some(p=>['p','r','q'].includes(p))) return true;
    const other=this.board.filter(p=>colorOf(p)===opposite(color) && p.toLowerCase()!=='k');
    return own.length>1 || other.length>0;
  }
  terminal(repetitions=1) {
    const legal=this.legalMoves();
    if (!legal.length) return this.inCheck() ? {result:this.turn==='w'?'0-1':'1-0',reason:'Checkmate'} : {result:'1/2-1/2',reason:'Stalemate'};
    if (this.insufficientMaterial()) return {result:'1/2-1/2',reason:'Insufficient material'};
    if (repetitions>=5) return {result:'1/2-1/2',reason:'Fivefold repetition'};
    if (this.halfmove>=150) return {result:'1/2-1/2',reason:'75-move rule'};
    return null;
  }
}
export function perft(position,depth) {
  if (!depth) return 1;
  let n=0;
  for (const m of position.legalMoves()) n+=perft(position.afterUnchecked(m),depth-1);
  return n;
}
