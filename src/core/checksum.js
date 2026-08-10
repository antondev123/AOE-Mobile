// A cheap order-sensitive digest of everything the simulation owns.
//
// This lives in core rather than in the server because both ends need it and
// they must agree to the bit: the server publishes a digest, the client
// computes one over its own world, and a mismatch is what triggers a rebuild.
// Two implementations of "the same" hash is exactly the bug this file exists to
// catch, so there is only one.
//
// Positions are quantised to 1/1024 of a tile rather than hashed as raw floats.
// A last-bit disagreement between two JS engines is not yet a divergence — it
// either washes out or it grows, and only the growing kind matters. Quantising
// ignores the noise and still catches drift long before a player could see it.

export function checksum(world) {
  let h = 0x811c9dc5; // FNV-1a offset basis
  const mix = (n) => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const q = (f) => Math.round(f * 1024);

  mix(world.tick);
  mix(world.rng.getState());
  mix(world.nextId);
  for (const p of world.players) {
    mix(p.id);
    mix(p.defeated ? 1 : 0);
    for (const k of ['food', 'wood', 'gold', 'stone']) mix(q(p.resources?.[k] ?? 0));
  }
  for (const u of world.units) {
    mix(u.id); mix(q(u.x)); mix(q(u.y)); mix(q(u.hp)); mix(u.player);
  }
  for (const b of world.buildings) {
    mix(b.id); mix(q(b.hp)); mix(b.player); mix(b.complete ? 1 : 0);
  }
  return h >>> 0;
}
