// The lobby, driven the way a player drives it.
//
// Everything else about eight players is asserted headlessly — the roster model
// in room.test.mjs, the map in teams.test.mjs, the lockstep in
// aideterminism.test.mjs. None of that proves the thing actually asked for,
// which is that somebody can open the page, set up an eight-player match with
// two teams, press Start, and be playing it. That needs the real page: the real
// buttons, the real atlas bake at eight colours, the real 192x192 world.
//
// Run directly (node tests/lobby.browser.mjs), not under node --test.

import { chromium } from 'playwright-core';
import { serve, CHROMIUM, PHONE } from './harness.mjs';

const { server, port } = await serve();
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
});
const ctx = await browser.newContext(PHONE);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
const close = async () => { await browser.close(); server.close(); };
await page.waitForFunction(() => {
  const b = document.getElementById('btn-skirmish');
  return b && !b.hidden;
});

function ok(label, detail) { console.log(`  ok   ${label}${detail ? `  (${detail})` : ''}`); }
function fail(label, detail) {
  console.log(`  FAIL ${label}${detail ? `  (${detail})` : ''}`);
  process.exitCode = 1;
}
const check = (cond, label, detail) => (cond ? ok(label, detail) : fail(label, detail));

const out = await page.evaluate(async () => {
  document.getElementById('btn-skirmish').click();
  const root = document.getElementById('lobby-root');
  const plus = [...root.querySelectorAll('.seg')].find((b) => b.textContent === '+');
  for (let i = 0; i < 6; i++) plus.click();

  // Two teams: first four vs last four.
  const rows = () => [...root.querySelectorAll('.lobby-row')];
  const teamBtn = (i) => rows()[i].querySelector('.lobby-team');
  const want = [1, 1, 1, 1, 2, 2, 2, 2];
  for (let i = 0; i < 8; i++) {
    for (let guard = 0; guard < 12; guard++) {
      const cur = Number(teamBtn(i).textContent.replace(/\D/g, ''));
      if (cur === want[i]) break;
      teamBtn(i).click();
    }
  }
  const seats = rows().length;
  const teams = rows().map((r) => Number(r.querySelector('.lobby-team').textContent.replace(/\D/g, '')));
  const mapText = root.querySelector('.lobby-map').textContent;
  const start = root.querySelector('.lobby-start');
  const startLabel = start.textContent;
  start.click();
  return { seats, teams, mapText, startLabel };
});

check(out.seats === 8, 'the lobby grows to eight chairs', `${out.seats} rows`);
check(out.teams.join(',') === '1,1,1,1,2,2,2,2', 'and each can be put on a side', out.teams.join(','));
check(out.mapText === '192×192', 'the map grows with the roster', out.mapText);
check(out.startLabel === 'Start match', 'and Start says it can begin', out.startLabel);

await page.waitForFunction(() => window.__game && window.__game.world, null, { timeout: 30000 });
const world = await page.evaluate(() => {
  const w = window.__game.world;
  return {
    players: w.players.length,
    teams: w.players.map((p) => p.team),
    size: `${w.width}x${w.height}`,
    towncenters: w.buildings.filter((b) => b.type === 'towncenter').length,
    villagers: w.units.filter((u) => u.type === 'villager').length,
    ais: (window.__game.scene.ais || []).filter(Boolean).length,
  };
});
check(world.players === 8, 'the match has eight players', `${world.players}`);
check(world.teams.join(',') === '1,1,1,1,2,2,2,2', 'on the two sides the lobby chose', world.teams.join(','));
check(world.size === '192x192', 'on the map the lobby showed', world.size);
check(world.towncenters === 8, 'everybody got a town centre', `${world.towncenters}`);
check(world.villagers === 24, 'and three villagers each', `${world.villagers}`);
check(world.ais === 7, 'seven chairs are played by computers', `${world.ais}`);

await page.evaluate(() => window.__game.step(400));
const after = await page.evaluate(() => {
  const w = window.__game.world;
  return {
    tick: w.tick,
    buildings: w.buildings.length,
    units: w.units.length,
    over: w.over,
    food: w.players.map((p) => Math.round(p.resources.food)),
  };
});
check(after.tick > 300, 'the match actually runs', `tick ${after.tick}`);
check(!after.over, 'and does not decide itself in the first twenty seconds');
check(after.buildings > 8, 'somebody built something', `${after.buildings} buildings`);
check(after.food.every((f) => f > 100), 'every economy is running', after.food.join('/'));
check(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));

console.log(process.exitCode ? '\neight-player lobby FAILED' : '\neight players, two teams, one map');
await close();
