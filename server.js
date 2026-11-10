// Manhunt FPV — LAN lobby server (phase 1: lobby, hunter selection, countdown).
// Usage: npm install && node server.js [port]
// Put Manhunt_FPV.html next to this file (or set GAME_FILE env var).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const GAME_FILE = process.env.GAME_FILE || path.join(__dirname, 'Manhunt_FPV.html');
const COUNTDOWN_SEC = 5;
const MAX_NICK = 16;

// ---------- room state (one room per server run) ----------
const room = {
  phase: 'lobby',          // 'lobby' | 'countdown' | 'running'
  hostId: null,
  settings: { slots: 8, hunters: 1, difficulty: 'normal', map: 'city' },
  players: new Map(),      // id -> { id, uuid, nick, level, ws, role, alive }
  nextId: 1,
};

const sanitizeNick = (s) =>
  String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NICK) || 'Player';

const sanitizeLevel = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 && v < 1000 ? Math.floor(v) : 1;
};

function lobbyList() {
  return [...room.players.values()].map((p) => ({
    id: p.id, nick: p.nick, level: p.level, isHost: p.id === room.hostId,
  }));
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function sendTo(p, msg) {
  if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
}

function pushLobby() {
  broadcast({ type: 'lobby', settings: room.settings, phase: room.phase, hostId: room.hostId, players: lobbyList() });
}

function electHost() {
  const first = room.players.values().next().value;
  room.hostId = first ? first.id : null;
}

// Random hunters: 1–3 depending on settings, never more than players-1.
function pickHunters() {
  const ids = [...room.players.keys()];
  const count = Math.max(1, Math.min(room.settings.hunters, ids.length - 1));
  const shuffled = ids.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function startMatch() {
  if (room.players.size < 2) return { error: 'Нужно минимум 2 игрока' };
  if (room.phase !== 'lobby') return { error: 'Матч уже идёт' };

  const hunters = new Set(pickHunters());
  for (const p of room.players.values()) {
    p.role = hunters.has(p.id) ? 'seeker' : 'hider';
    p.alive = true;
  }
  room.phase = 'countdown';
  broadcast({
    type: 'countdown',
    seconds: COUNTDOWN_SEC,
    hunters: [...hunters],
    // "выстрел" — клиенты проигрывают эффект по этому событию
    shot: true,
  });
  pushLobby();

  setTimeout(() => {
    if (room.phase !== 'countdown') return;
    room.phase = 'running';
    broadcast({ type: 'go' });
    pushLobby();
  }, COUNTDOWN_SEC * 1000);
  return { ok: true };
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      name: 'Manhunt LAN',
      phase: room.phase,
      players: room.players.size,
      slots: room.settings.slots,
      settings: room.settings,
    }));
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(GAME_FILE, (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Не найден файл игры: ' + GAME_FILE);
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const id = String(room.nextId++);
  let joined = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!joined) {
      if (msg.type !== 'join') return;
      if (room.players.size >= room.settings.slots) {
        ws.send(JSON.stringify({ type: 'error', text: 'Лобби заполнено' }));
        return ws.close();
      }
      if (room.phase !== 'lobby') {
        ws.send(JSON.stringify({ type: 'error', text: 'Матч уже идёт, дождитесь следующего' }));
        return ws.close();
      }
      const p = {
        id,
        uuid: String(msg.uuid || '').slice(0, 64),
        nick: sanitizeNick(msg.nick),
        level: sanitizeLevel(msg.level),
        ws,
        role: 'hider',
        alive: true,
      };
      room.players.set(id, p);
      if (!room.hostId) room.hostId = id;
      joined = true;
      sendTo(p, { type: 'welcome', id, isHost: room.hostId === id });
      pushLobby();
      return;
    }

    const me = room.players.get(id);
    if (!me) return;

    switch (msg.type) {
      case 'start': {
        if (me.id !== room.hostId) return sendTo(me, { type: 'error', text: 'Старт только у хоста' });
        const r = startMatch();
        if (r.error) sendTo(me, { type: 'error', text: r.error });
        break;
      }
      case 'settings': {
        if (me.id !== room.hostId || room.phase !== 'lobby') return;
        const s = msg.settings || {};
        room.settings.slots = Math.min(8, Math.max(2, Number(s.slots) || room.settings.slots));
        room.settings.hunters = Math.min(3, Math.max(1, Number(s.hunters) || room.settings.hunters));
        if (['easy', 'normal', 'hard'].includes(s.difficulty)) room.settings.difficulty = s.difficulty;
        if (['city'].includes(s.map)) room.settings.map = s.map;
        pushLobby();
        break;
      }
      case 'ping':
        sendTo(me, { type: 'pong', t: msg.t });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!joined) return;
    room.players.delete(id);
    if (room.hostId === id) electHost();
    if (room.players.size === 0) {
      room.phase = 'lobby';
    }
    pushLobby();
  });
});

// ---------- startup: print addresses for all LAN interfaces ----------
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Manhunt LAN сервер запущен на порту', PORT);
  const ips = lanAddresses();
  if (!ips.length) console.log('Сеть не найдена. Проверьте подключение к Wi-Fi.');
  for (const ip of ips) console.log('  Открыть на телефоне/ПК:  http://' + ip + ':' + PORT);
});
