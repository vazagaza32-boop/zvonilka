// zvonilka — клиентская логика
'use strict';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Константы и состояние
// ---------------------------------------------------------------------------

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const EMOJIS = ['😎','🤙','👽','🐸','🔥','⚡','🥶','👾','🦄','🍕','🚀','💀','🧃','🎧'];
const COLORS = ['#7c5cff','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#8b5cf6','#10b981'];

const state = {
  ws: null,
  id: null,
  token: null,
  room: 'general',
  profile: { name: '', color: '#7c5cff', avatarEmoji: '😎', status: '' },
  peers: [],          // участники комнаты
  view: 'chat',       // chat | voice
  // звонок
  inCall: false,
  callPeerId: null,
  callPeerName: '',
  callPeerAvatar: '',
  pc: null,           // RTCPeerConnection
  localStream: null,
  remoteStream: null,
  muted: false,
  deafened: false,
  incomingFrom: null, // {id,name,avatar}
  callStart: 0,
  // пинг
  pingRtt: null,
  pendingPing: 0,
};

let typingTimer = null;

// ---------------------------------------------------------------------------
// Инициализация
// ---------------------------------------------------------------------------

function init() {
  buildAvatarPicker();
  buildColorPicker();

  // сохранённый профиль
  const savedToken = localStorage.getItem('zvonilka:token');
  const savedName = localStorage.getItem('zvonilka:name');
  if (savedToken) state.token = savedToken;
  if (savedName) $('loginName').value = savedName;

  // ссылка-приглашение / комната из URL
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room') || params.get('r');
  if (roomParam) $('loginRoom').value = roomParam;

  $('loginGo').addEventListener('click', doLogin);
  $('loginName').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('loginRoom').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  bindChat();
  bindVoice();
  bindSettings();
  bindCalls();
}

function doLogin() {
  const name = $('loginName').value.trim();
  const room = ($('loginRoom').value.trim() || 'general').toLowerCase();
  if (!name) { $('loginName').focus(); return; }

  state.room = room;
  state.profile.name = name;
  if (!state.profile.avatarEmoji) state.profile.avatarEmoji = '😎';

  localStorage.setItem('zvonilka:name', name);

  connect();
  $('loginOverlay').hidden = true;
  updateMe();
  updateRoomTitle();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    console.log('[ws] connected');
    ws.send(JSON.stringify({
      type: 'hello',
      name: state.profile.name,
      token: state.token,
      room: state.room,
      color: state.profile.color,
      avatarEmoji: state.profile.avatarEmoji,
      status: state.profile.status,
    }));
    startPing();
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  };

  ws.onclose = () => {
    console.warn('[ws] closed, reconnect…');
    stopPing();
    renderMembers([]);
    setTimeout(() => { if (!state.token || state.ws.readyState === 3) connect(); }, 1500);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Обработка входящих сообщений
// ---------------------------------------------------------------------------

function handle(msg) {
  switch (msg.type) {
    case 'welcome':
      state.id = msg.id;
      if (msg.token && !state.token) {
        state.token = msg.token;
        localStorage.setItem('zvonilka:token', msg.token);
      }
      state.profile = msg.profile;
      state.room = msg.room;
      updateMe();
      updateRoomTitle();
      systemMessage('Ты в комнате «' + state.room + '» 🤙');
      break;

    case 'profile:set':
      state.profile = msg.profile;
      updateMe();
      renderMembers(state.peers);
      break;

    case 'peers':
      state.peers = msg.peers || [];
      renderMembers(state.peers);
      renderOnlineChips();
      renderVoicePeers();
      break;

    case 'chat':
      appendMessage({
        name: msg.name, color: msg.color, avatarEmoji: msg.avatarEmoji,
        text: msg.text, ts: msg.ts, self: msg.from === state.id,
      });
      clearTyping(msg.from);
      break;

    case 'typing':
      if (msg.from !== state.id) showTyping(msg.name, msg.from);
      break;

    // --- WebRTC сигналинг ---
    case 'rtc':
      handleSignal(msg);
      break;

    case 'rtc:cancel':
      cancelIncoming(msg.from);
      break;

    case 'rtc:error':
      if (msg.reason === 'peer-offline') {
        endCall();
        toast('Собеседник офлайн');
      }
      break;

    case 'pong':
      state.pingRtt = Date.now() - state.pendingPing;
      updateLatency();
      break;
  }
}

// ---------------------------------------------------------------------------
// Пинг
// ---------------------------------------------------------------------------

function startPing() { if (!state.pingTimer) state.pingTimer = setInterval(pingOnce, 5000); }
function stopPing() { clearInterval(state.pingTimer); state.pingTimer = null; }

function pingOnce() {
  state.pendingPing = Date.now();
  send({ type: 'ping' });
}

function updateLatency() {
  const el = $('latency');
  if (state.pingRtt == null) { el.textContent = '— мс'; return; }
  el.textContent = state.pingRtt + ' мс';
  el.className = 'latency ' + (state.pingRtt < 50 ? 'latency--good' : state.pingRtt < 150 ? 'latency--warn' : 'latency--bad');
}

// ---------------------------------------------------------------------------
// Чат
// ---------------------------------------------------------------------------

function bindChat() {
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    input.value = '';
    clearTyping(state.id);
  });

  $('chatInput').addEventListener('input', () => {
    send({ type: 'typing' });
  });
}

function appendMessage({ name, color, avatarEmoji, text, ts, self }) {
  const list = $('messages');
  const div = document.createElement('div');
  div.className = 'msg' + (self ? ' msg--self' : '');

  const time = new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  if (name) {
    div.innerHTML =
      `<div class="msg__avatar" style="${self ? '' : ''}">${escapeHtml(avatarEmoji || '😎')}</div>` +
      `<div class="msg__body">` +
        `<div class="msg__head">` +
          `<span class="msg__name" style="color:${color}">${escapeHtml(name)}</span>` +
          `<span class="msg__time">${time}</span>` +
        `</div>` +
        `<div class="msg__text">${escapeHtml(text)}</div>` +
      `</div>`;
  } else {
    div.innerHTML = `<span>${escapeHtml(text)}</span>`;
    div.classList.add('msg--system');
  }

  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function systemMessage(text) {
  appendMessage({ name: null, text });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- индикатор "печатает" ---
const typingUsers = new Map();

function showTyping(name, id) {
  typingUsers.set(id, { name, ts: Date.now() });
  renderTyping();
  clearTimeout(typingUsers.get(id)._timer);
  typingUsers.get(id)._timer = setTimeout(() => { clearTyping(id); }, 3000);
}

function clearTyping(id) {
  typingUsers.delete(id);
  renderTyping();
}

function renderTyping() {
  const el = $('typingBar');
  const names = [...typingUsers.values()].map((u) => u.name);
  el.textContent = names.length ? names.join(', ') + ' печатает…' : '';
}

// ---------------------------------------------------------------------------
// Присутствие / участники
// ---------------------------------------------------------------------------

function renderMembers(peers) {
  const list = $('membersList');
  $('membersCount').textContent = peers.length;
  list.innerHTML = '';

  for (const p of peers) {
    const div = document.createElement('div');
    div.className = 'member';
    div.innerHTML =
      `<div class="member__avatar">${escapeHtml(p.avatarEmoji || '😎')}<span class="member__dot"></span></div>` +
      `<span class="member__name" style="color:${p.color}">${escapeHtml(p.name)}</span>`;
    const btn = document.createElement('button');
    btn.className = 'member__call';
    btn.title = 'Позвонить';
    btn.textContent = '📞';
    btn.addEventListener('click', () => startCall(p));
    div.appendChild(btn);
    list.appendChild(div);
  }
}

function renderOnlineChips() {
  const el = $('onlineChips');
  el.innerHTML = '';
  el.appendChild(makeChip()); // "онлайн N"
  const n = document.createElement('span');
  n.className = 'chip__dot';
  // уже внутри
}

function makeChip() {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.innerHTML = `<span class="chip__dot"></span> онлайн ${state.peers.length + 1}`;
  return chip;
}

// ---------------------------------------------------------------------------
// Профиль / я
// ---------------------------------------------------------------------------

function updateMe() {
  $('meAvatar').textContent = state.profile.avatarEmoji || '😎';
  $('meName').textContent = state.profile.name || '...';
  $('meName').style.color = state.profile.color;
  $('meStatus').textContent = state.profile.status || 'онлайн';
  $('composerAvatar').textContent = state.profile.avatarEmoji || '😎';
}

function updateRoomTitle() {
  $('roomTitle').textContent = 'Звонилка';
  $('topbarTitle').textContent = state.view === 'chat' ? '# общий' : '🔊 звонилка';
  $('topbarTopic').textContent = 'Комната: ' + state.room;
}

// ---------------------------------------------------------------------------
// Переключение вкладок
// ---------------------------------------------------------------------------

function setView(view) {
  state.view = view;
  const isChat = view === 'chat';
  $('chatView').hidden = !isChat;
  $('voiceView').hidden = isChat;
  $('channelText').classList.toggle('channel--active', isChat);
  $('channelVoice').classList.toggle('channel--active', !isChat);
  updateRoomTitle();
}

$('channelText').addEventListener('click', (e) => { e.preventDefault(); setView('chat'); });
$('channelVoice').addEventListener('click', (e) => { e.preventDefault(); setView('voice'); });

// ---------------------------------------------------------------------------
// Настройки
// ---------------------------------------------------------------------------

function buildAvatarPicker() {
  const grid = $('avatarGrid');
  for (const em of EMOJIS) {
    const d = document.createElement('div');
    d.className = 'avatar-opt';
    d.textContent = em;
    d.addEventListener('click', () => {
      state.profile.avatarEmoji = em;
      document.querySelectorAll('.avatar-opt').forEach((n) => n.classList.remove('sel'));
      d.classList.add('sel');
    });
    grid.appendChild(d);
  }
}

function buildColorPicker() {
  const grid = $('colorGrid');
  for (const c of COLORS) {
    const d = document.createElement('div');
    d.className = 'color-opt';
    d.style.background = c;
    d.addEventListener('click', () => {
      state.profile.color = c;
      document.querySelectorAll('.color-opt').forEach((n) => n.classList.remove('sel'));
      d.classList.add('sel');
    });
    grid.appendChild(d);
  }
}

function openSettings() {
  $('setName').value = state.profile.name || '';
  $('setStatus').value = state.profile.status || '';
  // подсветить выбранный аватар/цвет
  document.querySelectorAll('.avatar-opt').forEach((n) => n.classList.toggle('sel', n.textContent === state.profile.avatarEmoji));
  document.querySelectorAll('.color-opt').forEach((n) => n.classList.toggle('sel', n.style.background === state.profile.color));
  updateInviteLink();
  $('settingsOverlay').hidden = false;
}

function bindSettings() {
  $('btnSettings').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', () => { $('settingsOverlay').hidden = true; });
  $('settingsOverlay').addEventListener('click', (e) => {
    if (e.target === $('settingsOverlay')) $('settingsOverlay').hidden = true;
  });
  $('saveSettings').addEventListener('click', saveSettings);
  $('copyInvite').addEventListener('click', copyInvite);
  $('addServer').addEventListener('click', (e) => {
    e.preventDefault();
    const code = prompt('Введи код комнаты (латиница/цифры):', state.room);
    if (code && code.trim()) {
      const c = code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (c) {
        state.room = c;
        $('loginRoom').value = c;
        // переподключение к новой комнате
        if (state.ws) { try { state.ws.close(); } catch {} connect(); }
        updateRoomTitle();
        systemMessage('Переходишь в комнату «' + c + '»…');
      }
    }
  });
}

function saveSettings() {
  state.profile.name = $('setName').value.trim() || state.profile.name;
  state.profile.status = $('setStatus').value.trim();
  localStorage.setItem('zvonilka:name', state.profile.name);
  send({ type: 'profile:update', profile: state.profile });
  updateMe();
  $('settingsOverlay').hidden = true;
}

function updateInviteLink() {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;
  $('inviteLink').textContent = url;
}

function copyInvite() {
  const url = $('inviteLink').textContent;
  navigator.clipboard.writeText(url).then(() => toast('Ссылка скопирована')).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('Ссылка скопирована');
  });
}

// ---------------------------------------------------------------------------
// Toast-уведомления
// ---------------------------------------------------------------------------

function toast(text) {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
      'background:#1d1f2a;border:1px solid #2a2d3a;color:#e6e7ee;padding:10px 18px;' +
      'border-radius:10px;font-family:inherit;font-size:14px;z-index:200;transition:opacity .3s;';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ---------------------------------------------------------------------------
// ГОЛОС / WebRTC
// ---------------------------------------------------------------------------

function bindVoice() {
  $('btnJoinVoice').addEventListener('click', toggleVoiceChannel);
  $('btnMute').addEventListener('click', toggleMute);
  $('btnDeaf').addEventListener('click', toggleDeaf);
}

function toggleVoiceChannel() {
  const btn = $('btnJoinVoice');
  if (!state.localStream) {
    // вход в "канал" — просто открываем микрофон/включаем доступность для звонков
    getUserMedia().then(() => {
      btn.textContent = '🚪 Выйти из звонка';
      btn.classList.add('joined');
      $('voiceHint').textContent = 'Ты в голосовом канале. Звони друзьям из списка справа.';
    }).catch((err) => {
      toast('Нет доступа к микрофону: ' + err.message);
    });
  } else {
    // выходим
    releaseMedia();
    btn.textContent = '🔊 Войти в звонок';
    btn.classList.remove('joined');
    $('voiceHint').textContent = 'Войди в голосовой канал';
  }
  renderVoicePeers();
}

async function getUserMedia() {
  if (state.localStream) return state.localStream;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  state.localStream = stream;
  return stream;
}

function releaseMedia() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
}

function toggleMute() {
  state.muted = !state.muted;
  if (state.localStream) state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  $('btnMute').classList.toggle('on', state.muted);
  $('btnMute').textContent = state.muted ? '🚫' : '🎙';
  renderVoicePeers();
}

function toggleDeaf() {
  state.deafened = !state.deafened;
  $('btnDeaf').classList.toggle('on', state.deafened);
  $('btnDeaf').textContent = state.deafened ? '🔇' : '🔈';
  // убираем звук удалённого потока
  if (state.remoteStream) {
    const audioEl = state.remoteStream._audioEl;
    if (audioEl) audioEl.muted = state.deafened;
  }
}

// --- звонок: исходящий ---

async function startCall(peer) {
  if (state.inCall) { toast('Уже идёт звонок'); return; }
  try {
    await getUserMedia();
  } catch (err) {
    toast('Нужен доступ к микрофону');
    return;
  }

  state.inCall = true;
  state.callPeerId = peer.id;
  state.callPeerName = peer.name;
  state.callPeerAvatar = peer.avatarEmoji || '😎';
  state.incomingFrom = null;

  createPeerConnection();
  state.pc.addTrack(state.localStream.getAudioTracks()[0], state.localStream);

  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  send({ type: 'rtc', to: peer.id, data: { kind: 'offer', sdp: offer } });

  showOutgoingRing(peer);
}

function showOutgoingRing(peer) {
  $('activeAvatar').textContent = peer.avatarEmoji || '😎';
  $('activeName').textContent = 'Звоним ' + peer.name + '…';
  $('activeTimer').textContent = '';
  $('callActive').hidden = false;
  state.callStart = 0;
}

// --- звонок: входящий ---

function handleSignal(msg) {
  const data = msg.data;
  if (data.kind === 'offer' && !state.inCall) {
    // входящий звонок
    state.incomingFrom = {
      id: msg.from, name: msg.name, avatar: msg.avatarEmoji || '😎',
      offer: data.sdp,
    };
    $('incomingAvatar').textContent = state.incomingFrom.avatar;
    $('incomingName').textContent = state.incomingFrom.name + ' звонит…';
    $('incomingOverlay').hidden = false;
    return;
  }

  // если уже в звонке с этим участником
  if (state.inCall && msg.from === state.callPeerId) {
    if (!state.pc) createPeerConnection();
    if (data.kind === 'offer') {
      state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).then(async () => {
        if (state.pc.signalingState === 'have-remote-offer') {
          await getUserMedia();
          state.localStream.getAudioTracks().forEach((t) => {
            if (!state.pc.getSenders().some((s) => s.track === t)) state.pc.addTrack(t, state.localStream);
          });
          const answer = await state.pc.createAnswer();
          await state.pc.setLocalDescription(answer);
          send({ type: 'rtc', to: msg.from, data: { kind: 'answer', sdp: answer } });
        }
      }).catch((e) => console.warn(e));
    } else if (data.kind === 'answer') {
      state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp)).catch((e) => console.warn(e));
    } else if (data.kind === 'candidate') {
      if (data.candidate) state.pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}

function acceptCall() {
  if (!state.incomingFrom) return;
  const inc = state.incomingFrom;
  state.incomingFrom = null;
  $('incomingOverlay').hidden = true;
  state.inCall = true;
  state.callPeerId = inc.id;
  state.callPeerName = inc.name;
  state.callPeerAvatar = inc.avatar;

  getUserMedia().then(() => {
    createPeerConnection();
    state.pc.setRemoteDescription(new RTCSessionDescription(inc.offer)).then(async () => {
      state.localStream.getAudioTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      send({ type: 'rtc', to: inc.id, data: { kind: 'answer', sdp: answer } });
      callStarted();
    }).catch((e) => console.warn(e));
  }).catch(() => toast('Нужен доступ к микрофону'));
}

function declineCall() {
  if (state.incomingFrom) {
    send({ type: 'rtc:cancel', to: state.incomingFrom.id });
    state.incomingFrom = null;
    $('incomingOverlay').hidden = true;
  }
}

function cancelIncoming(fromId) {
  if (state.incomingFrom && state.incomingFrom.id === fromId) {
    state.incomingFrom = null;
    $('incomingOverlay').hidden = true;
  }
  if (state.inCall && !state.callStart && state.callPeerId === fromId) {
    endCall();
    toast('Собеседник отменил звонок');
  }
}

function bindCalls() {
  $('btnAccept').addEventListener('click', acceptCall);
  $('btnDecline').addEventListener('click', declineCall);
  $('btnEndCall').addEventListener('click', endCall);
}

function createPeerConnection() {
  if (state.pc) { state.pc.close(); }
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate && state.callPeerId) {
      send({ type: 'rtc', to: state.callPeerId, data: { kind: 'candidate', candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    state.remoteStream = e.streams[0];
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.autoplay = true;
    audio.muted = state.deafened;
    audio.play().catch(() => {});
    state.remoteStream._audioEl = audio;
    attachMeter();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') callStarted();
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      setTimeout(() => { if (pc.connectionState !== 'connected') endCall(); }, 3000);
    }
  };
}

function callStarted() {
  if (state.callStart) return;
  state.callStart = Date.now();
  $('activeTimer').textContent = '00:00';
  $('activeName').textContent = state.callPeerName;
  startTimer();
}

let timerInt = null;
function startTimer() {
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    if (!state.callStart) return;
    const d = Math.floor((Date.now() - state.callStart) / 1000);
    const m = String(Math.floor(d / 60)).padStart(2, '0');
    const s = String(d % 60).padStart(2, '0');
    $('activeTimer').textContent = m + ':' + s;
  }, 1000);
}

function endCall() {
  clearInterval(timerInt);
  state.inCall = false;
  state.callStart = 0;
  if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
  if (state.remoteStream) {
    const a = state.remoteStream._audioEl;
    if (a) { a.srcObject = null; }
  }
  state.remoteStream = null;
  state.callPeerId = null;
  $('callActive').hidden = true;
  $('incomingOverlay').hidden = true;
}

// --- индикатор уровня разговора (простая анимация) ---

function attachMeter() {
  const meter = $('activeMeter');
  meter.innerHTML = '';
  for (let i = 0; i < 14; i++) { const b = document.createElement('i'); b.style.height = '20%'; meter.appendChild(b); }
  // лёгкая анимация активности
  if (!state.meterInt) {
    state.meterInt = setInterval(() => {
      const bars = meter.children;
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = (20 + Math.random() * 80).toFixed(0) + '%';
      }
    }, 200);
  }
}

// --- отображение участников голосового канала ---

function renderVoicePeers() {
  const el = $('voicePeers');
  el.innerHTML = '';
  // показываем себя если в канале
  if (state.localStream) {
    el.appendChild(voicePeerCard(state.profile.name, state.profile.avatarEmoji, state.muted ? 'микрофон выкл' : 'говорит', state.profile.color, true));
  }
}

function voicePeerCard(name, emoji, hint, color, speaking) {
  const d = document.createElement('div');
  d.className = 'vpeer' + (speaking ? ' vpeer--speaking' : '');
  d.innerHTML =
    `<div class="vpeer__avatar" style="box-shadow:0 0 0 3px ${color}">${escapeHtml(emoji)}</div>` +
    `<div class="vpeer__name" style="color:${color}">${escapeHtml(name)}</div>` +
    `<div class="vpeer__state">${escapeHtml(hint)}</div>`;
  return d;
}

// ---------------------------------------------------------------------------
// Запуск
// ---------------------------------------------------------------------------

window.addEventListener('load', () => {
  init();
  // если профиль уже сохранён и есть имя — можно авто-логин? Нет, показываем вход для выбора комнаты.
});
