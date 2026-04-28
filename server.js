const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const DECKS = 6;
const EAGLES = 6; // 本版本按“带鹰”独立牌处理：全局 6 张鹰，最大，可挂任意套牌。
const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2','小王','大王','鹰'];
const rankValue = Object.fromEntries(RANKS.map((r,i)=>[r,i+3]));
const TEAM = [0,1,0,1,0,1];

function roomCode(){ return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function makeDeck(){
  const suits = ['♠','♥','♣','♦'];
  const ranks = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
  const deck=[];
  for(let d=0; d<DECKS; d++) {
    for(const s of suits) for(const r of ranks) deck.push({id:`${d}-${s}-${r}`, r, s, v:rankValue[r]});
    deck.push({id:`${d}-BJ`, r:'大王', s:'🃏', v:rankValue['大王']});
    deck.push({id:`${d}-SJ`, r:'小王', s:'🃏', v:rankValue['小王']});
  }
  for(let i=0; i<EAGLES; i++) deck.push({id:`EAGLE-${i}`, r:'鹰', s:'🦅', v:rankValue['鹰']});
  return deck;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function sortHand(h){ h.sort((a,b)=> b.v-a.v || a.r.localeCompare(b.r) || a.s.localeCompare(b.s)); }
function publicState(room){
  return {
    code:room.code,
    started:room.started,
    seats:room.seats.map(p=>p?{name:p.name, cards:p.hand.length, online:p.online, team:TEAM[p.seat]}:null),
    turn:room.turn,
    passCount:room.passCount,
    lastPlay:room.lastPlay,
    finishOrder:room.finishOrder,
    log:room.log.slice(-20),
    settings:room.settings
  };
}
function emitRoom(room){
  io.to(room.code).emit('state', publicState(room));
  for(const p of room.seats){ if(p?.socketId) io.to(p.socketId).emit('hand', p.hand); }
}
function createRoom(){
  const code=roomCode();
  const room={code, seats:Array(6).fill(null), started:false, turn:null, passCount:0, lastPlay:null, finishOrder:[], log:[], settings:{decks:DECKS, eagles:EAGLES, burn:true, tribute:true}};
  rooms.set(code, room); return room;
}
function nextActive(room, from){
  for(let i=1;i<=6;i++){ const n=(from+i)%6; const p=room.seats[n]; if(p && p.hand.length && !room.finishOrder.includes(n)) return n; }
  return from;
}
function isWild(c){ return c.r==='大王' || c.r==='小王' || c.r==='鹰'; }
function parsePlay(cards){
  if(!cards.length) return null;
  const wilds = cards.filter(isWild);
  const normals = cards.filter(c=>!isWild(c));
  const counts={}; for(const c of normals) counts[c.r]=(counts[c.r]||0)+1;
  const ranks=Object.keys(counts);
  if(ranks.length>1) return null;
  const main = ranks[0] || cards.reduce((best,c)=> c.v>best.v?c:best, cards[0]).r;
  const topWild = wilds.reduce((m,c)=>Math.max(m,c.v), 0);
  const eagleCount = wilds.filter(c=>c.r==='鹰').length;
  // 够级套牌简化比较：必须同张数；先比最大挂牌/鹰，再比主体点数。
  return {kind:'set', count:cards.length, main, value:rankValue[main], topWild, eagleCount, text: `${cards.length}张${main}${wilds.length?` 挂${wilds.length}张`:''}`};
}
function canBeat(play, last){
  if(!last) return true;
  if(play.count !== last.count) return false;
  if(play.topWild !== last.topWild) return play.topWild > last.topWild;
  if(play.eagleCount !== last.eagleCount) return play.eagleCount > last.eagleCount;
  return play.value > last.value;
}
function deal(room){
  const deck=shuffle(makeDeck());
  room.seats.forEach(p=>p.hand=[]);
  deck.forEach((card,i)=> room.seats[i%6].hand.push(card));
  room.seats.forEach(p=>sortHand(p.hand));
  room.started=true; room.turn=0; room.passCount=0; room.lastPlay=null; room.finishOrder=[];
  room.log.push(`开局：6 副牌 + ${EAGLES} 张鹰，共 ${deck.length} 张，每人约 ${Math.floor(deck.length/6)} 张。`);
  room.log.push('带鹰规则：鹰为最大挂牌，可挂任意同点数组合；本原型先支持同点数组合出牌。');
}
function autoTributeSummary(room){
  if(room.finishOrder.length!==6) return;
  room.log.push('落贡提示：头科下局吃大落贡；二科吃二落贡。烧/闷/点贡可按地方规则继续扩展。');
}
function join(room, socket, name){
  const existing = room.seats.find(p=>p && !p.online && p.name===name);
  if(existing){ existing.socketId=socket.id; existing.online=true; socket.join(room.code); socket.data.room=room.code; socket.data.seat=existing.seat; room.log.push(`${name} 重连 ${existing.seat+1} 号位。`); emitRoom(room); return existing.seat; }
  let seat=room.seats.findIndex(p=>!p); if(seat<0) return -1;
  const player={seat,name,socketId:socket.id,online:true,hand:[]}; room.seats[seat]=player; socket.join(room.code); socket.data.room=room.code; socket.data.seat=seat; room.log.push(`${name} 入座 ${seat+1} 号位。`); emitRoom(room); return seat;
}

io.on('connection', socket=>{
  socket.on('createRoom', ({name}, cb)=>{ const room=createRoom(); const seat=join(room, socket, name||'玩家'); cb?.({code:room.code, seat}); });
  socket.on('joinRoom', ({code,name}, cb)=>{ const room=rooms.get(String(code||'').toUpperCase()); if(!room) return cb?.({error:'房间不存在'}); const seat=join(room, socket, name||'玩家'); if(seat<0) return cb?.({error:'房间已满'}); cb?.({code:room.code, seat}); });
  socket.on('start', ()=>{ const room=rooms.get(socket.data.room); if(!room) return; if(room.seats.filter(Boolean).length!==6) return socket.emit('toast','需要 6 人满员才能开始'); deal(room); emitRoom(room); });
  socket.on('play', ids=>{
    const room=rooms.get(socket.data.room); if(!room || !room.started) return;
    const seat=socket.data.seat, p=room.seats[seat];
    if(room.turn!==seat) return socket.emit('toast','还没轮到你');
    const chosen = ids.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean);
    if(chosen.length !== ids.length) return socket.emit('toast','选牌异常，请重新选择');
    const play=parsePlay(chosen);
    if(!play) return socket.emit('toast','当前版本支持：同一点数的一套牌，可带大王/小王/鹰挂牌');
    if(!canBeat(play, room.lastPlay?.play)) return socket.emit('toast','必须同张数，且挂牌/点数更大才能管上家');
    p.hand = p.hand.filter(c=>!ids.includes(c.id));
    room.lastPlay={seat, cards:chosen, play, text:`${p.name} 出 ${chosen.map(c=>c.s+c.r).join(' ')}`}; room.passCount=0;
    room.log.push(room.lastPlay.text);
    if(p.hand.length===0 && !room.finishOrder.includes(seat)){
      room.finishOrder.push(seat); room.log.push(`${p.name} 走科，第 ${room.finishOrder.length} 名。`);
      if(room.finishOrder.length===5){ const last=room.seats.findIndex((x,i)=>x&&!room.finishOrder.includes(i)); room.finishOrder.push(last); room.log.push(`${room.seats[last].name} 为末科。`); autoTributeSummary(room); room.started=false; }
    }
    if(room.started) room.turn=nextActive(room, seat); emitRoom(room);
  });
  socket.on('pass', ()=>{ const room=rooms.get(socket.data.room); if(!room||!room.started) return; const seat=socket.data.seat; if(room.turn!==seat) return socket.emit('toast','还没轮到你'); room.log.push(`${room.seats[seat].name} 过牌。`); room.passCount++; if(room.passCount>=5){ room.log.push('一圈没人管，清桌，最后出牌者重新开牌。'); const opener = room.lastPlay?.seat ?? seat; room.lastPlay=null; room.passCount=0; room.turn=opener; return emitRoom(room); } room.turn=nextActive(room, seat); emitRoom(room); });
  socket.on('disconnect', ()=>{ const room=rooms.get(socket.data.room); if(!room) return; const p=room.seats[socket.data.seat]; if(p){p.online=false; p.socketId=null; room.log.push(`${p.name} 掉线。`); emitRoom(room);} });
});
server.listen(process.env.PORT||3000, ()=>console.log('6副牌带鹰够级 http://localhost:'+(process.env.PORT||3000)));
