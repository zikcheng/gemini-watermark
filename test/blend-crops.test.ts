import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { effectiveAlphaMap } from '../src/effective-alpha.js';
import { addWatermarkRegion, removeWatermarkRegion } from '../src/blend.js';
import type { ImageBuffer } from '../src/types.js';
import type { CaseMeta } from './helpers/reconstruct.js';
import { decodePng } from './helpers/png.js';
import manifest from './data/manifest.json';

/**
 * Equivalence against the reference C++ binary, on the committed crops.
 *
 * These run in CI: the blend crops carry only the watermark region ±8px,
 * so the whole oracle fits in the repository. `test/golden/blend-full.test.ts`
 * repeats the same assertions on full-size images from the out-of-repo kit.
 *
 * The comparison is TS output vs the binary's own output for the same
 * input, so the tolerance is the quantization contract from PLAN.md:
 * inside the watermark region the two may differ by at most one level per
 * channel; everywhere else they must be byte-identical, since neither side
 * should have touched those pixels at all.
 */
const CASES_DIR = join(import.meta.dirname, 'data', 'cases');

const readMeta = (name: string): CaseMeta =>
  JSON.parse(readFileSync(join(CASES_DIR, name, 'meta.json'), 'utf8')) as CaseMeta;

const readCrop = (name: string, file: string): ImageBuffer =>
  decodePng(new Uint8Array(readFileSync(join(CASES_DIR, name, file))));

/**
 * Look up one image role, failing with the role's name.
 *
 * Which roles a case carries is meaningful — a skipped default run has no
 * `golden_default`, the JPEG case has no `original`. Falling back to an
 * empty path would turn a wrong expectation into an unreadable EISDIR from
 * deep inside `readFileSync`.
 */
function requireRole(
  files: Partial<Record<string, { file: string; decoded_pixel_sha256: string }>>,
  role: string,
  caseName: string,
): { file: string; decoded_pixel_sha256: string } {
  const entry = files[role];
  if (entry === undefined) {
    throw new Error(
      `${caseName}: no "${role}" image; available roles: ${Object.keys(files).join(', ')}`,
    );
  }
  return entry;
}

interface Comparison {
  insideMax: number;
  outsideDiffering: number;
}

function compare(
  actual: ImageBuffer,
  expected: ImageBuffer,
  region: { x: number; y: number; w: number; h: number },
): Comparison {
  let insideMax = 0;
  let outsideDiffering = 0;
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      const inside =
        x >= region.x && x < region.x + region.w && y >= region.y && y < region.y + region.h;
      for (let c = 0; c < 3; c += 1) {
        const i = (y * actual.width + x) * 3 + c;
        const delta = Math.abs((actual.data[i] ?? 0) - (expected.data[i] ?? 0));
        if (inside) insideMax = Math.max(insideMax, delta);
        else if (delta !== 0) outsideDiffering += 1;
      }
    }
  }
  return { insideMax, outsideDiffering };
}

const eligible = (manifest.cases as Array<{ name: string; eligible_for: string[] }>).filter(
  (c) => c.eligible_for.includes('force_remove'),
);

/**
 * The decoder carries every golden assertion in this file and in
 * `test/golden/blend-full.test.ts`, so it gets checked against the whole
 * committed corpus rather than only the images the comparisons happen to
 * open. `decoded_pixel_sha256` was computed by cv2 in
 * `tools/reference/make_patches.py`, which makes this an independent
 * oracle: the hashes come from a different decoder in a different language.
 */
describe('PNG decoder vs the hashes recorded by the generator', () => {
  const files: Array<[string, string, string]> = [];
  for (const entry of manifest.cases as Array<{ name: string }>) {
    const meta = readMeta(entry.name);
    const groups = [meta.patch.files, meta.blend?.files].filter(
      (g): g is Partial<Record<string, { file: string; decoded_pixel_sha256: string }>> =>
        g !== undefined,
    );
    for (const group of groups) {
      for (const role of Object.keys(group)) {
        const record = requireRole(group, role, entry.name);
        files.push([entry.name, record.file, record.decoded_pixel_sha256]);
      }
    }
  }

  it.each(files)('%s/%s decodes to the recorded pixels', (name, file, expected) => {
    const decoded = decodePng(new Uint8Array(readFileSync(join(CASES_DIR, name, file))));
    expect(createHash('sha256').update(decoded.data).digest('hex')).toBe(expected);
  });

  it('covers every committed image', () => {
    // 14 cases: 4-5 patch crops each plus 2-3 blend crops, minus the roles
    // a skipped or JPEG case does not have.
    expect(files).toHaveLength(80);
    expect(new Set(files.map(([name]) => name)).size).toBe(14);
  });
});

describe('removeWatermarkRegion vs the reference binary (committed crops)', () => {
  const executed: string[] = [];
  const skipped: string[] = [];

  for (const entry of eligible) {
    const meta = readMeta(entry.name);
    const fixture = meta.fixture;
    if (fixture === null) throw new Error(`${entry.name}: force_remove case without a fixture`);
    const blend = meta.blend;
    if (blend === null) throw new Error(`${entry.name}: force_remove case without blend crops`);

    executed.push(entry.name);

    it(`${entry.name} (${fixture.variant} ${fixture.logo_size}px)`, () => {
      const wmRole = requireRole(blend.files, 'watermarked', entry.name);
      const watermarked = readCrop(entry.name, wmRole.file);
      const golden = readCrop(entry.name, requireRole(blend.files, 'golden_force', entry.name).file);

      // The decoder is load-bearing for every assertion below, so pin it
      // against the hash the generator recorded for these exact pixels.
      const digest = createHash('sha256').update(watermarked.data).digest('hex');
      expect(digest).toBe(wmRole.decoded_pixel_sha256);

      // The template comes from the same resolver the engine uses, so the
      // derived sizes (48px here) are covered rather than skipped.
      const { alpha, w, h } = effectiveAlphaMap(
        fixture.variant,
        meta.original_size.width,
        meta.original_size.height,
      );
      expect(w, 'resolved template matches the fixture geometry').toBe(fixture.logo_size);
      const region = blend.watermark_region_in_crop;
      removeWatermarkRegion(watermarked, alpha, w, h, {
        x: region.x,
        y: region.y,
      });

      const { insideMax, outsideDiffering } = compare(watermarked, golden, region);
      expect(outsideDiffering).toBe(0);
      expect(insideMax).toBeLessThanOrEqual(1);
    });
  }

  it('executed every eligible case except the explicitly skipped ones', () => {
    expect(eligible).toHaveLength(11); // manifest tally: force_remove = 11
    expect(executed.length + skipped.length).toBe(eligible.length);
    // M3 wired effectiveAlphaMap, so the derived-size case runs too and
    // nothing is skipped any more (M3.md acceptance).
    expect(skipped).toEqual([]);
    expect(executed).toHaveLength(11);
  });
});

describe('addWatermarkRegion vs the fixtures (add_v1 cases)', () => {
  const addV1 = (manifest.cases as Array<{ name: string; eligible_for: string[] }>).filter(
    (c) => c.eligible_for.includes('add_v1'),
  );
  const executed: string[] = [];

  for (const entry of addV1) {
    const meta = readMeta(entry.name);
    const fixture = meta.fixture;
    const blend = meta.blend;
    if (fixture === null || blend === null) throw new Error(`${entry.name}: missing blend data`);
    executed.push(entry.name);

    it(`${entry.name} reproduces the watermarked fixture`, () => {
      // Upstream's add_watermark implements the V1 geometry only, so these
      // two cases are genuine upstream equivalence — unlike add-V2, which
      // is a TypeScript extension (see test/golden/blend-full.test.ts).
      const original = readCrop(entry.name, requireRole(blend.files, 'original', entry.name).file);
      const wmRole = requireRole(blend.files, 'watermarked', entry.name);
      const watermarked = readCrop(entry.name, wmRole.file);

      const { alpha, w, h } = effectiveAlphaMap(
        fixture.variant,
        meta.original_size.width,
        meta.original_size.height,
      );
      const region = blend.watermark_region_in_crop;
      addWatermarkRegion(original, alpha, w, h, {
        x: region.x,
        y: region.y,
      });

      const { insideMax, outsideDiffering } = compare(original, watermarked, region);
      expect(outsideDiffering).toBe(0);
      expect(insideMax).toBeLessThanOrEqual(1);
    });
  }

  it('executed every add_v1 case', () => {
    expect(addV1).toHaveLength(2); // manifest tally: add_v1 = 2
    expect(executed).toHaveLength(2);
  });
});
