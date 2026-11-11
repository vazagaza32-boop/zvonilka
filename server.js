// zvonilka/server.js
// Лёгкий сервер реального времени: HTTP-статика + WebSocket (свой, без зависимостей).
// Функции: чат, присутствие (онлайн), профили, сигналинг WebRTC для голосовых звонков.
// Запуск:   node server.js   ->  http://localhost:3000

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---------------------------------------------------------------------------
// Мини-WebSocket-сервер (RFC 6455) — без внешних зависимостей.
// ---------------------------------------------------------------------------

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return null;

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n' +
      '\r\n'
  );

  const ws = new WebSocketConnection(socket);
  return ws;
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.alive = true;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this._close());
    socket.on('close', () => {
      this.alive = false;
      if (this.onClose) this.onClose();
    });
    // heartbeat
    this.heartbeat = setInterval(() => {
      if (!this.alive) return this._terminate();
      this.alive = false;
      this.sendFrame(0x9, Buffer.alloc(0)); // ping
    }, 30000);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // разбираем кадры
    while (true) {
      if (this.buffer.length < 2) break;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) break;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) break;
        const big = this.buffer.readBigUInt64BE(2);
        len = Number(big);
        offset = 10;
      }

      let maskKey;
      if (masked) {
        if (this.buffer.length < offset + 4) break;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + len) break;

      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x8) {
        // close
        this._close();
        return;
      } else if (opcode === 0x9) {
        // ping -> pong
        this.sendFrame(0xa, payload);
      } else if (opcode === 0xa) {
        this.alive = true;
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (fin && this.onMessage) {
          this.onMessage(payload, opcode === 0x2);
        }
      }
    }
  }

  sendFrame(opcode, payload) {
    if (!this.alive || this.socket.destroyed) return;
    let header;
    const len = payload.length;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      /* ignore */
    }
  }

  send(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  _terminate() {
    clearInterval(this.heartbeat);
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.alive = false;
  }

  _close() {
    if (!this.alive) return;
    try { this.sendFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    this._terminate();
    if (this.onClose) this.onClose();
  }
}

// ---------------------------------------------------------------------------
// Состояние: комнаты, пользователи, профили
// ---------------------------------------------------------------------------

const rooms = new Map();   // roomId -> Map<peerId, { ws, profile }>
const profiles = new Map(); // token -> profile object (в памяти; можно расширить до файла)

function defaultProfile() {
  return {
    name: '',
    color: pickColor(),
    avatarEmoji: '😎',
    status: '',
  };
}

const EMOJIS = ['😎','🤙','👽','🐸','🔥','⚡','🥶','👾','🦄','🍕','🚀','💀','🧃','🎧'];
const COLORS = ['#7c5cff','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899','#8b5cf6','#10b981'];

function pickColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}
function pickEmoji() {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}

const genId = (n = 16) => crypto.randomBytes(n).toString('hex');

// ---------------------------------------------------------------------------
// HTTP-сервер: статика + upgrade на WebSocket
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  // WebSocket upgrade
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
    const ws = acceptWebSocket(req, req.socket);
    if (ws) handleConnection(ws);
    return;
  }

  // статика
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (fs.existsSync(filePath) === false) {
        // SPA fallback
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); }
          else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2); }
        });
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  🎧  ZvONILKA  запущена');
  console.log('  ────────────────────────────────────────');
  console.log(`  Локально:   http://localhost:${PORT}`);
  console.log(`  В сети:     http://<твой-IP>:${PORT}`);
  console.log('');
  console.log('  Открой ссылку, впиши ник — и зови кента по той же ссылке.');
  console.log('');
});

// ---------------------------------------------------------------------------
// Обработка соединений и сообщений
// ---------------------------------------------------------------------------

function handleConnection(ws) {
  const conn = {
    ws,
    id: genId(8),
    roomId: null,     // 'general' | random-room | dm
    profile: { name: '', color: pickColor(), avatarEmoji: pickEmoji(), status: '' },
    token: null,      // persistent profile key
  };

  ws.onMessage = (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    handleMessage(conn, msg);
  };

  ws.onClose = () => {
    leave(conn);
  };
}

function handleMessage(conn, msg) {
  switch (msg.type) {
    case 'hello': {
      // регистрация в комнате
      const token = typeof msg.token === 'string' && msg.token ? msg.token : null;
      const name = (msg.name || '').toString().slice(0, 24).trim();
      const color = typeof msg.color === 'string' ? msg.color : null;
      const avatarEmoji = typeof msg.avatarEmoji === 'string' ? msg.avatarEmoji : null;
      const status = (msg.status || '').toString().slice(0, 80);

      conn.token = token;
      if (token && profiles.has(token)) {
        conn.profile = profiles.get(token);
        if (name && name !== conn.profile.name) conn.profile.name = name;
        if (color) conn.profile.color = color;
        if (avatarEmoji) conn.profile.avatarEmoji = avatarEmoji;
        if (status !== undefined) conn.profile.status = status;
      } else {
        conn.profile = { ...defaultProfile(), name, status };
        if (color) conn.profile.color = color;
        if (avatarEmoji) conn.profile.avatarEmoji = avatarEmoji;
        if (name) conn.profile.name = name;
      }
      if (!conn.profile.name) conn.profile.name = 'Анон' + conn.id.slice(0, 3).toUpperCase();

      conn.roomId = typeof msg.room === 'string' && msg.room ? msg.room : 'general';
      join(conn);

      // отдаём клиенту его стабильный токен и профиль
      conn.ws.send({
        type: 'welcome',
        id: conn.id,
        token: conn.token || genId(32),
        profile: conn.profile,
        room: conn.roomId,
      });
      break;
    }

    case 'profile:update': {
      const p = msg.profile || {};
      if (typeof p.name === 'string' && p.name.trim()) conn.profile.name = p.name.trim().slice(0, 24);
      if (typeof p.color === 'string') conn.profile.color = p.color;
      if (typeof p.avatarEmoji === 'string' && p.avatarEmoji) conn.profile.avatarEmoji = p.avatarEmoji.slice(0, 4);
      if (typeof p.status === 'string') conn.profile.status = p.status.slice(0, 80);
      if (conn.token) profiles.set(conn.token, conn.profile);
      broadcastPresence(conn.roomId);
      conn.ws.send({ type: 'profile:set', profile: conn.profile });
      break;
    }

    case 'chat': {
      if (!conn.roomId) break;
      const text = (msg.text || '').toString().slice(0, 1000);
      if (!text.trim()) break;
      broadcastRoom(conn.roomId, {
        type: 'chat',
        from: conn.id,
        name: conn.profile.name,
        color: conn.profile.color,
        avatarEmoji: conn.profile.avatarEmoji,
        text,
        ts: Date.now(),
      }, conn);
      break;
    }

    case 'typing': {
      if (!conn.roomId) break;
      broadcastRoom(conn.roomId, { type: 'typing', from: conn.id, name: conn.profile.name }, conn);
      break;
    }

    // --- сигналинг WebRTC (голос) ---
    case 'rtc': {
      const targetId = msg.to;
      const payload = msg.data;
      if (!targetId || payload === undefined) break;
      const target = findPeer(conn.roomId, targetId);
      if (!target) {
        conn.ws.send({ type: 'rtc:error', to: targetId, reason: 'peer-offline' });
        break;
      }
      target.conn.ws.send({
        type: 'rtc',
        from: conn.id,
        name: conn.profile.name,
        color: conn.profile.color,
        avatarEmoji: conn.profile.avatarEmoji,
        data: payload,
      });
      break;
    }

    case 'rtc:cancel': {
      const targetId = msg.to;
      if (!targetId) break;
      const target = findPeer(conn.roomId, targetId);
      if (target) target.conn.ws.send({ type: 'rtc:cancel', from: conn.id });
      break;
    }

    case 'ping':
      conn.ws.send({ type: 'pong', ts: Date.now() });
      break;
  }
}

// --- комнаты / присутствие ---

function join(conn) {
  if (!rooms.has(conn.roomId)) rooms.set(conn.roomId, new Map());
  const room = rooms.get(conn.roomId);

  const existing = [...room.values()].find((p) => p.conn.id === conn.id);
  if (existing) {
    // переподключение — обновляем сокет
    existing.conn.ws = conn.ws;
    existing.profile = conn.profile;
  } else {
    room.set(conn.id, { conn, profile: conn.profile });
  }

  // сообщаем «ты в сети»
  sendTo(conn, { type: 'peers', peers: presentList(conn.roomId, conn.id) });
  broadcastPresence(conn.roomId);

  // короткий исторический контекст отсутствует (stateless); клиент сам хранит историю
}

function leave(conn) {
  if (!conn.roomId) return;
  const room = rooms.get(conn.roomId);
  if (!room) return;
  const peer = room.get(conn.id);
  if (peer && peer.conn.ws === conn.ws) {
    room.delete(conn.id);
    if (room.size === 0) rooms.delete(conn.roomId);
    broadcastPresence(conn.roomId);
  }
}

function presentList(roomId, exceptId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const out = [];
  for (const [id, p] of room) {
    if (id === exceptId) continue;
    out.push({
      id,
      name: p.profile.name,
      color: p.profile.color,
      avatarEmoji: p.profile.avatarEmoji,
      status: p.profile.status || '',
    });
  }
  return out;
}

function findPeer(roomId, id) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return room.get(id);
}

function broadcastRoom(roomId, message, except) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, p] of room) {
    if (except && p.conn.id === except.id) continue;
    p.conn.ws.send(message);
  }
}

function broadcastPresence(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, p] of room) {
    p.conn.ws.send({ type: 'peers', peers: presentList(roomId, id) });
  }
}

function sendTo(conn, message) {
  conn.ws.send(message);
}
