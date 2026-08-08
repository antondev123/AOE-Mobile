// Module resolution hook used by tests/enemyai.test.mjs.
//
// The other systems (economy / unitAI / combat) are written by other people and
// may not exist yet. When one is missing, this hook redirects the import to the
// matching tests/enemyai.stub-*.mjs so the enemy AI can still be exercised
// against a full simulation loop. When the real file exists, the hook does
// nothing and the exact same test runs against production code.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STUBS = {
  'economy.js': new URL('./enemyai.stub-economy.mjs', import.meta.url).href,
  'unitAI.js': new URL('./enemyai.stub-unitai.mjs', import.meta.url).href,
  'combat.js': new URL('./enemyai.stub-combat.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  for (const [name, stub] of Object.entries(STUBS)) {
    if (!specifier.endsWith(`/${name}`) && specifier !== `./${name}`) continue;
    if (!context.parentURL) continue;
    let target;
    try {
      target = fileURLToPath(new URL(specifier, context.parentURL));
    } catch {
      continue;
    }
    if (!target.includes('/src/systems/')) continue;
    if (existsSync(target)) continue; // the real module landed — use it
    return { url: stub, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

export const stubUrls = Object.values(STUBS).map((u) => pathToFileURL(u).href);
