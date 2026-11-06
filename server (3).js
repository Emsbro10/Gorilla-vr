// Gorilla VR multiplayer server.
// - One ROOM per map: players only see players and blocks on their own map.
// - Pasting a map starts a vote in the room (30 s). Mods skip the vote.
// - Mod tools (unlocked with MOD_CODE, checked here on the server): break any block, clear the map, ban players.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MOD_CODE = String(process.env.MOD_CODE || '2882');   // change it on Render: Environment > MOD_CODE
const MAX_PLAYERS = 24;
const TICK_MS = 50;              // pose snapshots (20 Hz)
const STALE_MS = 3000;
const MAP_IDS = ['classic', 'city', 'blank', 'towers', 'parkour', 'islands'];
const MAX_BLOCKS = 300;          // per map
const VOTE_MS = 30000;
const PASTE_COOLDOWN_MS = 60000;
const MOD_MAX_TRIES = 5, MOD_LOCK_MS = 10 * 60 * 1000;
// Voice chat setup (WebRTC). STUN works for most players. For strict networks add a TURN relay on Render:
// Environment: TURN_URLS (comma separated, e.g. turn:host:3478), TURN_USER, TURN_PASS.
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
if (process.env.TURN_URLS) ICE.push({ urls: process.env.TURN_URLS.split(',').map(x => x.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });

// Find the game page wherever it ended up (next to server.js, in public/, one folder deeper; any capital letters).
function findPage(dir, depth) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const f = entries.find(e => e.isFile() && e.name.trim().toLowerCase() === 'index.html');
  if (f) return path.join(dir, f.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      const r = findPage(path.join(dir, e.name), depth - 1); if (r) return r;
    }
  }
  return null;
}
const pageFile = findPage(__dirname, 2);
const page = pageFile
  ? fs.readFileSync(pageFile)
  : Buffer.from('<h1>index.html not found</h1><p>Add index.html to your GitHub repo (next to server.js), then redeploy.</p>');
console.log(pageFile ? 'Serving ' + pageFile : 'WARNING: index.html not found. Files here: ' + fs.readdirSync(__dirname).join(', '));

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(page);
});

const wss = new WebSocketServer({ server, maxPayload: 32768 });
const players = new Map();
let nextId = 1, nextBlockId = 1, nextVoteId = 1;

const rooms = {};
MAP_IDS.forEach(id => { rooms[id] = { blocks: new Map(), vote: null }; });
const bannedIPs = new Set(), bannedCids = new Set();
const modTries = new Map();      // ip -> {n, until}

const okNums = (a, n) =>
  Array.isArray(a) && a.length === n && a.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1000);

function cleanSpec(a) {
  if (!Array.isArray(a) || a.length !== 7 || !a.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const [x, y, z, w, h, d, mi] = a;
  if (Math.abs(x) > 100 || Math.abs(z) > 100 || y < -1 || y > 80) return null;
  const cl = v => Math.min(20, Math.max(0.1, v));
  return [x, y, z, cl(w), cl(h), cl(d), Math.min(9, Math.max(0, Math.round(mi)))];
}
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

const sendTo = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const roomPlayers = id => [...players.values()].filter(p => p.room === id);
const broadcastRoom = (id, o) => { const m = JSON.stringify(o); for (const p of roomPlayers(id)) if (p.ws.readyState === 1) p.ws.send(m); };
const worldMsg = id => ({ t: 'w', map: id, blocks: [...rooms[id].blocks.values()] });
const note = (p, msg) => sendTo(p, { t: 'note', msg });
const lookMsg = p => ({ t: 'look', id: p.id, name: p.name, cos: p.cos, mod: p.mod });
function cleanName(raw, id) {
  const n = String(raw || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n || ('Player' + id);
}

// ---------- blocks ----------
function addBlocks(roomId, ownerId, specs) {
  const store = rooms[roomId].blocks, list = [];
  for (const raw of specs.slice(0, MAX_BLOCKS)) {
    if (store.size >= MAX_BLOCKS) break;
    const s = cleanSpec(raw); if (!s) continue;
    const b = { id: nextBlockId++, s, o: ownerId };
    store.set(b.id, b); list.push(b);
  }
  if (list.length) broadcastRoom(roomId, { t: 'add', list });
  return list.length;
}

// ---------- votes to paste a map ----------
function voteMsg(roomId) {
  const v = rooms[roomId].vote;
  return { t: 'vote', id: v.id, by: v.by, n: v.specs.length, yes: v.yes.size, no: v.no.size,
           total: roomPlayers(roomId).length, ms: Math.max(0, v.end - Date.now()) };
}
function tallyVote(roomId, force) {
  const r = rooms[roomId], v = r.vote; if (!v) return;
  const total = roomPlayers(roomId).length, yes = v.yes.size, no = v.no.size;
  let result = null;
  if (yes > total / 2) result = true;
  else if (no >= total / 2) result = false;
  else if (force) result = yes > no;
  if (result === null) { broadcastRoom(roomId, voteMsg(roomId)); return; }
  r.vote = null;
  if (result) addBlocks(roomId, v.by, v.specs);              // pasted blocks belong to whoever pasted them
  broadcastRoom(roomId, { t: 'vote_end', id: v.id, passed: result, by: v.by, n: v.specs.length });
}
function cancelVoteIfBy(roomId, playerId) {
  const r = rooms[roomId];
  if (r.vote && r.vote.by === playerId) {
    const id = r.vote.id; r.vote = null;
    broadcastRoom(roomId, { t: 'vote_end', id, passed: false, by: playerId, n: 0 });
  }
}
function leaveRoom(p, roomId) { cancelVoteIfBy(roomId, p.id); if (rooms[roomId].vote) tallyVote(roomId, false); }
function removePlayer(p) {
  if (!players.has(p.id)) return;
  players.delete(p.id); leaveRoom(p, p.room);
}

function banPlayer(target) {
  bannedIPs.add(target.ip); if (target.cid) bannedCids.add(target.cid);
  for (const q of [...players.values()]) {
    if (q.ip === target.ip || (target.cid && q.cid === target.cid)) {
      sendTo(q, { t: 'banned' }); try { q.ws.close(4003, 'banned'); } catch {} removePlayer(q);
    }
  }
}

wss.on('connection', (ws, req) => {
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  if (bannedIPs.has(ip)) { try { ws.send(JSON.stringify({ t: 'banned' })); } catch {} ws.close(4003, 'banned'); return; }
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const id = nextId++;
  const p = { id, ws, ip, cid: '', room: 'classic', mod: false, color: 0xcccccc, pose: null, t: 0, count: 0, rtc: 0,
              alive: true, lastPaste: 0, lastJoin: 0, name: 'Player' + id, cos: 0, looksSet: false };
  players.set(id, p);
  sendTo(p, { t: 'hi', id, ice: ICE });
  sendTo(p, worldMsg(p.room));

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', data => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'rtc') { if (++p.rtc > 300) return; }        // voice setup can burst
    else if (++p.count > 60) return;                         // everything else: max ~60 msgs/sec per player
    const room = rooms[p.room];

    if (m.t === 'u') {                                       // my head + hands
      if (m.off) { p.pose = null; return; }
      if (!okNums(m.h, 7) || !okNums(m.l, 3) || !okNums(m.r, 3)) return;
      if (Number.isInteger(m.c) && m.c >= 0 && m.c <= 0xffffff) p.color = m.c;
      p.pose = [...m.h, ...m.l, ...m.r]; p.t = Date.now();
    }
    else if (m.t === 'join') {                               // move to another map's room
      if (!MAP_IDS.includes(m.map)) return;
      const now = Date.now(); if (now - p.lastJoin < 400) return; p.lastJoin = now;
      if (typeof m.cid === 'string') p.cid = m.cid.slice(0, 40);
      if (p.cid && bannedCids.has(p.cid)) { bannedIPs.add(p.ip); sendTo(p, { t: 'banned' }); try { ws.close(4003, 'banned'); } catch {} removePlayer(p); return; }
      if (m.map !== p.room) { const old = p.room; p.room = m.map; p.pose = null; leaveRoom(p, old); }
      sendTo(p, worldMsg(p.room));
      sendTo(p, { t: 'looks', list: roomPlayers(p.room).map(q => [q.id, q.name, q.cos, q.mod]) });
      broadcastRoom(p.room, lookMsg(p));
      if (rooms[p.room].vote) sendTo(p, voteMsg(p.room));
    }
    else if (m.t === 'look') {                               // my name + cosmetic
      const name = cleanName(m.name, p.id);
      let cos = Number.isInteger(m.cos) ? m.cos : 0; if (cos < 0 || cos > 8) cos = 0;
      if (cos === 8 && !p.mod) cos = 0;                      // the mod crown is for moderators only
      if (p.looksSet && cos !== p.cos && cos !== 0 && cos !== 8 && p.room !== 'city') {
        note(p, 'Cosmetics can only be equipped in the City map.'); cos = p.cos;
      }
      p.name = name; p.cos = cos; p.looksSet = true;
      broadcastRoom(p.room, lookMsg(p));
    }
    else if (m.t === 'rtc') {                                // voice chat signalling, only inside the same room
      const to = players.get(m.to);
      if (!to || to === p || to.room !== p.room || !m.d || typeof m.d !== 'object') return;
      if (JSON.stringify(m.d).length > 12000) return;
      sendTo(to, { t: 'rtc', from: p.id, d: m.d });
    }
    else if (m.t === 'add') {                                // build by hand (no vote needed)
      if (Array.isArray(m.specs)) addBlocks(p.room, p.id, m.specs.slice(0, 50));
    }
    else if (m.t === 'del') {                                // your own blocks; mods can break any block
      if (!Array.isArray(m.ids)) return;
      const gone = [];
      for (const bid of m.ids.slice(0, 100)) {
        const b = room.blocks.get(bid);
        if (b && (b.o === p.id || p.mod)) { room.blocks.delete(bid); gone.push(bid); }
      }
      if (gone.length) broadcastRoom(p.room, { t: 'del', ids: gone });
    }
    else if (m.t === 'clear') {                              // remove all MY blocks on this map
      const gone = [];
      for (const [bid, b] of room.blocks) if (b.o === p.id) { room.blocks.delete(bid); gone.push(bid); }
      if (gone.length) broadcastRoom(p.room, { t: 'del', ids: gone });
    }
    else if (m.t === 'paste') {                              // paste a map: needs a vote unless you are a mod
      if (!Array.isArray(m.specs)) return;
      const specs = m.specs.slice(0, MAX_BLOCKS).map(cleanSpec).filter(Boolean);
      if (!specs.length) { note(p, 'That map code has no valid blocks.'); return; }
      if (p.mod || roomPlayers(p.room).length <= 1) { const n = addBlocks(p.room, p.id, specs); note(p, 'Pasted ' + n + ' blocks.'); return; }
      if (room.vote) { note(p, 'A vote is already running. Wait for it to finish.'); return; }
      const now = Date.now();
      if (now - p.lastPaste < PASTE_COOLDOWN_MS) { note(p, 'Wait a minute before starting another vote.'); return; }
      p.lastPaste = now;
      room.vote = { id: nextVoteId++, by: p.id, specs, yes: new Set([p.id]), no: new Set(), end: now + VOTE_MS };
      broadcastRoom(p.room, voteMsg(p.room));
      tallyVote(p.room, false);
    }
    else if (m.t === 'vote') {
      const v = room.vote;
      if (!v || v.id !== m.id || v.yes.has(p.id) || v.no.has(p.id)) return;
      (m.yes ? v.yes : v.no).add(p.id);
      tallyVote(p.room, false);
    }
    else if (m.t === 'mod') {                                // unlock mod tools with the code
      const rec = modTries.get(p.ip) || { n: 0, until: 0 };
      if (Date.now() < rec.until) { sendTo(p, { t: 'mod', ok: false, locked: true }); return; }
      if (typeof m.code === 'string' && m.code.length <= 32 && safeEq(m.code.trim(), MOD_CODE)) {
        p.mod = true; modTries.delete(p.ip); sendTo(p, { t: 'mod', ok: true }); broadcastRoom(p.room, lookMsg(p));
      } else {
        rec.n++; if (rec.n >= MOD_MAX_TRIES) { rec.until = Date.now() + MOD_LOCK_MS; rec.n = 0; }
        modTries.set(p.ip, rec);
        sendTo(p, { t: 'mod', ok: false, locked: Date.now() < rec.until });
      }
    }
    else if (m.t === 'clearall') {                           // mod: wipe every block on this map
      if (!p.mod) return;
      const ids = [...room.blocks.keys()]; room.blocks.clear();
      if (ids.length) broadcastRoom(p.room, { t: 'del', ids });
      note(p, 'Map cleared.');
    }
    else if (m.t === 'ban') {                                // mod: ban a player
      if (!p.mod) return;
      const target = players.get(m.id);
      if (!target || target === p || target.mod) { note(p, 'Cannot ban that player.'); return; }
      banPlayer(target); note(p, 'Banned player #' + m.id + '.');
    }
    else if (m.t === 'unbanall') {
      if (!p.mod) return;
      bannedIPs.clear(); bannedCids.clear(); note(p, 'Everyone was unbanned.');
    }
  });
  ws.on('close', () => removePlayer(p));
  ws.on('error', () => {});
});

setInterval(() => { for (const p of players.values()) { p.count = 0; p.rtc = 0; } }, 1000);

// Pose snapshots: each client only gets the players in its own room.
const lastEmpty = new WeakMap();
setInterval(() => {
  const now = Date.now();
  for (const id of MAP_IDS) { const v = rooms[id].vote; if (v && now > v.end) tallyVote(id, true); }
  const live = [];
  for (const p of players.values()) if (p.pose && now - p.t < STALE_MS) live.push(p);
  for (const p of players.values()) {
    if (p.ws.readyState !== 1 || p.ws.bufferedAmount > 1e6) continue;
    const others = live.filter(q => q !== p && q.room === p.room).map(q => [q.id, q.color, ...q.pose]);
    if (others.length === 0 && lastEmpty.get(p.ws)) continue;
    lastEmpty.set(p.ws, others.length === 0);
    p.ws.send(JSON.stringify({ t: 's', p: others }));
  }
}, TICK_MS);

// How many players are on each map + who is in your room (for the mod ban list).
setInterval(() => {
  const counts = {}; MAP_IDS.forEach(id => { counts[id] = 0; });
  for (const p of players.values()) counts[p.room]++;
  for (const p of players.values()) {
    sendTo(p, { t: 'info', counts, roster: roomPlayers(p.room).map(q => [q.id, q.color, q.name]) });
  }
}, 2000);

// Keep connections alive through proxies and clean up dead ones.
setInterval(() => {
  for (const p of [...players.values()]) {
    if (!p.alive) { p.ws.terminate(); removePlayer(p); continue; }
    p.alive = false; try { p.ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log('Gorilla VR server on port ' + PORT));
