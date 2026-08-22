// cron-worker/platforms/index.js
//
// The one place that maps a platform id to its adapter. A plain static table,
// NOT import-side-effect registration (e.g. each adapter file registering
// itself via a decorator, or a bare `import './instagram.js'` relied on for
// its side effect). That pattern is bundler-fragile: if tree-shaking or a
// future build config ever drops an "unused" side-effecting import, the
// failure surfaces at DEPLOY time — a platform silently has no adapter in
// production — rather than at TEST time, where an assertion would catch it
// immediately. A plain object literal has no such failure mode: either the
// import is here and the entry exists, or the file doesn't compile.
import { instagram } from './instagram.js';

export const ADAPTERS = Object.freeze({ ig: instagram });

// Throws naming what IS registered — never a bare undefined that surfaces
// later as a confusing TypeError far from the real mistake (same philosophy
// as shared/platform-contracts.js's contractFor, which this deliberately
// mirrors even though it is a separate registry — see that file's header for
// why validation vocabulary and publish implementations are not merged).
export function adapterFor(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new Error(
      `unknown platform ${JSON.stringify(platform)}. Registered: ${Object.keys(ADAPTERS).join(', ')}`
    );
  }
  return adapter;
}
