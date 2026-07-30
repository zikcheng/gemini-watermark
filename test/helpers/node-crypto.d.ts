/**
 * Minimal ambient types for the one Node API the test suite uses.
 *
 * Tests may use Node APIs freely (only `src/` must stay
 * environment-agnostic — see tools/check-imports.mjs), but `@types/node` is
 * not a dependency yet: nothing has needed it, and the package ships zero
 * dependencies. Declaring the sliver actually used keeps it that way.
 *
 * Drop this file when a milestone adds `@types/node` for real file I/O —
 * M2's golden tests read the reference kit and will need it.
 *
 * This file has no top-level import or export on purpose: that makes it a
 * global script, so `declare module` is an ambient declaration rather than
 * an augmentation of a module that has no types to augment.
 */
declare module 'node:crypto' {
  interface Hash {
    update(data: Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}
