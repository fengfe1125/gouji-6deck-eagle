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
const EAGLES = 6;
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
function createRoom(){
  const code=roomCode();
  const room={code,seats:Array(6).fill(null),started:false,turn:null,passCount:0,lastPlay:null,finishOrder:[],log:[],settings:{decks:DECKS,eagles:EAGLES,burn:true,tribute:true,testMode:false},robotTimer:null};
  rooms.set(code, room); return room;
}
function publicState(room){
  return {code:room.code,started:room.started,seats:room.seats.map(p=>p?{name:p.name,cards:p.hand.length,online:p.online,team:TEAM[p.seat],robot:!!p.robot}:null),turn:room.turn,passCount:room.passCount,lastPlay:room.lastPlay,finishOrder:room.finishOrder,log:room.log.slice(-28),settings:room.settings};
}
function emitRoom(room){ io.to(room.code).emit('state', publicState(room)); for(const p of room.seats){ if(p?.socketId) io.to(p.socketId).emit('hand', p.hand); } scheduleRobot(room); }
function nextActive(room, from){ for(let i=1;i<=6;i++){ const n=(from+i)%6; const p=room.seats[n]; if(p && p.hand.length && !room.finishOrder.includes(n)) return n; } return from; }
function isWild(c){ return c.r==='大王'||c.r==='小王'||c.r==='鹰'; }
function parsePlay(cards){
  if(!cards.length) return null;
  const wilds=cards.filter(isWild), normals=cards.filter(c=>!isWild(c));
  const counts={}; for(const c of normals) counts[c.r]=(counts[c.r]||0)+1;
  const ranks=Object.keys(counts); if(ranks.length>1) return null;
  const main=ranks[0] || cards.reduce((best,c)=>c.v>best.v?c:best,cards[0]).r;
  const topWild=wilds.reduce((m,c)=>Math.max(m,c.v),0);
  const eagleCount=wilds.filter(c=>c.r==='鹰').length;
  return {kind:'set',count:cards.length,main,value:rankValue[main],topWild,eagleCount,text:`${cards.length}张${main}${wilds.length?` 挂${wilds.length}张`:''}`};
}
function canBeat(play,last){ if(!last) return true; if(play.count!==last.count) return false; if(play.topWild!==last.topWild) return play.topWild>last.topWild; if(play.eagleCount!==last.eagleCount) return play.eagleCount>last.eagleCount; return play.value>last.value; }
function deal(room){ const deck=shuffle(makeDeck()); room.seats.forEach(p=>p.hand=[]); deck.forEach((card,i)=>room.seats[i%6].hand.push(card)); room.seats.forEach(p=>sortHand(p.hand)); room.started=true; room.turn=0; room.passCount=0; room.lastPlay=null; room.finishOrder=[]; room.log.push(`开局：6 副牌 + ${EAGLES} 张鹰，共 ${deck.length} 张，每人 55 张。`); room.log.push('测试人机：能管则用最小组合管；不能管则过牌；开牌优先出最小同点数组合。'); }
function autoTributeSummary(room){ if(room.finishOrder.length===6) room.log.push('落贡提示：头科下局吃大落贡；二科吃二落贡。烧/闷/点贡可继续扩展。'); }
function join(room,socket,name){ const existing=room.seats.find(p=>p&&!p.online&&!p.robot&&p.name===name); if(existing){ existing.socketId=socket.id; existing.online=true; socket.join(room.code); socket.data.room=room.code; socket.data.seat=existing.seat; room.log.push(`${name} 重连 ${existing.seat+1} 号位。`); emitRoom(room); return existing.seat; } const seat=room.seats.findIndex(p=>!p); if(seat<0) return -1; const player={seat,name,socketId:socket.id,online:true,robot:false,hand:[]}; room.seats[seat]=player; socket.join(room.code); socket.data.room=room.code; socket.data.seat=seat; room.log.push(`${name} 入座 ${seat+1} 号位。`); emitRoom(room); return seat; }
function fillRobots(room){ for(let i=0;i<6;i++){ if(!room.seats[i]) room.seats[i]={seat:i,name:`够级AI-${i+1}`,socketId:null,online:true,robot:true,hand:[]}; } room.settings.testMode=true; room.log.push('已开启测试模式：空位由 5 个够级 AI 接管。'); }
function chooseRobotPlay(room,p){
  const groups=new Map(); const wilds=p.hand.filter(isWild);
  for(const c of p.hand.filter(c=>!isWild(c))){ if(!groups.has(c.r)) groups.set(c.r,[]); groups.get(c.r).push(c); }
  const candidates=[];
  for(const [r,cards] of groups){ for(let n=1;n<=cards.length;n++){ candidates.push(cards.slice(0,n)); if(wilds.length && n<6) candidates.push(cards.slice(0,n).concat(wilds.slice(-1))); } }
  for(const w of wilds) candidates.push([w]);
  candidates.sort((a,b)=>{ const pa=parsePlay(a), pb=parsePlay(b); return a.length-b.length || pa.topWild-pb.topWild || pa.value-pb.value; });
  if(!room.lastPlay) return candidates[0] || [];
  return candidates.find(cs=>{ const pl=parsePlay(cs); return pl && canBeat(pl, room.lastPlay.play); }) || [];
}
function finishIfNeeded(room,p){ if(p.hand.length===0&&!room.finishOrder.includes(p.seat)){ room.finishOrder.push(p.seat); room.log.push(`${p.name} 走科，第 ${room.finishOrder.length} 名。`); if(room.finishOrder.length===5){ const last=room.seats.findIndex((x,i)=>x&&!room.finishOrder.includes(i)); room.finishOrder.push(last); room.log.push(`${room.seats[last].name} 为末科。`); autoTributeSummary(room); room.started=false; } } }
function applyPlay(room,seat,ids,byRobot=false){ const p=room.seats[seat]; const chosen=ids.map(id=>p.hand.find(c=>c.id===id)).filter(Boolean); if(chosen.length!==ids.length) return '选牌异常'; const play=parsePlay(chosen); if(!play) return '当前版本支持同一点数的一套牌，可带大王/小王/鹰挂牌'; if(!canBeat(play,room.lastPlay?.play)) return '必须同张数，且挂牌/点数更大才能管上家'; p.hand=p.hand.filter(c=>!ids.includes(c.id)); room.lastPlay={seat,cards:chosen,play,text:`${p.name}${byRobot?' 🤖':''} 出 ${chosen.map(c=>c.s+c.r).join(' ')}`}; room.passCount=0; room.log.push(room.lastPlay.text); finishIfNeeded(room,p); if(room.started) room.turn=nextActive(room,seat); return null; }
function robotPass(room,seat){ room.log.push(`${room.seats[seat].name} 🤖 过牌。`); room.passCount++; if(room.passCount>=5){ room.log.push('一圈没人管，清桌，最后出牌者重新开牌。'); const opener=room.lastPlay?.seat??seat; room.lastPlay=null; room.passCount=0; room.turn=opener; } else room.turn=nextActive(room,seat); }
function scheduleRobot(room){ if(room.robotTimer||!room.started) return; const p=room.seats[room.turn]; if(!p?.robot) return; room.robotTimer=setTimeout(()=>{ room.robotTimer=null; if(!room.started||!room.seats[room.turn]?.robot) return; const rp=room.seats[room.turn]; const chosen=chooseRobotPlay(room,rp); if(chosen.length) applyPlay(room,rp.seat,chosen.map(c=>c.id),true); else robotPass(room,rp.seat); emitRoom(room); },650); }

io.on('connection', socket=>{
  socket.on('createRoom',({name},cb)=>{const room=createRoom(); const seat=join(room,socket,name||'玩家'); cb?.({code:room.code,seat});});
  socket.on('joinRoom',({code,name},cb)=>{const room=rooms.get(String(code||'').toUpperCase()); if(!room) return cb?.({error:'房间不存在'}); const seat=join(room,socket,name||'玩家'); if(seat<0) return cb?.({error:'房间已满'}); cb?.({code:room.code,seat});});
  socket.on('start',()=>{const room=rooms.get(socket.data.room); if(!room) return; if(room.seats.filter(Boolean).length!==6) return socket.emit('toast','需要 6 人满员才能开始，或点击测试模式'); deal(room); emitRoom(room);});
  socket.on('testMode',()=>{const room=rooms.get(socket.data.room); if(!room) return; fillRobots(room); deal(room); emitRoom(room);});
  socket.on('play',ids=>{const room=rooms.get(socket.data.room); if(!room||!room.started) return; const seat=socket.data.seat; if(room.turn!==seat) return socket.emit('toast','还没轮到你'); const err=applyPlay(room,seat,ids,false); if(err) return socket.emit('toast',err); emitRoom(room);});
  socket.on('pass',()=>{const room=rooms.get(socket.data.room); if(!room||!room.started) return; const seat=socket.data.seat; if(room.turn!==seat) return socket.emit('toast','还没轮到你'); robotPass(room,seat); emitRoom(room);});
  socket.on('disconnect',()=>{const room=rooms.get(socket.data.room); if(!room) return; const p=room.seats[socket.data.seat]; if(p&&!p.robot){p.online=false;p.socketId=null;room.log.push(`${p.name} 掉线。`);emitRoom(room);}});
});
server.listen(process.env.PORT||3000,()=>console.log('6副牌带鹰够级 http://localhost:'+(process.env.PORT||3000)));
