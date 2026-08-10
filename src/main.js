// Entry point: sizes the canvas for phones, boots Phaser, wires the start card.

import { GameScene } from './scenes/GameScene.js';
import { saveInfo, clearSave } from './core/save.js';
import { createNetClient } from './net/client.js';
import { createLobby, clientToken } from './ui/lobby.js';

const bootStatus = document.getElementById('boot-status');
const startBtn = document.getElementById('btn-start');
const resumeBtn = document.getElementById('btn-resume');
const friendBtn = document.getElementById('btn-friend');
const skirmishBtn = document.getElementById('btn-skirmish');
const invite = document.getElementById('invite');
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
let net = null;

function launch(seed, resume = null, netClient = null, roster = null, world = null) {
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
  game.scene.start('game', { seed, resume, net: netClient, roster, world });
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

// --- multiplayer -------------------------------------------------------------
//
// The invite link is the whole feature. Everything below exists to turn a tap
// on "Play a friend" into a URL somebody can be sent, and a visit to that URL
// into a seat at the same match — with no lobby, no account and no second
// hostname, because the socket and the page come off the same origin.

/** ws:// for http, wss:// for https, same host either way. */
function socketUrl(matchId) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // The token rides in the query string rather than behind a handshake, so
  // `welcome` stays the first message and the server can seat a reconnecting
  // player before it has said anything. See clientToken in ui/lobby.js.
  const t = encodeURIComponent(clientToken());
  return `${proto}//${location.host}/ws?m=${encodeURIComponent(matchId)}&t=${t}`;
}

function inviteLink(matchId) {
  return `${location.origin}${location.pathname}?m=${encodeURIComponent(matchId)}`;
}

/**
 * Join `matchId`, and stay joined.
 *
 * The scene is not started until the server has said hello, because a client
 * cannot build the world itself: it has to be the one in the snapshot, at the
 * tick the snapshot was taken. A later snapshot (the answer to a resync)
 * restarts the scene onto the rebuilt world, which is heavy-handed and rare —
 * it happens when the two simulations have already disagreed, so a visible
 * hitch is the honest outcome.
 */
function joinMatch(matchId, { onFail = null } = {}) {
  let started = false;

  const client = createNetClient({
    url: socketUrl(matchId),
    onSnapshot: (snap) => {
      // Only ever called once the match is actually running — the lobby holds
      // the world back until both players have said go. See net/client.js.
      if (!snap || !snap.state) return;
      // The roster travels with the snapshot and MUST be handed on. It says
      // which seats are AI, and the scene runs one brain per 'ai' seat: a client
      // left to guess would run brains the server is not running, and two
      // clients would each guess differently. That is a desync per think.
      if (!started) {
        started = true;
        enterGame();
        launch(snap.state.seed, snap.state, client, snap.roster);
      } else {
        // Rebuild in place. The scene reads `net` and `resume` out of its init
        // data, so restarting it with the new payload is a full, correct reset
        // of every system that holds a reference to the old world.
        const scene = game && game.scene.getScene('game');
        if (scene) {
          scene.scene.restart({
            seed: snap.state.seed, resume: snap.state, net: client, roster: snap.roster,
          });
        }
      }
    },
    onWelcome: (info) => {
      const you = info.you || {};
      mySeat = you.slot === undefined ? null : you.slot;
      lobby().setSeat(mySeat, you.host);
      if (you.spectator) lobby().setNotice('This match is full — you are watching.');
    },
    onLobby: (msg) => {
      lobby().setSeat(client.state.playerId, client.state.host);
      lobby().onLobby(msg);
    },
    onSeats: null,
    onError: (reason) => {
      const msg = reason === 'no-such-match'
        ? 'That match has finished or expired. Start a new one.'
        : `Connection problem: ${reason}`;
      lobby().setNotice(msg);
      if (onFail) onFail(reason);
    },
  });

  net = client;
  window.__net = client;
  return client;
}

// Which seat the server gave us, so the lobby can say "you" rather than making
// somebody count chairs.
let mySeat = null;

// The lobby screen, built on demand. It owns eight chairs, their teams and the
// Start button; see ui/lobby.js. Everything it draws comes from the server's
// `lobby` broadcast, so eight phones show the same room.
let lobbyView = null;
function lobby() {
  if (!lobbyView) {
    lobbyView = createLobby({
      root: document.getElementById('lobby-root'),
      net,
      onLaunch: (cfg) => startOffline(cfg),
    });
  }
  return lobbyView;
}

/** Open the lobby card, hiding the buttons that led here. */
function showLobby() {
  if (invite) invite.hidden = false;
  if (startBtn) startBtn.hidden = true;
  if (resumeBtn) resumeBtn.hidden = true;
  if (friendBtn) friendBtn.hidden = true;
  if (skirmishBtn) skirmishBtn.hidden = true;
  lobby();
}

/** An offline match, built from the lobby's own roster. */
function startOffline(cfg) {
  clearSave();
  enterGame();
  launch(cfg.seed, null, null, cfg.roster, { width: cfg.width, height: cfg.height });
}

/** "Play a friend": ask the server for a room, show the link, take a seat. */
async function playAFriend() {
  if (friendBtn) friendBtn.disabled = true;
  showLobby();
  lobby().setNotice('Creating a match…');
  try {
    const res = await fetch('/api/match', { method: 'POST' });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { id } = await res.json();
    // The link goes up before the socket does, so it can be sent while this
    // player is still connecting.
    showLobby();
    lobby().setInvite(inviteLink(id));
    history.replaceState(null, '', inviteLink(id));
    joinMatch(id);
  } catch (err) {
    if (friendBtn) friendBtn.disabled = false;
    lobby().setNotice(
      `Could not start a match: ${err.message}. This build needs the match server `
      + '(npm run server) — a static host cannot do multiplayer.');
  }
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
  // The first line a player ever reads in this game used to be "Phaser 3.90.0
  // ready", which is a diagnostic for the person who wrote it and noise for
  // everybody else — a card that opens with the name of a middleware version is
  // a card that has not decided it is a game yet. The engine version is still
  // one line down, in the build footer, where a bug report can find it.
  bootStatus.textContent = 'Two settlements, one valley.';
  const engine = document.getElementById('engine');
  if (engine) engine.textContent = `Phaser ${Phaser.VERSION}`;
  startBtn.hidden = false;
  wireResume();

  startBtn.addEventListener('click', start, { once: false });
  if (friendBtn) {
    friendBtn.hidden = false;
    friendBtn.addEventListener('click', playAFriend);
  }

  // The same lobby, offline. "Start Skirmish" is still one tap to the classic
  // 1v1; this is the door to everything the roster can now be — eight seats, two
  // teams, seven computers — without a server in the way.
  if (skirmishBtn) {
    skirmishBtn.hidden = false;
    skirmishBtn.addEventListener('click', () => {
      showLobby();
      lobby().setNotice('');
    });
  }

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

  // An invite. This is the whole point of the feature: the link *is* the lobby,
  // so opening it takes the free seat and starts playing. It outranks every
  // other boot path, including a saved skirmish — somebody who followed a link
  // to a friend's match did not come here to resume their own.
  if (params.has('m')) {
    const matchId = params.get('m');
    showLobby();
    lobby().setInvite(inviteLink(matchId));
    lobby().setNotice('Joining…');
    joinMatch(matchId);
    return;
  }

  if (params.has('resume')) {
    const info = saveInfo();
    if (info && !info.error) resume(info.data);
    else start();
  } else if (params.has('autostart')) {
    start();
  }
  window.__startGame = start;
  // For tests/multiplayer.browser.mjs, which drives two contexts through the
  // real page rather than through a mock.
  window.__playAFriend = playAFriend;
  window.__joinMatch = joinMatch;
  window.__resumeGame = () => {
    const info = saveInfo();
    if (!info || info.error) return false;
    resume(info.data);
    return true;
  };
}

boot();
