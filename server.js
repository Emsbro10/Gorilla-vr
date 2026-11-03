// Gorilla VR multiplayer server: serves the game page, relays player poses, and keeps the shared map + built blocks.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 24;
const TICK_MS = 50;            // pose snapshots to clients (20 Hz)
const STALE_MS = 3000;         // drop players who stopped sending
const MAP_IDS = ['classic', 'blank', 'towers', 'parkour', 'islands'];
const MAX_BLOCKS = 300;        // per map

// Find the game page wherever it ended up: next to server.js, in public/, or one folder deeper, and with ANY capital
// letters (Linux is case-sensitive, and phone keyboards love capitalising "Public" / "Index.html").
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

const wss = new WebSocketServer({ server, maxPayload: 16384 });
const players = new Map();
let nextId = 1, nextBlockId = 1, lastMapSwitch = 0;

// Shared world: which map everybody is on, and the blocks built on each map (kept in memory).
const world = { map: 'classic' };
const blocks = {}; MAP_IDS.forEach(id => { blocks[id] = new Map(); });

const okNums = (a, n) =>
  Array.isArray(a) && a.length === n && a.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1000);

function cleanSpec(a) {
  if (!Array.isArray(a) || a.length !== 7 || !a.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  const [x, y, z, w, h, d, mi] = a;
  if (Math.abs(x) > 100 || Math.abs(z) > 100 || y < -1 || y > 80) return null;
  const cl = v => Math.min(20, Math.max(0.1, v));
  return [x, y, z, cl(w), cl(h), cl(d), Math.min(9, Math.max(0, Math.round(mi)))];
}

const sendTo = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const broadcast = o => { const m = JSON.stringify(o); for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(m); };
const worldMsg = () => ({ t: 'w', map: world.map, blocks: [...blocks[world.map].values()] });

wss.on('connection', ws => {
  if (players.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const id = nextId++;
  const p = { id, ws, color: 0xcccccc, pose: null, t: 0, count: 0, alive: true };
  players.set(id, p);
  sendTo(p, { t: 'hi', id });
  sendTo(p, worldMsg());

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', data => {
    if (++p.count > 60) return;                          // max ~60 msgs/sec per player
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'u') {                                   // my head + hands
      if (m.off) { p.pose = null; return; }
      if (!okNums(m.h, 7) || !okNums(m.l, 3) || !okNums(m.r, 3)) return;
      if (Number.isInteger(m.c) && m.c >= 0 && m.c <= 0xffffff) p.color = m.c;
      p.pose = [...m.h, ...m.l, ...m.r];
      p.t = Date.now();
    }
    else if (m.t === 'map') {                            // everybody switches maps together
      const now = Date.now();
      if (!MAP_IDS.includes(m.id) || m.id === world.map || now - lastMapSwitch < 1500) return;
      lastMapSwitch = now; world.map = m.id;
      broadcast(worldMsg());
    }
    else if (m.t === 'add') {                            // build blocks
      if (!Array.isArray(m.specs)) return;
      const store = blocks[world.map], list = [];
      for (const raw of m.specs.slice(0, MAX_BLOCKS)) {
        if (store.size >= MAX_BLOCKS) break;
        const s = cleanSpec(raw); if (!s) continue;
        const b = { id: nextBlockId++, s, o: p.id };
        store.set(b.id, b); list.push(b);
      }
      if (list.length) broadcast({ t: 'add', list });
    }
    else if (m.t === 'del') {                            // you can only delete your own blocks
      if (!Array.isArray(m.ids)) return;
      const store = blocks[world.map], gone = [];
      for (const bid of m.ids.slice(0, 100)) {
        const b = store.get(bid);
        if (b && b.o === p.id) { store.delete(bid); gone.push(bid); }
      }
      if (gone.length) broadcast({ t: 'del', ids: gone });
    }
    else if (m.t === 'clear') {                          // remove all MY blocks on this map
      const store = blocks[world.map], gone = [];
      for (const [bid, b] of store) if (b.o === p.id) { store.delete(bid); gone.push(bid); }
      if (gone.length) broadcast({ t: 'del', ids: gone });
    }
  });
  ws.on('close', () => players.delete(id));
  ws.on('error', () => {});
});

setInterval(() => { for (const p of players.values()) p.count = 0; }, 1000);

// One snapshot per tick: each client gets everyone else's pose.
const lastEmpty = new WeakMap();
setInterval(() => {
  const now = Date.now();
  const live = [];
  for (const p of players.values()) if (p.pose && now - p.t < STALE_MS) live.push(p);
  for (const p of players.values()) {
    if (p.ws.readyState !== 1 || p.ws.bufferedAmount > 1e6) continue;
    const others = live.filter(q => q !== p).map(q => [q.id, q.color, ...q.pose]);
    if (others.length === 0 && lastEmpty.get(p.ws)) continue;
    lastEmpty.set(p.ws, others.length === 0);
    p.ws.send(JSON.stringify({ t: 's', p: others }));
  }
}, TICK_MS);

// Keep connections alive through proxies and clean up dead ones.
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); players.delete(p.id); continue; }
    p.alive = false; try { p.ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log('Gorilla VR server on port ' + PORT));
