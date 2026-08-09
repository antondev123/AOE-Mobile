// Two real clients, one real server, over an actual socket.
//
// tests/multiplayer.test.mjs proves the simulation agrees with itself. This
// proves the wire does not undo that: seats get assigned, commands travel,
// nobody can command a seat they were not given, and a disconnect hands the
// seat to the AI instead of stalling the other player.

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

  // A command from A must reach B, stamped with A's seat.
  const world = room.match.world;
  const mine = world.units.filter((u) => u.player === 0 && u.type === 'villager').map((u) => u.id);
  a.send({ type: 'cmd', cmd: { t: 'order', units: mine.slice(0, 2), order: { type: 'move', gx: 44, gy: 44 } } });

  const tickMsg = await b.await((m) => m.type === 'tick' && m.cmds.some((c) => c.t === 'order'));
  const cmd = tickMsg.cmds.find((c) => c.t === 'order');
  assert.equal(cmd.p, 0, 'the command did not carry the sender seat');
  assert.ok(tickMsg.tick > 0);
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

  const tickMsg = await b.await((m) => m.type === 'tick' && m.cmds.some((c) => c.t === 'allocationOn'));
  const cmd = tickMsg.cmds.find((c) => c.t === 'allocationOn');
  assert.equal(cmd.p, 1, 'a client forged another players seat');
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

test('a disconnect hands the seat to the AI, and rejoining takes it back', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const a = await connect(port, id);
  const b = await connect(port, id);
  t.after(async () => { await a.close(); });

  const room = rooms.get(id);
  assert.deepEqual(room.match.roster.map((s) => s.kind), ['human', 'human']);

  await b.close();
  await a.await((m) => m.type === 'seats' && m.seats[1] === 'ai');
  assert.equal(room.match.roster[1].kind, 'ai', 'the empty seat was not handed to the AI');

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

test('the match clock actually advances in real time', async (t) => {
  const { server, port, rooms } = await startServer(0);
  t.after(() => server.close());

  const { id } = await newMatch(port);
  const room = rooms.get(id);
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
