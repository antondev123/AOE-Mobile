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

import { createMatch, CHECKSUM_EVERY, COMMAND_DELAY } from './match.js';
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

/**
 * How long an empty room is kept before it is thrown away.
 *
 * Generous on purpose: a player whose phone dropped the connection mid-match
 * has this long to come back to their seat. It is only ever reached by a room
 * with nobody in it at all.
 */
const IDLE_REAP_MS = 5 * 60_000;

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
    // Both seats start open, and an open seat runs nothing.
    //
    // The tempting alternative — start them as AI so the match is "alive" the
    // instant it is created — quietly breaks lockstep. Clients rebuild from
    // match.snapshot(), which carries the world but not the AI's memory, so the
    // instant an AI acts the two machines are playing different games. See the
    // note on the AI step in match.js. A seat nobody has claimed simply waits.
    seats: [{ kind: 'open' }, { kind: 'open' }],
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
    // A room waits in the lobby until both seats are held and both players have
    // said they are ready. Until then the clock does not run at all: a match
    // that started the moment its link was created would be four minutes old by
    // the time the second player opened it, which is not a 1v1 so much as an
    // invitation to inspect somebody's ruins.
    started: false,
  };

  // Tell everyone a command exists the moment it is stamped, not when it fires.
  //
  // This is the difference between a delay that buys something and a delay that
  // buys nothing. The server runs ahead of no one: if it only announced a
  // command as it executed it, the announcement would reach a client that had
  // already simulated that tick, and every single order would cost a resync.
  // Stamped four ticks out and announced immediately, the message has 200ms of
  // road in front of it, which is the entire point of COMMAND_DELAY.
  match.onSchedule(({ at, cmd }) => {
    broadcast(room, { type: 'sched', at, cmd });
  });

  // The authoritative clock. setInterval drifts; we correct against real time so
  // a room that falls behind catches up rather than quietly running slow.
  let expected = Date.now();
  room.timer = setInterval(() => {
    const now = Date.now();
    // Reap rooms nobody is in. This is checked *before* the lobby gate below,
    // and the ordering is the whole point: a room that never starts would
    // otherwise never reach the reaper, and every "Play a friend" tap that was
    // never followed through would leave a timer and a 96x96 world behind for
    // the lifetime of the process. Which is the common case — people create an
    // invite, get distracted, and close the tab.
    if (room.clients.size === 0 && now - room.lastActivity > IDLE_REAP_MS) {
      closeRoom(room);
      return;
    }

    if (!room.started) {
      // Hold the clock at the starting line rather than letting it drift, so
      // the first tick played is tick 0 however long the lobby took.
      expected = now;
      return;
    }
    let steps = 0;
    while (expected <= now && steps < 10) {
      match.step();
      if (match.tick % CHECKSUM_EVERY === 0) {
        // Doubles as the clock beacon: a client that knows the server's tick
        // knows how far it is allowed to simulate, and corrects its own drift
        // against this rather than against its own frame timer.
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
  }, SIM_DT * 1000);

  // A room's clock is not a reason to keep the process alive — the listening
  // socket is. Without this an empty room holds the event loop open until the
  // reaper gets to it, which is why the test suite used to sit for five silent
  // minutes after its last assertion before node would exit.
  if (typeof room.timer.unref === 'function') room.timer.unref();

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

/**
 * Who is in the room and who has said they are ready, per seat.
 *
 * Seat-indexed rather than client-indexed because that is what the lobby draws:
 * "Player 1 — ready, Player 2 — waiting" is a statement about chairs, and a
 * chair nobody is sitting in is a different thing from one whose occupant has
 * not pressed the button yet.
 */
function lobbyState(room) {
  const seats = room.match.roster.map((s, i) => {
    const client = room.seatOf.get(i);
    return { seat: i, filled: !!client, ready: !!(client && client.ready), kind: s.kind };
  });
  return { type: 'lobby', seats, started: room.started };
}

/** Begin, but only once every seat is filled and every player has said so. */
function maybeStart(room) {
  if (room.started) return;
  const seats = room.match.roster;
  for (let i = 0; i < seats.length; i++) {
    const client = room.seatOf.get(i);
    if (!client || !client.ready) return;
  }
  room.started = true;
  // The snapshot rides along with the go signal so both clients build their
  // world from the same bytes at the same tick, rather than from whatever they
  // were sent when they happened to connect.
  broadcast(room, {
    type: 'start',
    tick: room.match.tick,
    snapshot: room.match.snapshot(),
    pending: room.match.since(room.match.tick),
  });
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
        matchId: room.id, seed: room.seed,
        tick: room.match.tick, commandDelay: COMMAND_DELAY,
        snapshot: room.match.snapshot(),
        pending: room.match.since(room.match.tick),
      });
      socket.on('close', () => room.clients.delete(client));
      return;
    }

    const client = { socket, playerId: seat, spectator: false, ready: false };
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
      tick: room.match.tick,
      commandDelay: COMMAND_DELAY,
      // Already running means this is a reconnect, and a reconnecting player
      // goes straight back to their game rather than to a lobby asking them to
      // get ready for a match that is half over.
      started: room.started,
      lobby: lobbyState(room).seats,
      // A joiner mid-match rebuilds from the snapshot; one who joins at tick 0
      // gets it too and simply starts from a world that has not moved.
      snapshot: room.match.snapshot(),
      // Commands already stamped for ticks this client has not reached. Without
      // these, an order given a moment before the join lands on one machine and
      // not the other.
      pending: room.match.since(room.match.tick),
    });
    broadcast(room, { type: 'seats', seats: room.match.roster.map((s) => s.kind) });
    broadcast(room, lobbyState(room));

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

      if (msg.type === 'ready') {
        client.ready = msg.ready !== false;
        broadcast(room, lobbyState(room));
        maybeStart(room);
        return;
      }

      if (msg.type === 'resync') {
        // The snapshot is of *this* tick, so anything already stamped for a
        // later one has to come with it or it is lost in the rebuild.
        send(client, {
          type: 'snapshot',
          tick: room.match.tick,
          snapshot: room.match.snapshot(),
          pending: room.match.since(room.match.tick),
        });
      }
    });

    socket.on('close', () => {
      room.clients.delete(client);
      if (client.playerId !== null && room.seatOf.get(client.playerId) === client) {
        room.seatOf.delete(client.playerId);
        // Back to open, not to an AI: see createRoom. The seat is free for them
        // to reconnect into, and stands still until they do.
        room.match.takeOver(client.playerId, 'open');
        broadcast(room, { type: 'seats', seats: room.match.roster.map((s) => s.kind) });
        // Their ready went with them: whoever takes the seat next has to say so
        // themselves, and the player still waiting sees the lobby fall back a
        // step rather than a phantom tick next to an empty chair.
        broadcast(room, lobbyState(room));
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
