// Shared browser harness: serves the repo statically and drives it in Chromium
// at phone size. Used by the integration smoke test and by the visual review
// pass that produces screenshots.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function serve(port = 0) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    // Never serve outside the repo.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

/**
 * Boot the game in a phone-sized page.
 * Returns { browser, page, errors, close() }. `errors` accumulates console
 * errors and uncaught exceptions — a clean run must leave it empty.
 */
export async function boot({ query = 'autostart', context: ctxOpts = {} } = {}) {
  const { server, port } = await serve();
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const context = await browser.newContext({ ...PHONE, ...ctxOpts });
  const page = await context.newPage();

  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.world, null, { timeout: 20000 });

  return {
    browser,
    page,
    errors,
    async close() {
      await browser.close();
      server.close();
    },
  };
}

/** Advance the simulation by n fixed steps inside the page. */
export async function step(page, n) {
  await page.evaluate((count) => window.__game.step(count), n);
}

/** Pull a JSON snapshot of the simulation state out of the page. */
export async function snapshot(page) {
  return page.evaluate(() => {
    const w = window.__game.world;
    const count = (playerId, kind, type) =>
      [...w.players[playerId].owned]
        .map((id) => w.entities.get(id))
        .filter((e) => e && !e.dead && e.kind === kind && (!type || e.type === type)).length;
    return {
      time: w.time,
      tick: w.tick,
      over: w.over,
      winner: w.winner,
      resources: w.players.map((p) => ({ ...p.resources, pop: p.pop, popCap: p.popCap })),
      units: w.players.map((_, i) => count(i, 'unit')),
      villagers: w.players.map((_, i) => count(i, 'unit', 'villager')),
      // Everything that is not a villager. Naming the military types here meant
      // hardcoding a pair, and the day the roster grew a spearman, a scout and
      // a ram, a seed where the enemy opened with any of them reported an army
      // of zero and the smoke run failed on a game that was working perfectly.
      military: w.players.map((_, i) => count(i, 'unit') - count(i, 'unit', 'villager')),
      buildings: w.players.map((_, i) => count(i, 'building')),
      houses: w.players.map((_, i) => count(i, 'building', 'house')),
      barracks: w.players.map((_, i) => count(i, 'building', 'barracks')),
      nodes: w.resources.length,
      projectiles: w.projectiles.length,
      states: w.units.reduce((acc, u) => {
        acc[u.state] = (acc[u.state] || 0) + 1;
        return acc;
      }, {}),
    };
  });
}

/** Synthesise a touch tap at screen coordinates. */
export async function tap(page, x, y) {
  await page.touchscreen.tap(x, y);
}

/** Synthesise a touch drag (for box-select and panning). */
export async function drag(page, x0, y0, x1, y1, steps = 12) {
  const client = await page.context().newCDPSession(page);
  const send = (type, points) =>
    client.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await send('touchStart', [{ x: x0, y: y0 }]);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await send('touchMove', [{ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t }]);
  }
  await send('touchEnd', []);
  await client.detach();
}
