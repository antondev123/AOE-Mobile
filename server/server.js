// The match server: static files on one port, websockets on the same one.
//
// Serving the game and the socket from a single origin is not tidiness — it is
// what makes an invite link a link. A player opens https://host/?m=abc123 and
// the page it loads already knows where its match lives, with no configuration,
// no CORS, and no second hostname to keep in sync.
//
// Rooms are held in memory. A restart drops matches in progress, which is the
// correct trade for now: a match is minutes long, deploys are rare, and the
// alternative is a database this project does not otherwise need. When that
// stops being true, match.snapshot() is already the thing to persist.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createMatch, CHECKSUM_EVERY } from './match.js';
import { SIM_DT } from '../src/core/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};

// --- rooms -------------------------------------------------------------------

const rooms = new Map();

/** Match ids are read aloud and typed by hand, so no l/1/O/0. */
function makeMatchId(rng = Math.random) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

function createRoom(id, seed) {
  const match = createMatch({
    seed,
    // Both seats start as AI. A seat becomes human the moment someone claims
    // it, which means a match is playable the instant it is created and a
    // player who never shows up is simply an AI opponent.
    seats: [{ kind: 'ai' }, { kind: 'ai' }],
  });

  const room = {
    id,
    match,
    seed,
    clients: new Set(),
    // playerId -> client, so a reconnecting player gets their own seat back.
    seatOf: new Map(),
    timer: null,
    lastActivity: Date.now(),
  };

  // The authoritative clock. setInterval drifts; we correct against real time so
  // a room that falls behind catches up rather than quietly running slow.
  let expected = Date.now();
  room.timer = setInterval(() => {
    const now = Date.now();
    let steps = 0;
    while (expected <= now && steps < 10) {
      const res = match.step();
      if (res && res.applied.length) {
        broadcast(room, { type: 'tick', tick: res.tick, cmds: res.applied.map((a) => a.cmd) });
      }
      if (match.tick % CHECKSUM_EVERY === 0) {
        broadcast(room, { type: 'sum', tick: match.tick, sum: match.checksum() });
      }
      expected += SIM_DT * 1000;
      steps++;
    }
    if (steps === 10) expected = now; // fell too far behind; resync the clock

    if (match.over) {
      broadcast(room, { type: 'over', winner: match.over.winner });
      closeRoom(room);
    }
    // Reap rooms nobody is in.
    if (room.clients.size === 0 && Date.now() - room.lastActivity > 5 * 60_000) {
      closeRoom(room);
    }
  }, SIM_DT * 1000);

  rooms.set(id, room);
  return room;
}

function closeRoom(room) {
  clearInterval(room.timer);
  rooms.delete(room.id);
  for (const c of room.clients) {
    try { c.socket.close(); } catch { /* already gone */ }
  }
}

function send(client, msg) {
  if (client.socket.readyState === 1) client.socket.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
  const text = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c.socket.readyState === 1) c.socket.send(text);
  }
}

/** The lowest seat no live client holds, or null if the match is full. */
function freeSeat(room) {
  for (let i = 0; i < room.match.roster.length; i++) {
    if (!room.seatOf.has(i)) return i;
  }
  return null;
}

// --- static files ------------------------------------------------------------

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

// --- wiring ------------------------------------------------------------------

export function startServer(port = PORT) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }

    // Create a match and hand back its id, so the client can build an invite.
    if (url.pathname === '/api/match' && req.method === 'POST') {
      const id = makeMatchId();
      const seed = Math.floor(Math.random() * 1e9);
      createRoom(id, seed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, seed }));
      return;
    }

    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const matchId = url.searchParams.get('m');
    const room = matchId && rooms.get(matchId);

    if (!room) {
      send({ socket }, { type: 'error', reason: 'no-such-match' });
      socket.close();
      return;
    }

    const seat = freeSeat(room);
    if (seat === null) {
      // Full. Watching is still allowed — a spectator gets the same stream and
      // simply never has a seat to command from.
      const client = { socket, playerId: null, spectator: true };
      room.clients.add(client);
      send(client, {
        type: 'welcome', playerId: null, spectator: true,
        matchId: room.id, seed: room.seed, snapshot: room.match.snapshot(),
      });
      socket.on('close', () => room.clients.delete(client));
      return;
    }

    const client = { socket, playerId: seat, spectator: false };
    room.clients.add(client);
    room.seatOf.set(seat, client);
    room.lastActivity = Date.now();
    room.match.takeOver(seat, 'human');

    send(client, {
      type: 'welcome',
      playerId: seat,
      spectator: false,
      matchId: room.id,
      seed: room.seed,
      // A joiner mid-match rebuilds from the snapshot; one who joins at tick 0
      // gets it too and simply starts from a world that has not moved.
      snapshot: room.match.snapshot(),
    });
    broadcast(room, { type: 'seats', seats: room.match.roster.map((s) => s.kind) });

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      room.lastActivity = Date.now();

      if (msg.type === 'cmd') {
        // The seat is assigned by the server, never taken from the message.
        // This single line is the difference between a game and a game anyone
        // can cheat at.
        const cmd = { ...msg.cmd, p: client.playerId };
        if (client.spectator) return;
        room.match.submit(cmd);
        return;
      }

      if (msg.type === 'resync') {
        send(client, { type: 'snapshot', snapshot: room.match.snapshot() });
      }
    });

    socket.on('close', () => {
      room.clients.delete(client);
      if (client.playerId !== null && room.seatOf.get(client.playerId) === client) {
        room.seatOf.delete(client.playerId);
        // Hand the seat to the AI so the remaining player still has a game.
        room.match.takeOver(client.playerId, 'ai');
        broadcast(room, { type: 'seats', seats: room.match.roster.map((s) => s.kind) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, wss, port: server.address().port, rooms }));
  });
}

// Started directly (not imported by a test)?
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  startServer().then(({ port }) => {
    console.log(`[match] listening on :${port}`);
  });
}
