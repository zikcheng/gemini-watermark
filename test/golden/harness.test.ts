import { describe, expect, it } from 'vitest';

import { REFERENCE_DIR_ENV, requireReferenceDir } from '../helpers/golden.js';

/**
 * The golden suite has no comparisons yet — pixel-level tests arrive with
 * the blend module (M2.md commit 3) and detection (M4.md commit 3). This
 * file exists so the harness itself is real from the start: it keeps
 * `npm run test:golden` runnable, and it pins the one rule every future
 * golden test inherits — a missing reference kit is a failure, never a
 * skip.
 *
 * For M2, when the first real golden test lands: checking the variable is
 * *set* is not enough. A path pointing at a nonexistent or half-built
 * directory passes this test today, which would turn a misconfigured
 * machine into a green run. Validate the kit's contents too — assert
 * `golden/manifest.json` exists and its `toolchain.binary_sha256` matches
 * the committed manifest — so a wrong path fails as loudly as a missing one.
 *
 * Delete this file once a real golden test lives here.
 */
describe('golden harness', () => {
  it(`fails loudly rather than skipping when ${REFERENCE_DIR_ENV} is missing`, () => {
    const dir = requireReferenceDir();
    expect(dir.trim().length).toBeGreaterThan(0);
  });
});
