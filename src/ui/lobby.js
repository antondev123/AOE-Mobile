// The lobby screen: eight chairs, who is in them, and whose side they are on.
//
// This lived inline in main.js as two functions that drew two rows, which was
// the right size for a 1v1 and is not the right size for a roster. It follows
// the module contract the rest of the game uses — createLobby(...) -> { update,
// destroy } — and it draws whatever the server says, never what it hopes: every
// control sends a message and waits for the `lobby` broadcast to come back. That
// is what keeps eight screens showing the same room, and it means the rules only
// exist once, in server/room.js.
//
// It also drives an OFFLINE skirmish, with `net` null. The same chairs, the same
// teams, the same Start button; the difference is that pressing it builds the
// world here instead of asking a server to. One lobby to maintain rather than
// two, and eight-player local games for almost no extra code.

import { PLAYER_COLORS, MAX_PLAYERS, mapSizeFor } from '../core/constants.js';

const KIND_LABEL = { open: 'Open', human: 'Human', ai: 'Computer', closed: 'Closed' };
// What the host may cycle a chair through. 'human' is absent on purpose: it is a
// consequence of somebody sitting down, never something the host does to you.
const KIND_CYCLE = ['open', 'ai', 'closed'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

/**
 * A stable id for this browser, so a dropped connection comes back to its own
 * chair rather than to whichever one happens to be lowest.
 *
 * In localStorage rather than in memory because the case that matters is the tab
 * being killed — a phone browser reclaiming a backgrounded page is exactly when
 * you most want your town back.
 */
export function clientToken() {
  const KEY = 'aos.client.token';
  try {
    let t = localStorage.getItem(KEY);
    if (!t) {
      t = `c${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      localStorage.setItem(KEY, t);
    }
    return t;
  } catch {
    // Private mode. A token that lasts as long as the page is still better than
    // none: it survives a reconnect, just not a reload.
    return `c${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root      where to draw
 * @param {object|null} opts.net       a net client, or null for offline
 * @param {(cfg: object) => void} opts.onLaunch  offline only: start this match
 */
export function createLobby({ root, net = null, onLaunch = null } = {}) {
  // The offline lobby keeps its own copy of what the server would own. It is the
  // same shape as the server's `lobby` payload so that everything below can read
  // one thing and not care which mode it is in.
  const local = {
    phase: 'lobby',
    hostSlot: 0,
    seed: Math.floor(Math.random() * 1e9),
    mapSize: { width: mapSizeFor(2), height: mapSizeFor(2), auto: true },
    slots: [
      { index: 0, kind: 'human', team: 1, filled: true, ready: true, name: 'You' },
      { index: 1, kind: 'ai', team: 2, filled: false, ready: true, name: '' },
    ],
    canStart: true,
    blockedBy: null,
  };

  let view = net ? null : local;
  let mySlot = net ? null : 0;
  let amHost = net ? false : true;
  let inviteUrl = '';
  let notice = '';

  const dom = {};

  function build() {
    root.textContent = '';
    dom.invite = el('div', 'lobby-invite');
    dom.link = el('a', 'invite-url');
    dom.link.href = '#';
    dom.copy = el('button', 'invite-copy', 'Copy link');
    dom.copy.setAttribute('aria-label', 'Copy the invite link to share.');
    dom.invite.append(el('p', 'invite-label', 'Send this link to a friend'), dom.link, dom.copy);
    if (!net) dom.invite.hidden = true;
    root.appendChild(dom.invite);

    dom.setup = el('div', 'lobby-setup');
    dom.setup.setAttribute('role', 'group');
    dom.setup.setAttribute('aria-label', 'Match setup');
    root.appendChild(dom.setup);

    dom.list = el('ul', 'lobby-list');
    root.appendChild(dom.list);

    dom.note = el('p', 'invite-state');
    root.appendChild(dom.note);

    dom.ready = el('button', 'invite-copy ready-btn');
    dom.ready.hidden = !net;
    root.appendChild(dom.ready);

    dom.start = el('button', 'start-btn lobby-start');
    root.appendChild(dom.start);
  }

  // --- talking to whoever owns the truth --------------------------------------

  function ask(msg) {
    if (net) { net.lobby(msg); return; }
    applyLocally(msg);
  }

  /**
   * The offline half of every verb.
   *
   * Deliberately not a second copy of server/room.js's rules: an offline lobby
   * has one human who is also the host, so "may they" is always yes. What it
   * must reproduce exactly is the *shape* — the same messages in, the same
   * payload out — or the two modes would drift and only one would be tested.
   */
  function applyLocally(msg) {
    const slots = local.slots;
    if (msg.type === 'setSlotCount') {
      const n = Math.max(2, Math.min(MAX_PLAYERS, msg.n));
      while (slots.length > n) slots.pop();
      while (slots.length < n) {
        slots.push({
          index: slots.length, kind: 'ai', team: slots.length + 1,
          filled: false, ready: true, name: '',
        });
      }
    } else if (msg.type === 'setSlot') {
      const s = slots[msg.index];
      if (s) {
        if (msg.kind !== undefined && s.kind !== 'human') s.kind = msg.kind;
        if (msg.team !== undefined) s.team = msg.team;
      }
    } else if (msg.type === 'setMap') {
      local.mapSize = msg.size === 'auto'
        ? { width: mapSizeFor(slots.length), height: mapSizeFor(slots.length), auto: true }
        : { width: msg.size, height: msg.size, auto: false };
    }
    if (local.mapSize.auto) {
      local.mapSize = { width: mapSizeFor(slots.length), height: mapSizeFor(slots.length), auto: true };
    }
    const live = slots.filter((s) => s.kind !== 'closed');
    const teams = new Set(live.map((s) => s.team));
    local.canStart = live.length >= 2 && teams.size >= 2 && live.some((s) => s.kind === 'human');
    local.blockedBy = local.canStart ? null : (teams.size < 2 ? 'one-team' : 'need-two-players');
    render();
  }

  // --- drawing ----------------------------------------------------------------

  const REASON = {
    'open-slots': 'Waiting for players — or fill the empty chairs.',
    'need-two-players': 'A match needs at least two players.',
    'need-one-human': 'Somebody has to play.',
    'one-team': 'Everyone is on the same side — nobody could win.',
    'slot-occupied': 'Somebody is sitting there.',
    'not-host': 'Only the host can change the match.',
    'already-started': 'The match has already begun.',
  };

  function reasonText(code) {
    if (!code) return '';
    const notReady = /^slot-(\d+)-not-ready$/.exec(code);
    if (notReady) return `Waiting for Player ${Number(notReady[1]) + 1}.`;
    return REASON[code] || code;
  }

  function render() {
    if (!view) return;
    const slots = view.slots || [];

    // The setup row: how many chairs, and how big a map that makes.
    dom.setup.textContent = '';
    if (amHost && view.phase === 'lobby') {
      const minus = el('button', 'seg', '−');
      minus.setAttribute('aria-label', 'One fewer player');
      minus.onclick = () => ask({ type: 'setSlotCount', n: slots.length - 1 });
      const plus = el('button', 'seg', '+');
      plus.setAttribute('aria-label', 'One more player');
      plus.onclick = () => ask({ type: 'setSlotCount', n: slots.length + 1 });
      minus.disabled = slots.length <= 2;
      plus.disabled = slots.length >= MAX_PLAYERS;
      dom.setup.append(
        el('span', 'lobby-label', `${slots.length} players`),
        minus, plus,
        el('span', 'lobby-map', `${view.mapSize.width}×${view.mapSize.height}`),
      );
    } else {
      dom.setup.append(
        el('span', 'lobby-label', `${slots.length} players`),
        el('span', 'lobby-map', `${view.mapSize.width}×${view.mapSize.height}`),
      );
    }

    dom.list.textContent = '';
    for (const s of slots) {
      const row = el('li', `lobby-row${s.ready && s.kind !== 'open' ? ' is-ready' : ''}`);

      const swatch = el('i', 'lobby-swatch');
      swatch.style.background = hex(PLAYER_COLORS[s.index % PLAYER_COLORS.length]);
      row.appendChild(swatch);

      const who = el('span', 'lobby-who');
      const mine = s.index === mySlot;
      who.textContent = s.name || `Player ${s.index + 1}`;
      if (mine) who.appendChild(el('b', 'lobby-you', ' (you)'));
      row.appendChild(who);

      // Kind. The host cycles an empty chair; everyone else reads it.
      const kind = el('button', 'lobby-kind', KIND_LABEL[s.kind]);
      const settable = amHost && view.phase === 'lobby' && s.kind !== 'human';
      kind.disabled = !settable;
      kind.setAttribute('aria-label', `Player ${s.index + 1} is ${KIND_LABEL[s.kind]}`
        + (settable ? '. Tap to change.' : '.'));
      if (settable) {
        kind.onclick = () => {
          const next = KIND_CYCLE[(KIND_CYCLE.indexOf(s.kind) + 1) % KIND_CYCLE.length];
          ask({ type: 'setSlot', index: s.index, kind: next });
        };
      }
      row.appendChild(kind);

      // Team. Cycles 1..slots.length, which is every arrangement including the
      // free-for-all where everybody has their own number.
      const team = el('button', 'lobby-team', `Team ${s.team}`);
      const teamSettable = amHost && view.phase === 'lobby' && s.kind !== 'closed';
      team.disabled = !teamSettable;
      team.setAttribute('aria-label', `Player ${s.index + 1} is on team ${s.team}`
        + (teamSettable ? '. Tap to change.' : '.'));
      if (teamSettable) {
        team.onclick = () => ask({
          type: 'setSlot', index: s.index, team: (s.team % slots.length) + 1,
        });
      }
      row.appendChild(team);

      // Sitting down. Only over a network, and only in a chair nobody holds.
      if (net && view.phase === 'lobby' && s.kind === 'open') {
        const sit = el('button', 'lobby-sit', 'Sit here');
        sit.setAttribute('aria-label', `Take player ${s.index + 1}'s chair.`);
        sit.onclick = () => net.lobby({ type: 'claim', slot: s.index });
        row.appendChild(sit);
      } else {
        const status = el('span', 'lobby-status',
          s.kind === 'open' ? 'empty'
            : s.kind === 'closed' ? '—'
              : s.kind === 'ai' ? 'ready'
                : s.ready ? 'ready' : 'not ready');
        row.appendChild(status);
      }

      dom.list.appendChild(row);
    }

    // Ready, for a seated human over a network.
    if (net) {
      const me = slots.find((s) => s.index === mySlot);
      dom.ready.hidden = !me || me.kind !== 'human' || view.phase !== 'lobby';
      if (!dom.ready.hidden) {
        dom.ready.classList.toggle('is-on', !!me.ready);
        dom.ready.textContent = me.ready ? 'Ready — tap to cancel' : "I'm ready";
        dom.ready.setAttribute('aria-pressed', me.ready ? 'true' : 'false');
        dom.ready.onclick = () => net.setReady(!me.ready);
      }
    }

    // Start, for the host.
    dom.start.hidden = !amHost || view.phase !== 'lobby';
    if (!dom.start.hidden) {
      const open = slots.some((s) => s.kind === 'open');
      dom.start.textContent = open ? 'Start — fill empty chairs with computers' : 'Start match';
      dom.start.disabled = !view.canStart && !open;
      dom.start.onclick = () => {
        if (net) net.lobby({ type: 'start', fillOpen: open ? 'ai' : undefined });
        else if (onLaunch) onLaunch(toConfig());
      };
    }

    const blocked = reasonText(view.blockedBy);
    dom.note.textContent = notice || blocked;
    dom.note.classList.toggle('error', !!notice);
  }

  /** What an offline Start hands back: everything a world needs. */
  function toConfig() {
    return {
      seed: local.seed,
      width: local.mapSize.width,
      height: local.mapSize.height,
      roster: local.slots.map((s) => ({
        kind: s.kind === 'open' ? 'ai' : s.kind,
        team: s.team,
      })),
      seat: 0,
    };
  }

  build();
  render();

  return {
    /** The server said something about the room. Null means "just redraw". */
    onLobby(payload) {
      if (payload) view = payload;
      render();
    },
    setSeat(slot, host) {
      mySlot = slot;
      amHost = !!host;
      render();
    },
    setInvite(url) {
      inviteUrl = url;
      if (!dom.invite) return;
      dom.invite.hidden = false;
      dom.link.textContent = url;
      dom.link.href = url;
      dom.copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(inviteUrl);
          dom.copy.textContent = 'Copied';
        } catch {
          // Clipboard is behind a permission a phone may refuse. The link is on
          // screen and selectable, so this is a downgrade rather than a failure.
          dom.copy.textContent = 'Copy failed — select it';
        }
      };
    },
    /** A refusal, or anything else worth saying above the button. */
    setNotice(text) {
      notice = text || '';
      render();
    },
    destroy() {
      root.textContent = '';
    },
  };
}
