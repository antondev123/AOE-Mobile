import { boot, step } from './harness.mjs';
const h = await boot();
const { page, errors } = h;
try {
  // Inject two forward-declared buildings the way another pass will, so the
  // locked shelves have something in them.
  await page.evaluate(async () => {
    const C = await import('/src/core/constants.js');
    C.BUILDING_STATS.stonewall = { name:'Stone Wall', hp:900, fw:1, fh:1, cost:{food:0,wood:0,gold:0,stone:5}, buildTime:8, trains:[], lineOfSight:2 };
    C.BUILDING_STATS.watchtower = { name:'Watch Tower', hp:1020, fw:1, fh:1, cost:{food:0,wood:50,gold:0,stone:125}, buildTime:30, trains:[], lineOfSight:8 };
    C.BUILDING_STATS.castle = { name:'Castle', hp:4800, fw:4, fh:4, cost:{food:0,wood:0,gold:0,stone:650}, buildTime:80, trains:[], lineOfSight:10 };
    C.BUILDING_STATS.market = { name:'Market', hp:1800, fw:3, fh:3, cost:{food:0,wood:175,gold:0,stone:0}, buildTime:40, trains:[], lineOfSight:6 };
  });
  const sel = async (type) => {
    await page.evaluate((t) => {
      const w = window.__game.world;
      const e = [...w.players[0].owned].map(i=>w.entities.get(i)).find(x=>x&&x.type===t);
      w.selection.clear(); if (e) w.selection.add(e.id);
      w.events.emit('selection', { ids: e?[e.id]:[] });
    }, type);
    await page.evaluate(() => window.__game.hud.update(0.1));
    await new Promise(r=>setTimeout(r,150));
  };
  await sel('villager');
  await page.evaluate(() => {
    [...document.querySelectorAll('#cmd-panel .cbtn')].find(x=>x.textContent.startsWith('Build'))?.click();
  });
  await new Promise(r=>setTimeout(r,250));
  const bm = await page.evaluate(() => [...document.getElementById('build-menu').children].map(n=>[n.className, n.textContent]));
  console.log('BUILD MENU:'); for (const r of bm) console.log('  ', r[0].padEnd(22), r[1]);
  await page.screenshot({ path: 'screenshots/tech-buildmenu.png' });

  // Town Center: age up
  await page.evaluate(() => { window.__game.world.players[0].resources.food = 5000; window.__game.world.players[0].resources.gold = 2000; window.__game.world.players[0].resources.wood = 2000; });
  await sel('towncenter');
  console.log('TC PANEL:');
  for (const r of await page.evaluate(() => [...document.querySelectorAll('#cmd-panel > *')].map(n=>[n.className, n.textContent, Math.round(n.getBoundingClientRect().height)])))
    console.log('  ', String(r[0]).padEnd(28), String(r[2]).padStart(3), r[1]);
  await page.evaluate(() => [...document.querySelectorAll('.cbtn.research')].find(x=>/Feudal/.test(x.textContent))?.click());
  await page.evaluate(() => window.__game.hud.update(0.1));
  await new Promise(r=>setTimeout(r,200));
  await page.screenshot({ path: 'screenshots/tech-research-progress.png' });
  console.log('IN PROGRESS:', await page.evaluate(() => document.querySelector('.research-queue')?.textContent));
  await step(page, 20*55);
  await page.evaluate(() => window.__game.hud.update(0.1));
  await new Promise(r=>setTimeout(r,250));
  console.log('AGE CHIP:', await page.evaluate(() => document.getElementById('res-age').textContent));
  await page.screenshot({ path: 'screenshots/tech-feudal.png' });

  // build menu again, now in Feudal
  await sel('villager');
  await page.evaluate(() => { [...document.querySelectorAll('#cmd-panel .cbtn')].find(x=>x.textContent.startsWith('Build'))?.click(); });
  await new Promise(r=>setTimeout(r,250));
  console.log('BUILD MENU (feudal):');
  for (const r of await page.evaluate(() => [...document.getElementById('build-menu').children].map(n=>[n.className, n.textContent]))) console.log('  ', r[0].padEnd(22), r[1]);
  await page.screenshot({ path: 'screenshots/tech-buildmenu-feudal.png' });

  // Barracks research
  await page.evaluate(() => {
    const w = window.__game.world;
    const tc = [...w.players[0].owned].map(i=>w.entities.get(i)).find(x=>x&&x.type==='towncenter');
    const b = window.__spawn ? null : null;
  });
  console.log('errors:', errors);
} finally { await h.close(); }
