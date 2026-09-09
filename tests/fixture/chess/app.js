import {Position, opposite, colorOf, squareIndex, squareName} from './engine.js';
import {Store, playerName} from './store.js';
import {pieceSVG,icon} from './pieces.js';
const $=id=>document.getElementById(id);
const names={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const colorName=c=>c==='w'?'White':'Black';
let store, animating=false, redrawQueued=false, toastTimer, confirmation=null;
const avatarURLs=[];
const reduceMotion=matchMedia('(prefers-reduced-motion: reduce)');
const systemDark=matchMedia('(prefers-color-scheme: dark)');
function element(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;}
function notify(message){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>{$('toast').hidden=true;},5200);}
function wireIcons(root=document){for(const span of root.querySelectorAll('[data-icon]'))if(!span.firstElementChild)span.append(icon(span.dataset.icon));}
function refresh(){window.daiKit.refresh();draw();}
function run(fn){return async event=>{try{await fn(event);}catch(error){console.error(error);notify(error?.message||'That action could not be completed. Your position has not changed.');}finally{if(store)refresh();}};}
function bind(id,fn){$(id).addEventListener('click',run(fn));}
function dbWrite(sql,bind){store.exec(sql,bind);}
function setTheme(){const s=store.settings();document.documentElement.dataset.theme=s.theme;const dark=s.theme==='dark'||(s.theme==='system'&&systemDark.matches);document.querySelector('meta[name="theme-color"]').content=dark?'#14101f':'#f4f0f8';for(const b of document.querySelectorAll('[data-theme-choice]'))b.setAttribute('aria-pressed',String(b.dataset.themeChoice===s.theme));$('animations-toggle').setAttribute('aria-checked',String(Boolean(s.animations)));}

function playerStrip(target,st,color){
 const g=st.game,strip=$(target);strip.replaceChildren();
 const avatar=element('div','player-avatar');const bytes=store.photo(g.id,color);
 if(bytes?.length){const img=element('img');const url=URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'}));avatarURLs.push(url);img.src=url;img.alt=playerName(g,color);avatar.append(img);}else avatar.append(pieceSVG('k',color));
 const meta=element('div','player-meta');meta.append(element('div','player-name',playerName(g,color)),element('div','player-detail',colorName(color)+' pieces'));
 strip.append(avatar,meta);
 let chip='',quiet=false;
 if(st.result==='1/2-1/2'){chip='Draw';quiet=true;}
 else if(st.result!=='*'){chip=st.result===(color==='w'?'1-0':'0-1')?'Winner':'Good game';quiet=chip!=='Winner';}
 else if(st.conflict){chip=color===st.conflict.color?'Moved twice':'Waiting';quiet=color!==st.conflict.color;}
 else if(color===st.turn)chip='To move';
 if(chip)strip.append(element('span','turn-chip'+(quiet?' quiet-chip':''),chip));
}
function renderBoard(st,u,override=null,highlight=null){
 const board=$('board'),active=document.activeElement?.dataset?.square,d=store.draft(st.game.id);
 const preview=!override&&d?store.previewDraft(st):null;
 const p=override||(preview?preview.position:st.position);
 const last=highlight||(d?{from_sq:d.from_sq,to_sq:d.to_sq}:st.last?{from_sq:st.last.from,to_sq:st.last.to}:null);
 const playable=st.result==='*'&&!st.conflict&&!d;
 const selected=playable?u.selected_square:null;
 const destinations=new Set(selected?p.legalMoves(selected).map(m=>squareName(m.to)):[]);
 const fragment=document.createDocumentFragment();
 for(let r=0;r<8;r++){
  const row=element('div','board-row');row.setAttribute('role','row');
  for(let c=0;c<8;c++){
   const index=u.orientation==='w'?r*8+c:63-(r*8+c),square=squareName(index),piece=p.at(index);
   const light=(index%8+Math.floor(index/8))%2===0;
   const button=element('button','square '+(light?'light':'dark'));button.type='button';button.dataset.square=square;button.setAttribute('role','gridcell');
   button.tabIndex=square===(active||selected||(u.orientation==='w'?'e2':'e7'))?0:-1;
   let label=square+(piece?', '+colorName(colorOf(piece))+' '+names[piece.toLowerCase()]:', empty');
   if(piece){button.classList.add('occupied');button.append(pieceSVG(piece.toLowerCase(),colorOf(piece)));}
   if(last?.from_sq===square)button.classList.add('last-from');if(last?.to_sq===square)button.classList.add('last-to');
   if(square===selected){button.classList.add('selected');label+=', selected';}
   if(destinations.has(square)){button.classList.add('legal');label+=', legal destination';}
   if(piece?.toLowerCase()==='k'&&colorOf(piece)===p.turn&&p.inCheck()){button.classList.add('check');label+=', in check';}
   button.setAttribute('aria-label',label);button.setAttribute('aria-selected',String(selected===square));
   if(c===0)button.append(element('span','coord rank',square[1]));if(r===7)button.append(element('span','coord file',square[0]));
   row.append(button);
  }fragment.append(row);
 }
 board.replaceChildren(fragment);board.dataset.orientation=u.orientation;
 if(!board.querySelector('[tabindex="0"]'))board.querySelector('button').tabIndex=0;
 if(active)board.querySelector('[data-square="'+active+'"]')?.focus({preventScroll:true});
}
function renderHistory(st){
 const rows=[];for(let i=0;i<st.history.length;i+=2){const w=st.history[i],b=st.history[i+1];const row=element('div','history-row');row.append(element('span','',i/2+1),element('span','',w.san),element('span','',b?b.san:'—'));rows.push(row);}
 $('move-history').replaceChildren(...rows);
 $('history-count').textContent=Math.ceil(st.ply/2)+' moves';
 const n=st.ignored.length;$('ignored-note').hidden=!n;if(n)$('ignored-note').textContent=n+(n===1?' move in this game could not be played and is not shown: ':' moves in this game could not be played and are not shown: ')+st.ignored.map(m=>m.san+' ('+m.why+')').join(', ')+'.';
}
function renderGames(){
 const games=store.games().filter(g=>!g.hidden&&!g.is_demo),active=store.settings().active_game_id;
 let open=0,decided=0,drawn=0;const rows=[];
 for(const g of games){const st=store.state(g.id);if(st.result==='*')open++;else if(st.result==='1/2-1/2')drawn++;else decided++;
  const outcome=st.result==='1-0'?g.white_name+' won · '+st.resultReason:st.result==='0-1'?g.black_name+' won · '+st.resultReason:st.result==='1/2-1/2'?'Draw · '+st.resultReason:st.conflict?'Two moves at once — choose one':playerName(g,st.turn)+'’s move';
  const b=element('button','game-list-row');b.type='button';b.dataset.gameOpen=g.id;if(g.id===active)b.setAttribute('aria-current','true');
  const body=element('span','game-list-body');body.append(element('strong','',g.white_name+' vs '+g.black_name),element('span','outcome',outcome),element('span','game-date',Math.ceil(st.ply/2)+' moves'));
  b.append(element('span','game-list-icon','▦'),body,element('span','','›'));rows.push([st.result==='*'?0:1,b]);}
 rows.sort((a,b)=>a[0]-b[0]);
 $('games-list').replaceChildren(...rows.map(r=>r[1]));
 if(!rows.length)$('games-list').append(element('p','fine-print','Your first match belongs here. Start a game and build your collection.'));
 $('stat-open').textContent=open;$('stat-decided').textContent=decided;$('stat-drawn').textContent=drawn;$('games-count').textContent=games.length;
}
function renderConflict(st){
 const banner=$('conflict-banner');banner.hidden=!st.conflict;if(!st.conflict)return;
 const g=st.game,c=st.conflict,who=playerName(g,c.color);
 $('conflict-title').textContent=who+' moved on two copies at the same turn.';
 $('conflict-detail').textContent='Both moves were legal, so neither copy can pick one for you. Keep the move that should stand; the other is set aside and any moves that followed it are dropped.';
 const choices=$('conflict-choices');choices.replaceChildren();
 for(const cand of c.candidates){const b=element('button','button small');b.type='button';b.textContent='Keep '+cand.san;b.addEventListener('click',run(()=>{store.resolveConflict(cand.entity);notify(cand.san+' stands. Share the board so the other copy agrees.');}));choices.append(b);}
}
function draw(){
 if(!store)return;
 const s=store.settings(),u=store.ui(),st=store.state();setTheme();
 for(const view of ['board','games','settings'])$('view-'+view).hidden=u.current_view!==view;
 for(const b of document.querySelectorAll('[data-view]')){if(b.dataset.view===u.current_view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}
 renderGames();
 $('empty-board').hidden=Boolean(st);$('game-area').hidden=!st;$('player-settings').hidden=!st;
 if(!st)return;
 const g=st.game,d=store.draft(g.id),pv=d?store.previewDraft(st):null,result=st.result!=='*';
 while(avatarURLs.length)URL.revokeObjectURL(avatarURLs.pop());
 playerStrip('top-player',st,opposite(u.orientation));playerStrip('bottom-player',st,u.orientation);
 const who=playerName(g,st.turn);
 $('turn-eyebrow').textContent=g.is_demo?'A LITTLE PRACTICE':result?'A GAME FOR THE COLLECTION':'CORRESPONDENCE CHESS';
 if(result){$('turn-title').textContent=st.result==='1/2-1/2'?'A well-played draw.':playerName(g,st.result==='1-0'?'w':'b')+' wins.';$('turn-subtitle').textContent=st.resultReason;}
 else if(st.conflict){$('turn-title').textContent='Two moves, one turn.';$('turn-subtitle').textContent=playerName(g,st.conflict.color)+' needs to choose before play goes on.';}
 else{$('turn-title').textContent=who+'’s Move';$('turn-subtitle').textContent=colorName(st.turn)+' to play · Move '+(Math.floor(st.ply/2)+1)+(st.inCheck?' · In check':'');}
 $('demo-note').hidden=!g.is_demo;
 renderConflict(st);
 if(!animating)renderBoard(st,u);
 const last=st.last;
 $('last-description').textContent=last?playerName(g,last.color)+' · '+last.san+' · '+last.from+' → '+last.to:'The story starts with the first move.';
 $('last-label').textContent=last?'LAST MOVE':'THE OPENING';
 $('replay-last').disabled=!last||Boolean(d)||animating;
 renderHistory(st);
 $('draw-banner').hidden=!(st.result==='*'&&st.drawOfferBy&&st.drawOfferBy!==st.turn);
 if(!$('draw-banner').hidden)$('draw-message').textContent=playerName(g,st.drawOfferBy)+' offered a draw. Accept it, or keep the game going.';
 $('play-move').disabled=!d||result||Boolean(st.conflict);
 $('change-move').hidden=!d||result;
 $('game-actions-button').disabled=result||Boolean(st.conflict);
 if(result){$('move-step').textContent='THE FINAL POSITION';$('move-summary').textContent=st.result==='1/2-1/2'?'Honors shared.':'A good game.';$('move-instruction').textContent='Share the result, or start another match. This one stays in your collection.';}
 else if(st.conflict){$('move-step').textContent='CHOOSE A MOVE';$('move-summary').textContent='Which one stands?';$('move-instruction').textContent='Pick one above. Then share the board so both copies agree.';}
 else if(d){$('move-step').textContent='TAKE A SECOND LOOK';$('move-summary').textContent=pv.move.san+'  ·  '+d.from_sq+' → '+d.to_sq;$('move-instruction').textContent='Nothing is final yet. Change your move, or play it.'+(pv.terminal?' '+pv.terminal.reason+' if played.':pv.claim?' '+pv.claim+' can be claimed with this move.':'')+(d.draw_offer?' A draw offer will travel with this move.':'');}
 else{$('move-step').textContent='MAKE YOUR MOVE';$('move-summary').textContent=u.selected_square?'Choose a destination.':'Pick a piece.';$('move-instruction').textContent=u.selected_square?'Only highlighted squares are legal. Tap your piece again to deselect.':'Tap one of your pieces. Its legal destinations will light up. When you play it, share the board.';}
 $('offer-state').textContent=d?.draw_offer?'Included ✓':'Not included';
 const claim=store.claimEligibility(st);$('claim-draw').disabled=!claim;$('claim-state').textContent=claim?'Available':'Not yet';$('claim-help').textContent=claim?claim.reason+(claim.where==='draft'?' is available with your tentative move.':' is available in this position.'):'Available for threefold repetition or 50 moves without a pawn move or capture.';
 for(const [input,column]of [['edit-white-name','white_name'],['edit-black-name','black_name']])if(document.activeElement!==$(input))$(input).value=g[column];
 wireIcons();
}
function showNewGame(){const s=store.settings();$('setup-you').value=s.setup_you;$('setup-them').value=s.setup_them;for(const radio of document.querySelectorAll('input[name="color"]'))radio.checked=radio.value===s.setup_color;updateColorNote();$('new-game-dialog').showModal();}
function updateColorNote(){const choice=store.settings().setup_color;$('color-note').textContent=choice==='b'?'You’ll share the starting board first so White can begin.':choice==='w'?'You make the first move.':'White moves first. Random makes the choice for you.';}
function closeDialog(dialog){if(dialog?.open)dialog.close();}
function ask(title,detail,fn,{danger=false,clear=false,label='Confirm'}={}){
 for(const d of document.querySelectorAll('dialog[open]'))d.close();
 confirmation=fn;$('confirm-title').textContent=title;$('confirm-detail').textContent=detail;$('confirm-yes').textContent=label;$('confirm-yes').className='button '+(danger?'danger':'primary');$('delete-label').hidden=!clear;$('delete-confirm-input').value='';$('confirm-yes').disabled=clear;$('confirm-dialog').showModal();
}
async function animateMove(beforeFen,m,gameId){
 if(animating)return;
 const s=store.settings();if(!s.animations||reduceMotion.matches||!Element.prototype.animate){draw();return;}
 animating=true;
 const st=store.state(),u=store.ui();if(!st||st.game.id!==gameId){animating=false;return;}
 renderBoard(st,u,new Position(beforeFen),{from_sq:m.from,to_sq:m.to});
 const board=$('board');board.classList.add('animating');
 const pairs=[[m.from,m.to]];
 if(m.flags?.includes('k'))pairs.push([m.color==='w'?'h1':'h8',m.color==='w'?'f1':'f8']);
 if(m.flags?.includes('q'))pairs.push([m.color==='w'?'a1':'a8',m.color==='w'?'d1':'d8']);
 const ghosts=[],animations=[];
 try{
  for(const [from,to]of pairs){
   const a=board.querySelector('[data-square="'+from+'"]'),b=board.querySelector('[data-square="'+to+'"]'),piece=a?.querySelector('.piece');if(!piece||!b)continue;
   const ar=a.getBoundingClientRect(),br=b.getBoundingClientRect(),base=board.getBoundingClientRect();
   const ghost=element('div','moving-piece');ghost.style.left=(ar.left-base.left)+'px';ghost.style.top=(ar.top-base.top)+'px';ghost.style.width=ar.width+'px';ghost.style.height=ar.height+'px';ghost.append(piece.cloneNode(true));piece.style.visibility='hidden';board.append(ghost);ghosts.push(ghost);
   const captured=b.querySelector('.piece');if(captured)animations.push(captured.animate([{opacity:1},{opacity:0}],{duration:220,fill:'forwards'}));
   if(m.flags?.includes('e')){const capIndex=squareIndex(to)+(m.color==='w'?8:-8);const ep=board.querySelector('[data-square="'+squareName(capIndex)+'"] .piece');if(ep)animations.push(ep.animate([{opacity:1},{opacity:0}],{duration:220,fill:'forwards'}));}
   animations.push(ghost.animate([{transform:'translate(0,0)'},{transform:'translate('+(br.left-ar.left)+'px,'+(br.top-ar.top)+'px)'}],{duration:390,easing:'cubic-bezier(.2,.8,.2,1)',fill:'forwards'}));
  }
  await Promise.allSettled(animations.map(a=>a.finished));
 }finally{for(const a of animations)a.cancel();for(const ghost of ghosts)ghost.remove();board.classList.remove('animating');animating=false;draw();}
}
async function chooseMove(from,to,promotion=null){const st=store.state();const move=store.setDraft(from,to,promotion);closeDialog($('promotion-dialog'));refresh();await animateMove(st.fen,move,st.game.id);}
function showPromotion(){const u=store.ui(),st=store.state();$('promotion-choices').replaceChildren();for(const type of ['q','r','b','n']){const button=element('button','promotion-choice');button.type='button';button.dataset.promotion=type;button.append(pieceSVG(type,st.turn),element('span','',names[type][0].toUpperCase()+names[type].slice(1)));button.addEventListener('click',run(()=>chooseMove(u.promotion_from,u.promotion_to,type)));$('promotion-choices').append(button);}$('promotion-dialog').showModal();}
async function clickSquare(square){
 if(animating)return;
 const st=store.playable(),u=store.ui();if(store.draft(st.game.id)){notify('Choose Change move to try another idea.');return;}
 const p=st.position,piece=p.at(square);
 if(u.selected_square===square){store.select(null);return;}
 if(u.selected_square){const legal=p.legalMoves(u.selected_square).filter(m=>squareName(m.to)===square);if(legal.length){if(legal[0].promotion){store.startPromotion(u.selected_square,square);showPromotion();return;}await chooseMove(u.selected_square,square);return;}}
 if(piece&&colorOf(piece)===st.turn){store.select(square);if(!p.legalMoves(square).length)notify('This '+names[piece.toLowerCase()]+' has no legal moves right now.');}
 else if(u.selected_square)notify('Choose one of the highlighted legal squares.');
 else notify('It’s '+playerName(st.game,st.turn)+'’s turn. Choose a '+colorName(st.turn).toLowerCase()+' piece.');
}
function replay(){const st=store.state(),m=st?.last;if(!m||store.draft(st.game.id)||animating)return;return animateMove(m.before,m,st.game.id);}
function playMove(){
 const r=store.playDraft();
 notify(r.terminal?r.move.san+' · '+r.terminal.reason+'. Share the result.':r.move.san+' is played. Share the board when you’re ready.');
 store.faceMover();
}
function share(){
 // Keep this call inside the click gesture. The host seals and sends the document; the app has nothing to stage.
 if(typeof window.dai?.requestShare!=='function')throw new Error('Sharing is available in the DAI opener. Open this document there to share its card.');
 const st=store.state();if(st?.game.is_demo)throw new Error('This is a practice board. Start your own game to share it.');
 if(store.draft(st?.game.id))notify('Your tentative move stays with you. Play it first if you want it to travel.');
 return window.dai.requestShare();
}
function wire(){
 wireIcons();
 for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',run(()=>store.switchView(button.dataset.view)));
 for(const button of document.querySelectorAll('[data-new-game]'))button.addEventListener('click',run(showNewGame));
 for(const button of document.querySelectorAll('[data-close-dialog]'))button.addEventListener('click',()=>closeDialog(button.closest('dialog')));
 $('board').addEventListener('click',run(event=>{const sq=event.target.closest('[data-square]');if(sq)return clickSquare(sq.dataset.square);}));
 $('board').addEventListener('keydown',run(event=>{
  const cells=[...$('board').querySelectorAll('[data-square]')],at=cells.indexOf(event.target);if(at<0)return;
  const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-8,ArrowDown:8}[event.key];
  if(delta!==undefined){event.preventDefault();const row=Math.floor(at/8),col=at%8;let next=at;if(event.key==='ArrowLeft'&&col>0)next--;if(event.key==='ArrowRight'&&col<7)next++;if(event.key==='ArrowUp'&&row>0)next-=8;if(event.key==='ArrowDown'&&row<7)next+=8;cells[at].tabIndex=-1;cells[next].tabIndex=0;cells[next].focus();}
  else if(event.key==='Escape'){event.preventDefault();dbWrite('UPDATE ui_state SET selected_square = NULL WHERE id = 1');}
 }));
 bind('play-move',playMove);
 bind('change-move',()=>store.clearDraft());bind('share',share);bind('replay-last',replay);
 bind('game-actions-button',()=>{draw();$('actions-dialog').showModal();});
 bind('offer-draw',()=>{const on=store.toggleDrawOffer();notify(on?'A draw offer will travel with your move.':'Draw offer removed.');draw();});
 bind('accept-draw',()=>{const st=store.state();ask('Call it a draw?','Accept '+playerName(st.game,st.drawOfferBy)+'’s offer and end this game. Share the result afterward.',()=>store.acceptDraw(),{label:'Accept draw'});});
 bind('decline-draw',()=>store.declineDraw());
 bind('resign',()=>{const st=store.state();ask('Resign as '+playerName(st.game,st.turn)+'?','This ends the game and discards any tentative move. '+playerName(st.game,opposite(st.turn))+' wins unless no checkmate is possible. Share the result afterward.',()=>store.resign(),{danger:true,label:'Resign game'});});
 bind('claim-draw',()=>{const e=store.claimEligibility();if(!e)return;ask('Claim a draw?',e.reason+(e.where==='draft'?' applies to your tentative move. It will be played and the draw claimed.':' applies to the current position. This ends the game.'),()=>store.claimDraw(),{label:'Claim draw'});});
 bind('cancel-promotion',()=>{store.cancelPromotion();closeDialog($('promotion-dialog'));});
 $('promotion-dialog').addEventListener('cancel',run(event=>{event.preventDefault();store.cancelPromotion();closeDialog($('promotion-dialog'));}));
 $('new-game-form').addEventListener('submit',run(event=>{event.preventDefault();if(!$('new-game-form').reportValidity())return;store.createGame();closeDialog($('new-game-dialog'));$('view-board').scrollIntoView({block:'start',behavior:'instant'});notify('Your new game is ready.');}));
 for(const [input,sql]of [['setup-you','UPDATE settings SET setup_you = ? WHERE id = 1'],['setup-them','UPDATE settings SET setup_them = ? WHERE id = 1']])$(input).addEventListener('input',run(event=>dbWrite(sql,[event.target.value])));
 for(const radio of document.querySelectorAll('input[name="color"]'))radio.addEventListener('change',run(()=>{if(radio.checked)dbWrite('UPDATE settings SET setup_color = ? WHERE id = 1',[radio.value]);updateColorNote();}));
 for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',run(()=>dbWrite('UPDATE settings SET theme = ? WHERE id = 1',[button.dataset.themeChoice])));
 bind('animations-toggle',()=>dbWrite('UPDATE settings SET animations = 1 - animations WHERE id = 1'));
 $('rename-form').addEventListener('submit',run(event=>{event.preventDefault();store.rename($('edit-white-name').value,$('edit-black-name').value);notify('Player names updated. They reach the other copy on the next share.');}));
 bind('remove-photos',()=>dbWrite('DELETE FROM photos WHERE game_id = (SELECT active_game_id FROM settings WHERE id = 1)'));
 bind('clear-data',()=>ask('Clear all data?','This hides every game in this copy and removes your names, photos and options. Moves already shared stay in the game.',()=>{store.clearAll();notify('This copy is clear. Start a fresh game.');},{danger:true,clear:true,label:'Clear All Data'}));
 $('delete-confirm-input').addEventListener('input',()=>{$('confirm-yes').disabled=$('delete-confirm-input').value.trim()!=='CLEAR';});
 bind('confirm-no',()=>{confirmation=null;closeDialog($('confirm-dialog'));});
 bind('confirm-yes',()=>{if(!$('delete-label').hidden&&$('delete-confirm-input').value.trim()!=='CLEAR')return;const fn=confirmation;confirmation=null;closeDialog($('confirm-dialog'));if(fn)fn();});
 $('confirm-dialog').addEventListener('cancel',()=>{confirmation=null;});
 $('games-list').addEventListener('click',run(event=>{const b=event.target.closest('[data-game-open]');if(b)store.openGame(b.dataset.gameOpen);}));
 systemDark.addEventListener('change',()=>{if(store)setTheme();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&store)draw();});
 new MutationObserver(()=>{if(!redrawQueued){redrawQueued=true;queueMicrotask(()=>{redrawQueued=false;try{draw();}catch(e){notify(e.message);}});}}).observe($('kit-refresh-signal'),{childList:true,characterData:true,subtree:true});
}
async function boot(){
 if(!window.dai){$('boot-notice').textContent='This is the source app for DAI. Import the ZIP into your DAI builder, then open the sealed document in the DAI opener. The opener supplies the database, offline runtime, and share card.';return;}
 await customElements.whenDefined('dai-rows');
 // ASSUMPTION (for the kit team): the replicated-row writer is exposed as window.dai.replicated with
 // insert(table, values) -> entity hex, change(table, entity, values) -> entity hex, remove(table, entity) -> entity hex.
 // Every replicated write in store.js goes through this one object, so a different surface is a one-line remap here.
 const writer=window.dai.replicated;
 if(!writer)throw new Error('This document needs the replicated-tables runtime. Open it in a newer DAI opener.');
 store=new Store(window.daiKit.db,writer);store.bootstrap();wire();refresh();$('boot-notice').hidden=true;$('app').hidden=false;
 // After a merge the host tells the frame; redraw so a newly arrived move or conflict shows without a reload.
 window.addEventListener('dai:merged',()=>{store.faceMover();refresh();});
 const st=store.state();if(st?.last&&!store.draft(st.game.id))requestAnimationFrame(()=>{replay()?.catch?.(e=>notify(e.message));});
}
boot().catch(error=>{console.error(error);$('boot-notice').hidden=false;$('boot-notice').textContent='Your board could not be opened safely. '+error.message;});
