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
        /** Wait for a message matching `pred`, or reject after `ms`. */
        await: (pred, ms = 4000) => new Promise((res, rej) => {
          const found = inbox.find(pred);
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

test('two clients join one match, get different seats, and exchange commands', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); });

  assert.equal(a.hello.type, 'welcome');
  assert.equal(b.hello.type, 'welcome');
  assert.equal(a.hello.playerId, 0);
  assert.equal(b.hello.playerId, 1);
  assert.equal(a.hello.seed, b.hello.seed, 'players were given different seeds');
  assert.ok(a.hello.snapshot, 'no snapshot for a joining player');

  // Both seats are now human.
  const room = rooms.get(id);
  assert.deepEqual(room.match.roster.map((s) => s.kind), ['human', 'human']);

  // A command from A must reach B, stamped with A's seat and with a tick that
  // is still in B's future — announcing it as it executed would leave B no time
  // to run it on the same tick, which is the entire purpose of the delay.
  const world = room.match.world;
  const mine = world.units.filter((u) => u.player === 0 && u.type === 'villager').map((u) => u.id);
  const sentAt = room.match.tick;
  a.send({ type: 'cmd', cmd: { t: 'order', units: mine.slice(0, 2), order: { type: 'move', gx: 44, gy: 44 } } });

  const sched = await b.await((m) => m.type === 'sched' && m.cmd.t === 'order');
  assert.equal(sched.cmd.p, 0, 'the command did not carry the sender seat');
  assert.ok(sched.at > sentAt, 'the command was scheduled for a tick already gone');
});

test('the server assigns the seat, so a forged one is ignored', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); });

  // B (seat 1) claims to be seat 0.
  b.send({ type: 'cmd', cmd: { t: 'allocationOn', p: 0, on: true } });

  const sched = await b.await((m) => m.type === 'sched' && m.cmd.t === 'allocationOn');
  assert.equal(sched.cmd.p, 1, 'a client forged another players seat');
});

test('a third client may watch but never gets a seat', async (t) => {
  const { server, port } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  const c = await connect(port, id);
  t.after(async () => { await a.close(); await b.close(); await c.close(); });

  assert.equal(c.hello.spectator, true);
  assert.equal(c.hello.playerId, null);
  assert.ok(c.hello.snapshot, 'a spectator got no world to watch');
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
  assert.deepEqual(room.match.roster.map((s) => s.kind), ['human', 'human']);

  await b.close();
  await a.await((m) => m.type === 'seats' && m.seats[1] === 'open');
  assert.equal(room.match.roster[1].kind, 'open', 'the empty seat was not freed');

  const b2 = await connect(port, id);
  t.after(async () => { await b2.close(); });
  assert.equal(b2.hello.playerId, 1, 'the freed seat was not handed back');
  assert.equal(room.match.roster[1].kind, 'human');
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

  assert.equal(a.hello.started, false, 'the match started before anybody was ready');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(room.match.tick, 0, 'the clock ran while the room was still in its lobby');

  a.send({ type: 'ready', ready: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(room.started, false, 'one player readying up started the match');

  b.send({ type: 'ready', ready: true });
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
