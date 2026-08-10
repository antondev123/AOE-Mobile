// Two browsers, one match server, one game.
//
// Everything else in tests/ proves a piece of this in isolation: the command
// layer refuses what it should (command.test.mjs), two worlds fed the same
// commands stay identical (multiplayer.test.mjs), and the wire carries seats
// and schedules (netplay.test.mjs). None of them proves the thing that was
// actually asked for, which is that two people on two devices can play each
// other. That needs two real page loads, two real sockets, two real
// simulations, and a check that they still agree at the end.
//
// WHAT IT ASSERTS, IN ORDER OF HOW MUCH IT MATTERS
//   1. Both pages join the same match and are given *different* seats.
//   2. An order issued in page A moves units in page B. That is multiplayer.
//   3. After a few thousand ticks of both players issuing orders, the two
//      worlds still hash to the same value — the run stayed in lockstep rather
//      than drifting quietly apart.
//   4. Neither page logged an error.
//
// Run directly (node tests/multiplayer.browser.mjs), not under node --test:
// it drives a browser and takes tens of seconds.
//
// Pass a base URL to run the same checks against a deployed instance:
//
//     node tests/multiplayer.browser.mjs https://aoe-mobile.fly.dev
//
// which is the difference between "the code is right" and "the thing you can
// open on your phone works". Over a real network the clock and the command
// delay are doing something, rather than being a formality against localhost.

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { startServer } from '../server/server.js';
import { CHROMIUM, PHONE } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');

/** Where both players are told to send their villagers, so the move is obvious. */
const RALLY = { a: { gx: 30, gy: 30 }, b: { gx: 66, gy: 66 } };

/**
 * A loopback reverse proxy onto the deployment, for sandboxed runs.
 *
 * This exists because of the harness, not the thing under test. Inside this
 * sandbox node can reach the deployment (the match above is created over an
 * ordinary fetch) and Chromium cannot: direct navigation is reset, and tunnelled
 * navigation lands on the egress proxy's certificate, which the browser's trust
 * store does not carry. Neither symptom says anything about the server.
 *
 * So node does the talking. It makes a genuine HTTPS request to Fly and
 * verifies the chain the way everything else here does — against the CA
 * configuration the environment sets up, with no verification disabled, no
 * rejectUnauthorized:false, and no --ignore-certificate-errors anywhere. What
 * Chromium sees is plain HTTP on 127.0.0.1.
 *
 * The consequence worth being honest about: the browser's own leg is not
 * encrypted, so this proves the deployed server's behaviour rather than the
 * browser's TLS. Every byte still originates from the machine on Fly. The
 * WebSocket upgrade is forwarded too, which is the part that matters — the
 * match traffic is the point of the test.
 *
 * On a machine with ordinary egress this is never constructed.
 */
function reverseProxy(origin) {
  const target = new URL(origin);
  const opts = (req, extraHeaders = {}) => ({
    protocol: target.protocol,
    host: target.hostname,
    port: target.port || 443,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: target.host, ...extraHeaders },
    servername: target.hostname,
  });

  const server = http.createServer((req, res) => {
    const up = https.request(opts(req), (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', (e) => { res.writeHead(502).end(`upstream: ${e.message}`); });
    req.pipe(up);
  });

  // WebSockets. The upgrade has to be replayed against the real host and then
  // the two sockets simply joined; nothing inspects what crosses afterwards.
  server.on('upgrade', (req, socket, head) => {
    const up = https.request(opts(req));
    up.end();
    up.on('upgrade', (ur, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${ur.statusCode} ${ur.statusMessage}`];
      for (const [k, v] of Object.entries(ur.headers)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upHead && upHead.length) socket.write(upHead);
      if (head && head.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
      const bail = () => { upSocket.destroy(); socket.destroy(); };
      upSocket.on('error', bail);
      socket.on('error', bail);
    });
    up.on('error', () => socket.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
  });
}

function ok(label) { console.log(`  ok   ${label}`); }
function fail(label, detail) {
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
  process.exitCode = 1;
}
function check(cond, label, detail) { cond ? ok(label) : fail(label, detail); }

/**
 * A page connected to `matchId` and sitting in the lobby with a seat.
 *
 * This deliberately stops at the lobby. A room does not start until every seat
 * is filled AND every player has said they are ready, so a page that waited
 * here for `window.__game` would wait forever: the second player has not
 * arrived yet, and the scene is not built until the server sends the start
 * signal with the snapshot everyone builds from. What exists at this point is
 * the socket and nothing else.
 */
async function connectPage(browser, base, matchId, tag) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`${base}/?m=${matchId}`, { waitUntil: 'load' });
  // The net client is published the moment the socket is created; the seat
  // arrives with the server's welcome a round trip later.
  await page.waitForFunction(
    () => window.__net && window.__net.state.playerId !== null,
    null,
    { timeout: 30000 },
  );
  return { tag, page, context, errors };
}

/**
 * Say ready, and wait for the match the lobby then starts.
 *
 * Called for every page only once they have all connected — readying the first
 * player before the second has taken their seat is exactly the state the lobby
 * exists to hold, and it would sit in it.
 */
async function readyUp(pages) {
  await Promise.all(pages.map((p) => p.page.evaluate(() => window.__net.setReady(true))));
  await Promise.all(pages.map((p) => p.page.waitForFunction(
    () => window.__game && window.__game.world && window.__game.net,
    null,
    { timeout: 30000 },
  )));
}

const state = (p) => p.page.evaluate(() => ({
  seat: window.__game.seat,
  tick: window.__game.world.tick,
  sum: window.__game.checksum(),
  desyncs: window.__game.net ? window.__game.net.state.desyncs : -1,
  spectator: window.__game.net ? window.__game.net.state.spectator : null,
}));

/** Every villager this page's seat owns, by id. */
const myVillagers = (p) => p.page.evaluate(() => {
  const w = window.__game.world;
  return w.units
    .filter((u) => !u.dead && u.player === window.__game.seat && u.type === 'villager')
    .map((u) => u.id);
});

/** Where those units are right now, as seen by *this* page. */
const positionsOf = (p, ids) => p.page.evaluate(({ list }) => {
  const w = window.__game.world;
  const out = {};
  for (const id of list) {
    const u = w.entities.get(id);
    if (u && !u.dead) out[id] = [Math.round(u.x * 100) / 100, Math.round(u.y * 100) / 100];
  }
  return out;
}, { list: ids });

const order = (p, ids, gx, gy) => p.page.evaluate(({ list, x, y }) => {
  window.__game.command(list, { type: 'move', gx: x, gy: y });
}, { list: ids, x: gx, y: gy });

/** Wait until both pages have simulated past `tick`. */
async function waitForTick(pages, tick, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ticks = await Promise.all(pages.map((p) => p.page.evaluate(() => window.__game.world.tick)));
    if (ticks.every((t) => t >= tick)) return ticks;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for tick ${tick}; reached ${ticks.join(' / ')}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Do the two pages agree?
 *
 * Compared at a tick they have both passed rather than "right now": they are
 * free-running against the server's clock, so sampling both at the same instant
 * samples them at different ticks, and two different ticks of the same match
 * are *supposed* to hash differently. Sampling repeatedly and matching on tick
 * is what makes this a determinism check rather than a race.
 */
async function agreeAt(pages, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [new Map(), new Map()];
  for (;;) {
    const snaps = await Promise.all(pages.map(state));
    snaps.forEach((s, i) => seen[i].set(s.tick, s.sum));
    for (const [tick, sum] of seen[0]) {
      if (seen[1].has(tick)) return { tick, a: sum, b: seen[1].get(tick) };
    }
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function main() {
  // Against a deployment there is no local server to start, and the screenshots
  // are named so the two runs never overwrite each other's evidence.
  const remote = process.argv[2] && /^https?:\/\//.test(process.argv[2])
    ? process.argv[2].replace(/\/$/, '')
    : null;
  const local = remote ? null : await startServer(0);
  const base = remote || `http://127.0.0.1:${local.port}`;
  const server = local ? local.server : { close() {} };
  const prefix = remote ? 'mp-live' : 'mp-local';

  const res = await fetch(`${base}/api/match`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /api/match returned ${res.status}`);
  const { id: matchId } = await res.json();
  console.log(`match ${matchId} on ${base}`);

  // The browser's view of the deployment. Identical to `base` on any machine
  // whose browser can reach the internet; a loopback forwarder otherwise.
  const tunnel = remote ? await reverseProxy(base) : null;
  const browserBase = tunnel ? tunnel.origin : base;
  if (tunnel) console.log(`  info browser reaches ${base} via ${browserBase}`);
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });

  let a = null;
  let b = null;
  try {
    a = await connectPage(browser, browserBase, matchId, 'A');
    b = await connectPage(browser, browserBase, matchId, 'B');
    // Both are in the room before either says go: see readyUp().
    await readyUp([a, b]);

    // --- 1. two seats, not one -----------------------------------------------
    const [sa, sb] = await Promise.all([state(a), state(b)]);
    check(sa.seat === 0 && sb.seat === 1,
      'the two pages were given different seats',
      `A=${sa.seat} B=${sb.seat}`);
    check(!sa.spectator && !sb.spectator, 'neither player was fobbed off as a spectator');

    // --- 2. an order in A moves units in B -----------------------------------
    // The proof of multiplayer is not that A's units move in A. It is that a
    // page which never issued the order sees the result.
    const aUnits = (await myVillagers(a)).slice(0, 3);
    const bUnits = (await myVillagers(b)).slice(0, 3);
    check(aUnits.length > 0 && bUnits.length > 0, 'both seats own villagers to order about');

    const beforeInB = await positionsOf(b, aUnits);
    const beforeInA = await positionsOf(a, bUnits);

    await order(a, aUnits, RALLY.a.gx, RALLY.a.gy);
    await order(b, bUnits, RALLY.b.gx, RALLY.b.gy);

    const startTick = Math.max(sa.tick, sb.tick);
    await waitForTick([a, b], startTick + 80);

    const afterInB = await positionsOf(b, aUnits);
    const afterInA = await positionsOf(a, bUnits);

    const moved = (before, after) => Object.keys(before)
      .filter((id) => after[id] && (before[id][0] !== after[id][0] || before[id][1] !== after[id][1]));

    const aSeenByB = moved(beforeInB, afterInB);
    const bSeenByA = moved(beforeInA, afterInA);
    check(aSeenByB.length > 0,
      "player B sees player A's units move",
      `none of ${Object.keys(beforeInB).length} tracked units moved in B`);
    check(bSeenByA.length > 0,
      "player A sees player B's units move",
      `none of ${Object.keys(beforeInA).length} tracked units moved in A`);

    // --- 3. still in lockstep after a long run -------------------------------
    // Keep both players issuing orders throughout, because a match where
    // nobody does anything is a much weaker determinism test than one where
    // both keep re-tasking units into each other's paths.
    const TARGET = startTick + 3000;
    let round = 0;
    for (;;) {
      const ticks = await Promise.all([a, b].map((p) => p.page.evaluate(() => window.__game.world.tick)));
      if (Math.min(...ticks) >= TARGET) break;
      round++;
      const jitter = (n) => 24 + ((round * 7 + n) % 40);
      await order(a, aUnits, jitter(0), jitter(3));
      await order(b, bUnits, jitter(5), jitter(1));
      await new Promise((r) => setTimeout(r, 900));
      if (round > 400) throw new Error(`stuck at ticks ${ticks.join(' / ')}`);
    }

    const agreed = await agreeAt([a, b]);
    check(agreed !== null, 'the two pages could be sampled at a common tick');
    if (agreed) {
      check(agreed.a === agreed.b,
        `both worlds hash identically at tick ${agreed.tick} (~${TARGET - startTick} ticks of play)`,
        `A=${agreed.a} B=${agreed.b}`);
    }

    const [fa, fb] = await Promise.all([state(a), state(b)]);
    console.log(`  info A tick=${fa.tick} desyncs=${fa.desyncs} | B tick=${fb.tick} desyncs=${fb.desyncs}`);

    // --- 4. screenshots and a clean console ----------------------------------
    await a.page.screenshot({ path: path.join(SHOTS, `${prefix}-player1.png`) });
    await b.page.screenshot({ path: path.join(SHOTS, `${prefix}-player2.png`) });
    console.log(`  shot ${prefix}-player1.png / ${prefix}-player2.png`);

    check(a.errors.length === 0, 'player A logged no errors', a.errors.join('\n       '));
    check(b.errors.length === 0, 'player B logged no errors', b.errors.join('\n       '));
  } finally {
    if (a) await a.context.close().catch(() => {});
    if (b) await b.context.close().catch(() => {});
    await browser.close();
    server.close();
    if (tunnel) tunnel.server.close();
  }

  console.log(process.exitCode ? '\nFAILED' : '\nall good');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
