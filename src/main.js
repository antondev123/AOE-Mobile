// Entry point: sizes the canvas for phones, boots Phaser, wires the start card.

import { GameScene } from './scenes/GameScene.js';
import { saveInfo, clearSave } from './core/save.js';
import { createNetClient } from './net/client.js';

const bootStatus = document.getElementById('boot-status');
const startBtn = document.getElementById('btn-start');
const resumeBtn = document.getElementById('btn-resume');
const friendBtn = document.getElementById('btn-friend');
const invite = document.getElementById('invite');
const inviteUrl = document.getElementById('invite-url');
const inviteCopy = document.getElementById('invite-copy');
const inviteState = document.getElementById('invite-state');
const lobbyList = document.getElementById('lobby-list');
const readyBtn = document.getElementById('btn-ready');
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

function launch(seed, resume = null, netClient = null, roster = null) {
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
  game.scene.start('game', { seed, resume, net: netClient, roster });
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
  return `${proto}//${location.host}/ws?m=${encodeURIComponent(matchId)}`;
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
      mySeat = info.playerId;
      if (info.spectator) setInviteState('Match is full — watching');
    },
    onLobby: (msg) => renderLobby(msg.seats, client),
    onSeats: null,
    onError: (reason) => {
      const msg = reason === 'no-such-match'
        ? 'That match has finished or expired. Start a new one.'
        : `Connection problem: ${reason}`;
      setInviteState(msg, true);
      if (onFail) onFail(reason);
    },
  });

  net = client;
  window.__net = client;
  return client;
}

function setInviteState(text, isError = false) {
  if (!inviteState) return;
  inviteState.textContent = text;
  inviteState.classList.toggle('error', !!isError);
}

// Which seat the server gave us, so the lobby can say "you" rather than making
// somebody count chairs.
let mySeat = null;

/**
 * Draw the lobby: who is here, who has readied, and the button to ready up.
 *
 * The whole point is that this screen *waits*. The previous version connected
 * and launched in the same breath, so the invite link existed for about one
 * frame — long enough to see, nowhere near long enough to send to anybody.
 */
function renderLobby(seats, client) {
  if (!lobbyList) return;
  lobbyList.textContent = '';
  for (const s of seats) {
    const row = document.createElement('li');
    row.className = `lobby-row${s.ready ? ' is-ready' : ''}`;
    const who = document.createElement('span');
    who.textContent = `Player ${s.seat + 1}${s.seat === mySeat ? ' (you)' : ''}`;
    const status = document.createElement('span');
    status.className = 'lobby-status';
    status.textContent = !s.filled ? 'not here yet' : s.ready ? 'ready' : 'not ready';
    row.append(who, status);
    lobbyList.appendChild(row);
  }

  const everyone = seats.every((s) => s.filled);
  const me = seats.find((s) => s.seat === mySeat);
  if (readyBtn) {
    readyBtn.hidden = mySeat === null;
    readyBtn.disabled = false;
    readyBtn.classList.toggle('is-on', !!(me && me.ready));
    readyBtn.textContent = me && me.ready ? "Ready — tap to cancel" : "I'm ready";
    readyBtn.onclick = () => {
      const next = !(me && me.ready);
      client.setReady(next);
      // Optimistic, because the round trip is short and a button that does
      // nothing for 80ms feels broken. The server's lobby message redraws it.
      readyBtn.classList.toggle('is-on', next);
      readyBtn.textContent = next ? 'Ready — tap to cancel' : "I'm ready";
    };
  }

  if (!everyone) setInviteState('Waiting for your friend to open the link…');
  else if (!seats.every((s) => s.ready)) setInviteState('Both here. Ready up to begin.');
  else setInviteState('Starting…');
  if (invite) invite.classList.toggle('ready', everyone);
}

function showInvite(matchId) {
  if (!invite) return;
  const url = inviteLink(matchId);
  invite.hidden = false;
  if (inviteUrl) {
    inviteUrl.textContent = url;
    inviteUrl.href = url;
  }
  if (startBtn) startBtn.hidden = true;
  if (resumeBtn) resumeBtn.hidden = true;
  if (friendBtn) friendBtn.hidden = true;
  if (inviteCopy) {
    inviteCopy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(url);
        inviteCopy.textContent = 'Copied';
      } catch {
        // Clipboard is gated on a permission a phone may refuse. The link is on
        // screen and selectable, so this is a downgrade, not a failure.
        inviteCopy.textContent = 'Copy failed — select it';
      }
    };
  }
}

/** "Play a friend": ask the server for a room, show the link, take a seat. */
async function playAFriend() {
  if (friendBtn) friendBtn.disabled = true;
  setInviteState('Creating a match…');
  if (invite) invite.hidden = false;
  try {
    const res = await fetch('/api/match', { method: 'POST' });
    if (!res.ok) throw new Error(`server said ${res.status}`);
    const { id } = await res.json();
    // The link goes up before the socket does, so it can be sent while this
    // player is still connecting.
    showInvite(id);
    history.replaceState(null, '', inviteLink(id));
    joinMatch(id);
  } catch (err) {
    if (friendBtn) friendBtn.disabled = false;
    setInviteState(
      `Could not start a match: ${err.message}. This build needs the match server ` +
      '(npm run server) — a static host cannot do multiplayer.', true);
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
    showInvite(matchId);
    setInviteState('Joining…');
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
