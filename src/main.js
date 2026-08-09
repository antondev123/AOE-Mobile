// Entry point: sizes the canvas for phones, boots Phaser, wires the start card.

import { GameScene } from './scenes/GameScene.js';
import { saveInfo, clearSave } from './core/save.js';

const bootStatus = document.getElementById('boot-status');
const startBtn = document.getElementById('btn-start');
const resumeBtn = document.getElementById('btn-resume');
const bootCard = document.getElementById('boot');
const hud = document.getElementById('hud');

function fail(msg, err) {
  console.error(msg, err);
  if (bootStatus) {
    bootStatus.textContent = `${msg}${err ? `: ${err.message || err}` : ''}`;
    bootStatus.classList.add('error');
  }
}

window.addEventListener('error', (e) => fail('Startup error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail('Startup error', e.reason));

let game = null;

function launch(seed, resume = null) {
  if (game) {
    game.destroy(true);
    game = null;
  }
  const config = {
    type: Phaser.AUTO,
    parent: 'game-root',
    backgroundColor: '#1a1410',
    // The world is drawn with pixel-art-ish generated textures; keep them crisp.
    pixelArt: false,
    antialias: true,
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
      width: '100%',
      height: '100%',
    },
    // Cap the device pixel ratio: phones with DPR 3 murder fill rate for no
    // visible gain on generated art.
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    input: {
      activePointers: 3, // two-finger pinch plus a spare
      touch: { capture: true },
    },
    fps: { target: 60, forceSetTimeOut: false },
    scene: [GameScene],
  };

  game = new Phaser.Game(config);
  game.scene.start('game', { seed, resume });
  window.__phaser = game;
  return game;
}

function enterGame() {
  bootCard.hidden = true;
  hud.hidden = false;
  document.body.classList.add('playing');
}

function start() {
  // Starting a new skirmish throws the saved one away. It is the one
  // irreversible thing on this card, which is why the button says so.
  clearSave();
  enterGame();
  launch(Math.floor(Math.random() * 1e9));
}

function resume(payload) {
  enterGame();
  launch(payload.seed, payload);
}

/**
 * Offer the saved match, if there is one this build can read.
 *
 * A save from an incompatible version is *reported*, not hidden: a player who
 * left a match ten minutes ago and comes back to a bare "Start Skirmish" would
 * reasonably conclude the game lost their game, and it did — it should say so.
 */
function wireResume() {
  if (!resumeBtn) return;
  let info = null;
  try {
    info = saveInfo();
  } catch (err) {
    console.warn('[save] could not read the stored match:', err);
    info = null;
  }
  if (!info) return;
  if (info.error) {
    bootStatus.textContent = info.error;
    bootStatus.classList.add('error');
    clearSave();
    return;
  }
  resumeBtn.textContent = '';
  resumeBtn.appendChild(document.createTextNode('Resume match'));
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = `${info.label} in`;
  resumeBtn.appendChild(sub);
  resumeBtn.setAttribute('aria-label', `Resume the saved match, ${info.label} in.`);
  resumeBtn.hidden = false;
  resumeBtn.addEventListener('click', () => resume(info.data));

  // With something to come back to, a new game is the quieter of the two.
  startBtn.classList.add('secondary');
  startBtn.textContent = '';
  startBtn.appendChild(document.createTextNode('New skirmish'));
  const s2 = document.createElement('span');
  s2.className = 'sub';
  s2.textContent = 'discards the saved match';
  startBtn.appendChild(s2);
  startBtn.setAttribute('aria-label', 'Start a new skirmish. This discards the saved match.');
}

function boot() {
  if (typeof Phaser === 'undefined') {
    fail('Phaser failed to load');
    return;
  }
  bootStatus.textContent = `Phaser ${Phaser.VERSION} ready`;
  startBtn.hidden = false;
  wireResume();

  startBtn.addEventListener('click', start, { once: false });

  const again = document.getElementById('btn-again');
  again.addEventListener('click', () => {
    document.getElementById('endcard').hidden = true;
    clearSave();
    launch(Math.floor(Math.random() * 1e9));
  });

  // Let the test harness (and impatient players) skip the start card. `?resume`
  // takes the saved match instead, which is how tests/save.browser.mjs drives
  // the round trip through the real page.
  const params = new URLSearchParams(location.search);
  if (params.has('resume')) {
    const info = saveInfo();
    if (info && !info.error) resume(info.data);
    else start();
  } else if (params.has('autostart')) {
    start();
  }
  window.__startGame = start;
  window.__resumeGame = () => {
    const info = saveInfo();
    if (!info || info.error) return false;
    resume(info.data);
    return true;
  };
}

boot();
