// Entry point: sizes the canvas for phones, boots Phaser, wires the start card.

import { GameScene } from './scenes/GameScene.js';

const bootStatus = document.getElementById('boot-status');
const startBtn = document.getElementById('btn-start');
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

function launch(seed) {
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
  game.scene.start('game', { seed });
  window.__phaser = game;
  return game;
}

function start() {
  bootCard.hidden = true;
  hud.hidden = false;
  document.body.classList.add('playing');
  launch(Math.floor(Math.random() * 1e9));
}

function boot() {
  if (typeof Phaser === 'undefined') {
    fail('Phaser failed to load');
    return;
  }
  bootStatus.textContent = `Phaser ${Phaser.VERSION} ready`;
  startBtn.hidden = false;

  startBtn.addEventListener('click', start, { once: false });

  const again = document.getElementById('btn-again');
  again.addEventListener('click', () => {
    document.getElementById('endcard').hidden = true;
    launch(Math.floor(Math.random() * 1e9));
  });

  // Let the test harness (and impatient players) skip the start card.
  if (new URLSearchParams(location.search).has('autostart')) start();
  window.__startGame = start;
}

boot();
