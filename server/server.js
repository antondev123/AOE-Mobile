// The match server: static files on one port, websockets on the same one.
//
// Serving the game and the socket from a single origin is not tidiness — it is
// what makes an invite link a link. A player opens https://host/?m=abc123 and
// the page it loads already knows where its match lives, with no configuration,
// no CORS, and no second hostname to keep in sync.
//
// This file is TRANSPORT. Every rule about what a host may do, what "everyone is
// ready" means and whether a match can begin lives in server/room.js, which is
// pure and tested without a port. What is here is sockets, the authoritative
// clock, and the room lifecycle.
//
// THE LIFECYCLE, which is the thing that changed when the lobby grew past two
// chairs:
//
//   create ─> [lobby] ──host start & canStart──> [starting] ─> [running] ─> [over]
//               │                                                            │
//               └── nobody here for IDLE_REAP_MS ──> [closed] <──────────────┘
//
// The match does not exist until it starts. It used to be built the instant
// somebody tapped "Play a friend", which was only possible because every match
// was two players on a 96x96 map — both of those are lobby decisions now. It is
// also why an abandoned invite used to leave a whole world and a 20Hz timer
// behind until the reaper got to it, which is the common case: people create a
// link, get distracted, and close the tab.
//
// Rooms are held in memory. A restart drops matches in progress, which is the
// correct trade for now: a match is minutes long, deploys are rare, and the
// alternative is a database this project does not otherwise need.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { createMatch, CHECKSUM_EVERY, COMMAND_DELAY } from './match.js';
import {
  createConfig, mapDimsFor, setSlotCount, setSlot, setMap, setSeed,
  claimSlot, releaseSlot, setReady, canStart, toRoster, fillOpenSlots,
  firstOpenSlot, lobbyPayload,
} from './room.js';
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
 * Generous on purpose: a player whose phone dropped the connection mid-match has
 * this long to come back to their seat. It is only ever reached by a room with
 * nobody in it at all.
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
  const room = {
    id,
    phase: 'lobby',
    config: createConfig(seed),
    match: null,
    clients: new Set(),
    // The chair a token owns, kept even while that client is away. This is what
    // makes reconnection return you to your OWN town rather than to whichever
    // hole happens to be lowest — which is all connection order could ever offer
    // and is wrong the moment there are more than two chairs.
    tokenSlot: new Map(),
    hostToken: null,
    timer: null,
    lastActivity: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function closeRoom(room) {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  room.phase = 'closed';
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

/** The chair the host is sitting in, for the lobby to badge. */
function hostSlot(room) {
  if (!room.hostToken) return null;
  const s = room.tokenSlot.get(room.hostToken);
  return s === undefined ? null : s;
}

function pushLobby(room) {
  // Serialised once and sent to everybody: the payload deliberately carries no
  // per-recipient field, because `welcome.you.slot` is the single source of
  // "which one am I".
  broadcast(room, lobbyPayload(room.config, { hostSlot: hostSlot(room), phase: room.phase }));
}

/** Whoever is seated and lowest takes the room when the host leaves. */
function reassignHost(room) {
  if (room.hostToken && [...room.clients].some((c) => c.token === room.hostToken)) return;
  let best = null;
  for (const c of room.clients) {
    if (c.slot === null || c.slot === undefined) continue;
    if (!best || c.slot < best.slot) best = c;
  }
  room.hostToken = best ? best.token : null;
}

const isHost = (room, client) => !!room.hostToken && client.token === room.hostToken;

// --- starting ----------------------------------------------------------------

/**
 * Build the match and tell everyone.
 *
 * `starting` is a real phase, however brief. generateMap() on a 192x192 map with
 * eight bases is a synchronous block long enough that a client which had already
 * received `start` and begun simulating would race the server. So the order is:
 * freeze, build, broadcast with the snapshot, and only then set the clock going.
 */
function startMatch(room) {
  room.phase = 'starting';

  const dims = mapDimsFor(room.config);
  const roster = toRoster(room.config);
  room.match = createMatch({
    seed: room.config.seed,
    seats: roster,
    width: dims.width,
    height: dims.height,
  });

  // Tell everyone a command exists the moment it is stamped, not when it fires.
  //
  // This is the difference between a delay that buys something and one that buys
  // nothing. The server runs ahead of no one: announced as it executed, the
  // message would reach a client that had already simulated that tick and every
  // order would cost a resync. Stamped four ticks out and announced immediately,
  // it has 200ms of road in front of it, which is the entire point of
  // COMMAND_DELAY.
  //
  // Batched by tick. One message per command amplifies badly with eight seats,
  // and everything stamped for a tick is known together anyway.
  room.match.onSchedule(({ at, cmd }) => {
    broadcast(room, { type: 'sched', at, cmds: [cmd] });
  });

  broadcast(room, {
    type: 'start',
    tick: room.match.tick,
    roster,
    world: { width: dims.width, height: dims.height, seed: room.config.seed },
    snapshot: room.match.snapshot(),
    pending: room.match.since(room.match.tick),
  });

  room.phase = 'running';
  runClock(room);
}

/**
 * The authoritative clock. setInterval drifts; this corrects against real time,
 * so a room that falls behind catches up rather than quietly running slow.
 */
function runClock(room) {
  let expected = Date.now();
  room.timer = setInterval(() => {
    const now = Date.now();
    if (room.clients.size === 0 && now - room.lastActivity > IDLE_REAP_MS) {
      closeRoom(room);
      return;
    }
    let steps = 0;
    while (expected <= now && steps < 10) {
      room.match.step();
      if (room.match.tick % CHECKSUM_EVERY === 0) {
        // Doubles as the clock beacon: a client that knows the server's tick
        // knows how far it may simulate, and corrects its drift against this
        // rather than against its own frame timer.
        broadcast(room, { type: 'sum', tick: room.match.tick, sum: room.match.checksum() });
      }
      expected += SIM_DT * 1000;
      steps++;
    }
    if (steps === 10) expected = now; // fell too far behind; resync the clock

    if (room.match.over) {
      room.phase = 'over';
      broadcast(room, {
        type: 'over',
        winner: room.match.over.winner,
        team: room.match.over.team ?? null,
      });
      closeRoom(room);
    }
  }, SIM_DT * 1000);

  // A room's clock is not a reason to keep the process alive — the listening
  // socket is. Without this an empty room holds the event loop open until the
  // reaper gets to it, which is why the test suite used to sit for five silent
  // minutes after its last assertion before node would exit.
  if (typeof room.timer.unref === 'function') room.timer.unref();
}

/** Rooms in the lobby have no clock, so they need reaping on their own beat. */
const lobbyReaper = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.phase !== 'lobby') continue;
    if (room.clients.size === 0 && now - room.lastActivity > IDLE_REAP_MS) closeRoom(room);
  }
}, 30_000);
if (typeof lobbyReaper.unref === 'function') lobbyReaper.unref();

// --- static files ------------------------------------------------------------

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
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
      // There is no nginx in front of this to set them.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
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
      try { socket.send(JSON.stringify({ type: 'error', reason: 'no-such-match', fatal: true })); }
      catch { /* already gone */ }
      socket.close();
      return;
    }

    // The token is in the query string rather than behind a hello handshake, so
    // `welcome` stays the first message and nobody pays a round trip for it.
    const token = url.searchParams.get('t') || `anon-${Math.random().toString(36).slice(2)}`;
    const name = (url.searchParams.get('n') || '').slice(0, 24);

    const client = { socket, token, name, slot: null, spectator: true };
    room.clients.add(client);
    room.lastActivity = Date.now();

    // Seat assignment, in strict priority order.
    //
    //   1. the chair this token already owns, in ANY phase — reconnection beats
    //      everything, and is the only way a dropped player gets their own town
    //      back rather than somebody else's;
    //   2. the lowest open chair, while we are still in the lobby;
    //   3. spectator, which is also how a mid-match joiner watches.
    const owned = room.tokenSlot.get(token);
    if (owned !== undefined && room.config.slots[owned]
        && room.config.slots[owned].clientId === null) {
      const s = room.config.slots[owned];
      s.kind = 'human';
      s.clientId = token;
      s.name = name || s.name;
      client.slot = owned;
      client.spectator = false;
    } else if (room.phase === 'lobby') {
      const open = firstOpenSlot(room.config);
      if (open !== null && claimSlot(room.config, open, token, name).ok) {
        client.slot = open;
        client.spectator = false;
        room.tokenSlot.set(token, open);
      }
    }

    if (!room.hostToken && client.slot !== null) room.hostToken = token;

    const running = room.phase === 'running' || room.phase === 'over';
    send(client, {
      type: 'welcome',
      matchId: room.id,
      seed: room.config.seed,
      commandDelay: COMMAND_DELAY,
      tick: running ? room.match.tick : 0,
      you: { slot: client.slot, host: isHost(room, client), spectator: client.spectator },
      phase: room.phase,
      lobby: lobbyPayload(room.config, { hostSlot: hostSlot(room), phase: room.phase }),
      roster: running ? toRoster(room.config) : null,
      world: running ? mapDimsFor(room.config) : null,
      // A joiner mid-match rebuilds from this; one still in the lobby gets the
      // world with the start signal, along with everybody else's copy.
      snapshot: running ? room.match.snapshot() : null,
      pending: running ? room.match.since(room.match.tick) : null,
    });
    pushLobby(room);

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      room.lastActivity = Date.now();

      const refuse = (reason) => send(client, { type: 'error', reason, fatal: false });
      const hostOnly = () => {
        if (!isHost(room, client)) { refuse('not-host'); return false; }
        if (room.phase !== 'lobby') { refuse('already-started'); return false; }
        return true;
      };
      const applied = (res) => {
        if (!res.ok) refuse(res.reason);
        else pushLobby(room);
      };

      switch (msg.type) {
        case 'setSlotCount':
          if (hostOnly()) applied(setSlotCount(room.config, msg.n));
          return;

        case 'setSlot':
          if (hostOnly()) {
            applied(setSlot(room.config, msg.index, {
              kind: msg.kind, team: msg.team, difficulty: msg.difficulty,
            }));
          }
          return;

        case 'setMap':
          if (hostOnly()) applied(setMap(room.config, msg.size));
          return;

        case 'setSeed':
          if (hostOnly()) applied(setSeed(room.config, msg.seed));
          return;

        case 'claim': {
          if (room.phase !== 'lobby') { refuse('already-started'); return; }
          const res = claimSlot(room.config, msg.slot, client.token, client.name);
          if (!res.ok) { refuse(res.reason); return; }
          client.slot = res.slot;
          client.spectator = false;
          room.tokenSlot.set(client.token, res.slot);
          if (!room.hostToken) room.hostToken = client.token;
          send(client, { type: 'you', slot: client.slot, spectator: false, host: isHost(room, client) });
          pushLobby(room);
          return;
        }

        case 'leave': {
          if (room.phase !== 'lobby') { refuse('already-started'); return; }
          releaseSlot(room.config, client.token);
          room.tokenSlot.delete(client.token);
          client.slot = null;
          client.spectator = true;
          reassignHost(room);
          send(client, { type: 'you', slot: null, spectator: true, host: false });
          pushLobby(room);
          return;
        }

        case 'ready':
          applied(setReady(room.config, client.token, msg.ready !== false));
          return;

        case 'start': {
          if (!hostOnly()) return;
          if (msg.fillOpen) {
            const filled = fillOpenSlots(room.config, msg.fillOpen);
            if (!filled.ok) { refuse(filled.reason); return; }
          }
          const go = canStart(room.config);
          if (!go.ok) { refuse(go.reason); pushLobby(room); return; }
          startMatch(room);
          return;
        }

        case 'cmd': {
          if (room.phase !== 'running') return;
          if (client.slot === null) return;
          const seat = room.config.slots[client.slot];
          if (!seat || seat.kind !== 'human') return;
          // The seat is assigned by the server, never taken from the message.
          // This single line is the difference between a game and a game anyone
          // can cheat at.
          room.match.submit({ ...msg.cmd, p: client.slot });
          return;
        }

        case 'resync': {
          if (room.phase !== 'running' && room.phase !== 'over') return;
          // The snapshot is of *this* tick, so anything already stamped for a
          // later one has to come with it or it is lost in the rebuild.
          send(client, {
            type: 'snapshot',
            tick: room.match.tick,
            roster: toRoster(room.config),
            snapshot: room.match.snapshot(),
            pending: room.match.since(room.match.tick),
          });
          return;
        }

        default:
          return;
      }
    });

    socket.on('close', () => {
      room.clients.delete(client);
      room.lastActivity = Date.now();
      if (client.slot === null) return;

      if (room.phase === 'lobby') {
        // In the lobby the chair goes back to open and the token forgets it: a
        // player who closed the tab before the match began is not coming back to
        // a seat, and holding it would block the room.
        releaseSlot(room.config, client.token);
        room.tokenSlot.delete(client.token);
      } else {
        // Mid-match the chair is HELD. tokenSlot still owns it, so reconnecting
        // returns them to their own town; the seat stands still until they do,
        // exactly as an unclaimed seat always has.
        const s = room.config.slots[client.slot];
        if (s && s.clientId === client.token) s.clientId = null;
      }
      reassignHost(room);
      pushLobby(room);
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
