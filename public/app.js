const socket = io({ transports: ['websocket', 'polling'] });
let mySeat = null, hand = [], state = null, selected = new Set();
const $ = id => document.getElementById(id);
const qs = new URLSearchParams(location.search);

function toast(t){
  $('toast').textContent = t;
  $('toast').style.display = 'block';
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => $('toast').style.display = 'none', 1900);
}
function roomLink(){ return location.origin + location.pathname + '?room=' + (state?.code || $('code').textContent || ''); }
function defaultName(){ return localStorage.goujiName || ('玩家' + Math.floor(Math.random()*90+10)); }
function saveName(){ const name = ($('name').value || defaultName()).trim(); localStorage.goujiName = name; return name; }

$('name').value = defaultName();
if (qs.get('room')) $('joinCode').value = qs.get('room').toUpperCase();

$('create').onclick = () => socket.emit('createRoom', { name: saveName() }, res => res?.error ? toast(res.error) : enter(res));
$('quickTest').onclick = () => socket.emit('createRoom', { name: saveName() }, res => { if(res?.error) return toast(res.error); enter(res); setTimeout(()=>socket.emit('testMode'), 150); });
$('join').onclick = () => joinRoom();
$('joinCode').oninput = () => $('joinCode').value = $('joinCode').value.toUpperCase();
function joinRoom(){
  const code = $('joinCode').value.trim().toUpperCase();
  if(!code) return toast('请输入房间码');
  socket.emit('joinRoom', { code, name: saveName() }, res => res?.error ? toast(res.error) : enter(res));
}
function enter(res){
  mySeat = res.seat;
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  history.replaceState(null, '', '?room=' + res.code);
  $('code').textContent = res.code;
  toast(`已入座 ${res.seat + 1} 号位`);
}
$('copy').onclick = async () => {
  const link = roomLink();
  try {
    if (navigator.share && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)) {
      await navigator.share({ title: '来打6副牌带鹰够级', text: '点开加入我的6副牌带鹰够级房间', url: link });
      return;
    }
    await navigator.clipboard.writeText(link);
    toast('邀请链接已复制');
  } catch {
    await navigator.clipboard?.writeText(link).catch(()=>{});
    toast('邀请链接：' + link);
  }
};
$('start').onclick = () => socket.emit('start');
$('testMode').onclick = () => socket.emit('testMode');
$('pass').onclick = () => socket.emit('pass');
$('play').onclick = () => {
  if(!selected.size) return toast('先点选要出的牌');
  socket.emit('play', [...selected]);
  selected.clear();
  renderHand();
};

socket.on('connect', () => { if(qs.get('room') && !$('lobby').classList.contains('hidden')) toast('输入昵称后点加入房间'); });
socket.on('toast', toast);
socket.on('hand', h => { hand = h || []; selected.clear(); renderHand(); });
socket.on('state', s => { state = s; $('code').textContent = s.code; renderState(); });

function renderState(){
  const center = `<div class="centerMat"><div id="turn" class="turnText"></div><div id="last" class="lastPlay"></div></div>`;
  $('seats').innerHTML = center;
  state.seats.forEach((p,i) => {
    const d = document.createElement('div');
    d.className = `seat p${i} ${i===mySeat?'me':''} ${state.turn===i?'turn':''} ${p?'':'empty'} ${p?.robot?'robot':''}`;
    if(p){
      d.innerHTML = `<b>${i+1}号 ${escapeHtml(p.name)}</b><span class="badge">联邦${p.team+1}</span><em>${p.cards}张</em><span class="${p.online?'':'offline'}">${p.robot?'AI托管':(p.online?'在线':'离线')}</span>`;
    } else {
      d.innerHTML = `<b>${i+1}号 空位</b><span class="badge">待加入</span><em>--</em><span>邀请中</span>`;
    }
    $('seats').appendChild(d);
  });
  $('turn').textContent = state.started ? `轮到 ${state.turn + 1} 号位${state.seats[state.turn]?.robot?' · AI思考中':''}` : '等待开局 / 本局结束';
  $('last').textContent = state.lastPlay ? state.lastPlay.text : '桌面为空：可任意出同点数组合；鹰最大，可挂牌';
  $('log').innerHTML = state.log.map(x => `<div>${escapeHtml(x)}</div>`).join('');
  $('start').style.display = state.started ? 'none' : 'block';
  $('testMode').style.display = state.started ? 'none' : 'block';
}
function renderHand(){
  $('cards').innerHTML = '';
  hand.forEach(c => {
    const d = document.createElement('div');
    d.className = 'card ' + (/[♥♦]/.test(c.s) ? 'red ' : '') + (c.r==='鹰' ? 'eagle ' : '') + (selected.has(c.id) ? 'sel' : '');
    d.innerHTML = `<span>${escapeHtml(c.r)}</span><small>${escapeHtml(c.s)}</small>`;
    d.onclick = () => { selected.has(c.id) ? selected.delete(c.id) : selected.add(c.id); renderHand(); };
    $('cards').appendChild(d);
  });
  $('selectedInfo').textContent = selected.size ? `已选 ${selected.size} 张` : `共 ${hand.length} 张`;
}
function escapeHtml(str){ return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
