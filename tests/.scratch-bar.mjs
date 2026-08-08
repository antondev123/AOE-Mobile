import { boot } from './harness.mjs';
const h = await boot();
const { page } = h;
try {
  const r = await page.evaluate(async () => {
    const T = await import('/src/systems/tech.js');
    const w = window.__game.world;
    w.players[0].resources = { food: 9999, wood: 9999, gold: 9999, stone: 999 };
    w.players[0].pop = 48; w.players[0].popCap = 50;
    const out = [];
    for (const age of [0,1,2]) {
      w._tech[0].age = age;
      window.__game.hud.update(0.1);
      const bar = document.getElementById('res-bar');
      const top = document.querySelector('.hud-top');
      const menu = document.getElementById('btn-menu');
      out.push({ age, barW: Math.round(bar.getBoundingClientRect().width),
        scrollW: bar.scrollWidth, clientW: bar.clientWidth,
        topW: Math.round(top.getBoundingClientRect().width),
        menuLeft: Math.round(menu.getBoundingClientRect().left),
        barRight: Math.round(bar.getBoundingClientRect().right),
        ageText: document.getElementById('res-age').textContent });
    }
    return out;
  });
  console.log(JSON.stringify(r, null, 1));
  await page.screenshot({ path: 'screenshots/tech-resbar.png', clip: { x:0, y:0, width: 390, height: 90 } });
} finally { await h.close(); }
