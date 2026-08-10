// Two real clients, one real server, over an actual socket.
//
// tests/multiplayer.test.mjs proves the simulation agrees with itself. This
// proves the wire does not undo that: seats get assigned, commands travel
// *stamped with the tick they will fire on*, nobody can command a seat they
// were not given, and a disconnect frees the seat rather than stalling the
// other player.

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { startServer } from '../server/server.js';

/** Open a socket and resolve once the server has said hello. */
function connect(port, matchId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?m=${matchId}`);
    const inbox = [];
    ws.on('message', (raw) => inbox.push(JSON.parse(raw)));
    ws.on('error', reject);
    ws.once('message', (raw) => {
      const hello = JSON.parse(raw);
      resolve({
        ws,
        hello,
        inbox,
        send: (msg) => ws.send(JSON.stringify(msg)),
        close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
        /** The current inbox depth, to await only what arrives after this point. */
        mark: () => inbox.length,
        /**
         * Wait for a message matching `pred`, or reject after `ms`.
         *
         * The inbox is searched first so a message that arrived before the call
         * is not missed. `from` bounds that search: a client sees a lobby
         * broadcast for every roster change including its own arrival, and an
         * earlier one carrying the state we are waiting for is not evidence the
         * later change happened. Pass `c.mark()` taken before the action.
         */
        await: (pred, { ms = 4000, from = 0 } = {}) => new Promise((res, rej) => {
          const found = inbox.slice(from).find(pred);
          if (found) return res(found);
          const t = setTimeout(() => {
            ws.off('message', onMsg);
            rej(new Error('timed out waiting for message'));
          }, ms);
          const onMsg = (raw2) => {
            const m = JSON.parse(raw2);
            if (pred(m)) { clearTimeout(t); ws.off('message', onMsg); res(m); }
          };
          ws.on('message', onMsg);
        }),
      });
    });
  });
}

async function newMatch(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/match`, { method: 'POST' });
  return res.json();
}

/**
 * Take a lobby to a running match.
 *
 * The room holds no world until this happens: player count and map size are
 * lobby decisions, so there is nothing to build until the roster settles. And
 * beginning is the host pressing a button rather than a side effect of the last
 * person readying up, because with AI chairs "everyone is ready" can be true the
 * instant the room exists.
 */
async function begin(clients) {
  for (const c of clients) c.send({ type: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 120));
  clients[0].send({ type: 'start' });
  await Promise.all(clients.map((c) => c.await((m) => m.type === 'start')));
}

test('two clients join one match, get different seats, and exchange commands', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); });

  assert.equal(a.hello.type, 'welcome');
  assert.equal(b.hello.type, 'welcome');
  assert.equal(a.hello.you.slot, 0);
  assert.equal(b.hello.you.slot, 1);
  assert.equal(a.hello.seed, b.hello.seed, 'players were given different seeds');
  assert.equal(a.hello.phase, 'lobby', 'a fresh room waits in its lobby');
  assert.equal(a.hello.snapshot, null, 'and has no world to hand out yet');

  // Both seats are now human, and the host starts the match.
  const room = rooms.get(id);
  await begin([a, b]);
  assert.deepEqual(room.match.roster.map((s) => s.kind), ['human', 'human']);

  // A command from A must reach B, stamped with A's seat and with a tick that
  // is still in B's future — announcing it as it executed would leave B no time
  // to run it on the same tick, which is the entire purpose of the delay.
  const world = room.match.world;
  const mine = world.units.filter((u) => u.player === 0 && u.type === 'villager').map((u) => u.id);
  const sentAt = room.match.tick;
  a.send({ type: 'cmd', cmd: { t: 'order', units: mine.slice(0, 2), order: { type: 'move', gx: 44, gy: 44 } } });

  const sched = await b.await((m) => m.type === 'sched' && m.cmds[0].t === 'order');
  assert.equal(sched.cmds[0].p, 0, 'the command did not carry the sender seat');
  assert.ok(sched.at > sentAt, 'the command was scheduled for a tick already gone');
});

test('the server assigns the seat, so a forged one is ignored', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); });

  await begin([a, b]);

  // B (seat 1) claims to be seat 0.
  b.send({ type: 'cmd', cmd: { t: 'allocationOn', p: 0, on: true } });

  const sched = await b.await((m) => m.type === 'sched' && m.cmds[0].t === 'allocationOn');
  assert.equal(sched.cmds[0].p, 1, 'a client forged another players seat');
});

test('a third client may watch but never gets a seat', async (t) => {
  const { server, port } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  const c = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); await c.close(); });

  assert.equal(c.hello.you.spectator, true);
  assert.equal(c.hello.you.slot, null);
});

// The seat used to go to an AI here, which read better and was wrong: a client
// rebuilds from match.snapshot(), and that snapshot carries the world but not
// the AI's memory. The moment such an AI acted, the two machines would be
// playing different games — with no symptom beyond a checksum mismatch and a
// resync every second. An empty seat now stands still, and standing still is
// something both ends can agree on.
test('a disconnect frees the seat without letting an AI desync it, and rejoining takes it back', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); });

  const room = rooms.get(id);
  assert.deepEqual(room.config.slots.map((s) => s.kind), ['human', 'human']);

  const mark = a.mark();
  await b.close();
  await a.await((m) => m.type === 'lobby' && m.slots[1].kind === 'open', { from: mark });
  assert.equal(room.config.slots[1].kind, 'open', 'the empty seat was not freed');

  const b2 = await connect(port, id);
  t.after(async () => { await b2.close(); });
  assert.equal(b2.hello.you.slot, 1, 'the freed seat was not handed back');
  assert.equal(room.config.slots[1].kind, 'human');
});

test('joining a match that does not exist is refused, not crashed', async (t) => {
  const { server, port } = await startServer(0);
  t.after(() => server.close());

  const c = await connect(port, 'nosuch');
  assert.equal(c.hello.type, 'error');
  assert.equal(c.hello.reason, 'no-such-match');
});

// The clock is deliberately held until the lobby releases it — a match that
// began when its link was created would be minutes old by the time the second
// player opened that link. So this fills both seats and readies up first, and
// in doing so covers the gate as well as the rate.
test('the match clock is held in the lobby and advances once both players are ready', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const room = rooms.get(id);

  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); });

  assert.equal(a.hello.phase, 'lobby', 'the match started before anybody was ready');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(room.match, null, 'a world was built while the room was still a lobby');

  a.send({ type: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(room.phase, 'lobby', 'one player readying up started the match');

  // The host presses Start. With AI chairs "everyone ready" can be true the
  // instant a room exists, so beginning is a decision rather than a side effect.
  b.send({ type: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 150));
  a.send({ type: 'start' });
  await b.await((m) => m.type === 'start');

  const t0 = room.match.tick;
  await new Promise((r) => setTimeout(r, 1000));
  const advanced = room.match.tick - t0;

  // 20Hz, with generous slack for a loaded CI box.
  assert.ok(advanced >= 10, `only ${advanced} ticks in a second`);
  assert.ok(advanced <= 32, `${advanced} ticks in a second — running too fast`);
});

test('health and match creation respond', async (t) => {
  const { server, port } = await startServer(0);
  t.after(() => server.close());

  const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.equal(health.ok, true);

  const m1 = await newMatch(port);
  const m2 = await newMatch(port);
  assert.match(m1.id, /^[a-z2-9]{6}$/);
  assert.notEqual(m1.id, m2.id, 'two matches got the same id');
});
