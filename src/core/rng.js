// Deterministic PRNG (mulberry32). The whole simulation draws from a seeded
// instance so a given seed always produces the same map and the same AI rolls,
// which makes bugs reproducible.

export function makeRng(seed = 1) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  rng.range = (min, max) => min + rng() * (max - min);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  // The whole state of the generator, in one 32-bit word.
  //
  // This is what makes a saved game a *continuation* rather than a lookalike.
  // Restoring a match from the seed alone would rewind the generator to zero
  // draws, so the first wave interval, the first placement cursor and every
  // building variant after the load would come out of a different part of the
  // stream than they would have in the match that was saved — the same world,
  // playing a different game from the next tick on. See src/core/save.js.
  rng.getState = () => a >>> 0;
  rng.setState = (v) => { a = (v >>> 0); };
  return rng;
}
