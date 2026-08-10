// The client half of lockstep: a socket, a schedule, and a clock to obey.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not receive world state. Ever. The only things that come down the
// wire are (a) which commands fire on which tick, (b) the server's tick, and
// (c) a periodic checksum. Everything a player sees is computed locally by the
// same deterministic simulation the server is running. That is the only way a
// 96x96 RTS fits down a phone's uplink, and it is why src/core/command.js had
// to exist before any of this could.
//
// THE CLOCK
// ---------
// A client must not free-run. Two browsers started a second apart, each
// stepping on its own requestAnimationFrame, drift apart immediately — not in
// simulation (that part is deterministic) but in *when* they are, and a command
// stamped for tick 900 is meaningless to a machine that is at 870.
//
// So the server's tick is the clock. Every `sum` message carries it (once a
// second), and between beacons we extrapolate with wall time. The scene asks
// targetTick() how far it is allowed to simulate and steps until it gets there,
// which turns drift into a step or two of catch-up rather than a divergence.
//
// WHY WE RUN BEHIND
// -----------------
// Not level with the server — LAG_TICKS behind it. A command stamped for
// serverTick + COMMAND_DELAY has to arrive before we simulate that tick, and
// "before" is the whole game: arrive late and the only repair is a resync. The
// lag is the budget for one network hop. It costs input latency and it buys
// every order landing on time, which is the right way round — a quarter second
// of delay is an RTS; a resync every time you tap is not.
//
// DESYNC
// ------
// Math.sin and friends are allowed to disagree in the last bit between engines,
// so eventually two clients will. The server's checksum is the arbiter: compare
// at the tick it names, and if we disagree, ask for a snapshot and rebuild. A
// hiccup, not two players in silently different games.

/** How far behind the server we simulate. Six ticks = 300ms of network budget. */
export const LAG_TICKS = 6;

/** Beyond this the clock is not drifting, it is wrong — rebuild instead. */
const MAX_CATCHUP_TICKS = 60;

/**
 * @param {object} opts
 * @param {string} opts.url                 ws:// or wss:// endpoint
 * @param {(snap: object) => void} opts.onSnapshot  rebuild the world from this
 * @param {(info: object) => void} [opts.onWelcome]
 * @param {(winner: number) => void} [opts.onOver]
 * @param {(reason: string) => void} [opts.onError]
 * @param {(state: string) => void} [opts.onStatus]
 * @param {typeof WebSocket} [opts.WebSocketImpl]  injectable for node tests
 */
export function createNetClient({
  url,
  onSnapshot,
  onWelcome = null,
  onLobby = null,
  onStart = null,
  onOver = null,
  onError = null,
  onStatus = null,
  WebSocketImpl = null,
}) {
  const WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (!WS) throw new Error('no WebSocket implementation available');

  // tick -> commands that fire on it. Absolute server ticks, never relative.
  const schedule = new Map();
  // tick -> checksum the server computed at it.
  const sums = new Map();

  const state = {
    playerId: null,
    spectator: false,
    host: false,
    phase: 'lobby',
    roster: null,
    matchId: null,
    seed: null,
    commandDelay: 4,
    connected: false,
    // False while the room is still in its lobby waiting for both players.
    started: false,
    // Server clock, and the wall time we learned it at.
    serverTick: 0,
    serverAt: 0,
    // Set while a resync is outstanding so we do not ask twice a tick.
    resyncing: false,
    desyncs: 0,
    over: null,
    lastError: null,
  };

  const socket = new WS(url);

  const status = (s) => { if (onStatus) onStatus(s); };

  function stampSchedule(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (!e || typeof e.at !== 'number') continue;
      if (!schedule.has(e.at)) schedule.set(e.at, []);
      schedule.get(e.at).push(e.cmd);
    }
  }

  socket.onopen = () => { state.connected = true; status('connected'); };
  socket.onclose = () => { state.connected = false; status('closed'); };
  socket.onerror = () => { state.connected = false; status('error'); };

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
    catch { return; }

    switch (msg.type) {
      case 'welcome': {
        // `you` replaces the old flat playerId/spectator pair, because a client
        // now also has to know whether it is the host and which phase the room
        // is in — and grouping them stopped the welcome growing a fourth and
        // fifth loose field.
        const you = msg.you || {};
        state.playerId = you.slot === undefined ? null : you.slot;
        state.spectator = !!you.spectator;
        state.host = !!you.host;
        state.phase = msg.phase || 'lobby';
        state.matchId = msg.matchId;
        state.seed = msg.seed;
        if (typeof msg.commandDelay === 'number') state.commandDelay = msg.commandDelay;
        state.serverTick = msg.tick || 0;
        state.serverAt = Date.now();
        state.started = state.phase === 'running' || state.phase === 'over';
        state.roster = msg.roster || null;
        if (onWelcome) onWelcome({ ...msg, snapshot: undefined });
        if (msg.lobby && onLobby) onLobby(msg.lobby);
        // A match already in progress is a reconnect: build the world now. One
        // still in its lobby does not — the world it would build is the one at
        // tick zero, and the authoritative copy of that arrives with the start
        // signal, along with everyone else's copy.
        if (state.started) {
          if (onSnapshot) onSnapshot(msg.snapshot);
          stampSchedule(msg.pending);
          status('playing');
        } else {
          status('lobby');
        }
        break;
      }

      case 'lobby':
        state.phase = msg.phase || state.phase;
        state.started = state.phase === 'running' || state.phase === 'over';
        if (onLobby) onLobby(msg);
        break;

      // Which chair the server put us in, after a claim or a leave. The lobby
      // payload deliberately carries no per-recipient field, so this is the only
      // thing that ever moves `playerId`.
      case 'you':
        state.playerId = msg.slot === undefined ? null : msg.slot;
        state.spectator = !!msg.spectator;
        state.host = !!msg.host;
        if (onLobby) onLobby(null);
        break;

      case 'start': {
        // Everyone is here and everyone said go. This is the first tick of the
        // match proper, and both clients build it from the same bytes.
        state.started = true;
        state.phase = 'running';
        state.roster = msg.roster || null;
        state.serverTick = msg.tick || 0;
        state.serverAt = Date.now();
        schedule.clear();
        sums.clear();
        if (onSnapshot) onSnapshot(msg.snapshot);
        stampSchedule(msg.pending);
        if (onStart) onStart(msg);
        status('playing');
        break;
      }

      // Batched by tick. One message per command amplified badly with eight
      // seats, and everything stamped for a tick is known at the same moment.
      case 'sched':
        if (typeof msg.at === 'number') {
          if (!schedule.has(msg.at)) schedule.set(msg.at, []);
          const list = schedule.get(msg.at);
          for (const c of (msg.cmds || (msg.cmd ? [msg.cmd] : []))) list.push(c);
        }
        break;

      case 'sum':
        state.serverTick = msg.tick;
        state.serverAt = Date.now();
        sums.set(msg.tick, msg.sum);
        break;

      case 'snapshot':
        state.roster = msg.roster || state.roster;
        // The answer to our resync. Rebuild, then re-arm whatever was already
        // stamped past the snapshot's tick.
        schedule.clear();
        sums.clear();
        state.serverTick = msg.tick || state.serverTick;
        state.serverAt = Date.now();
        if (onSnapshot) onSnapshot(msg.snapshot);
        stampSchedule(msg.pending);
        state.resyncing = false;
        status('resynced');
        break;

      case 'over':
        state.over = { winner: msg.winner };
        if (onOver) onOver(msg.winner);
        break;

      case 'error':
        state.lastError = msg.reason;
        if (onError) onError(msg.reason);
        status('error');
        break;

      default:
        break;
    }
  };

  /** Where the server is now, extrapolated from the last beacon. */
  function estimatedServerTick() {
    if (!state.serverAt) return state.serverTick;
    const elapsed = (Date.now() - state.serverAt) / 1000;
    return state.serverTick + Math.floor(elapsed * 20);
  }

  return {
    state,
    get playerId() { return state.playerId; },

    /** Send a command up. The server assigns the seat; `p` here is a hint only. */
    send(cmd) {
      if (socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'cmd', cmd }));
      return true;
    },

    /** The highest tick the local simulation may advance to. */
    targetTick() {
      return Math.max(0, estimatedServerTick() - LAG_TICKS);
    },

    /**
     * The same thing with its fraction kept, for rendering.
     *
     * The simulation only ever lands on whole ticks, but the eye does not: a
     * unit drawn on tick boundaries at 20Hz on a 60Hz screen judders. The
     * renderer interpolates between the last two ticks, and this is the point
     * between them that the clock is actually at.
     */
    targetTickFloat() {
      if (!state.serverAt) return Math.max(0, state.serverTick - LAG_TICKS);
      const elapsed = (Date.now() - state.serverAt) / 1000;
      return Math.max(0, state.serverTick + elapsed * 20 - LAG_TICKS);
    },

    /**
     * Commands due on `tick`, and they are consumed — a tick is simulated once.
     * Returns [] for a tick with nothing on it, which is almost all of them.
     */
    drain(tick) {
      const due = schedule.get(tick);
      if (!due) return [];
      schedule.delete(tick);
      return due;
    },

    /**
     * Did we agree with the server at `tick`? Returns null when the server has
     * not published a digest for it, which is nineteen ticks in twenty.
     */
    verify(tick, localSum) {
      if (!sums.has(tick)) return null;
      const theirs = sums.get(tick);
      sums.delete(tick);
      return theirs === localSum;
    },

    /** Ask the server for a change of lobby. Refusals come back as `error`. */
    lobby(msg) {
      if (socket.readyState !== 1) return false;
      socket.send(JSON.stringify(msg));
      return true;
    },

    /** Tell the server whether this player is ready to begin. */
    setReady(ready = true) {
      if (socket.readyState !== 1) return false;
      socket.send(JSON.stringify({ type: 'ready', ready }));
      return true;
    },

    /** Ask to be rebuilt. Idempotent while one is already in flight. */
    resync(reason = 'desync') {
      if (state.resyncing) return false;
      if (socket.readyState !== 1) return false;
      state.resyncing = true;
      state.desyncs++;
      status(`resyncing: ${reason}`);
      socket.send(JSON.stringify({ type: 'resync' }));
      return true;
    },

    /** True when the local tick is so far adrift that stepping cannot fix it. */
    hopelesslyBehind(localTick) {
      return this.targetTick() - localTick > MAX_CATCHUP_TICKS;
    },

    close() {
      try { socket.close(); } catch { /* already gone */ }
    },
  };
}
