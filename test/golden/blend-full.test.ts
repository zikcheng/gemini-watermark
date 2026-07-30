import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { effectiveAlphaMap } from '../../src/effective-alpha.js';
import { addWatermarkRegion, removeWatermarkRegion } from '../../src/blend.js';
import type { ImageBuffer } from '../../src/types.js';
import { requireReferenceDir } from '../helpers/golden.js';
import { decodePng, encodePng } from '../helpers/png.js';
import manifest from '../data/manifest.json';

/**
 * Full-size equivalence against the reference kit.
 *
 * `test/blend-crops.test.ts` proves the same properties in CI on the
 * committed crops; this repeats them on whole images, which is where a
 * mistake in row striding or an off-by-one at an image edge would show and
 * a 112x112 crop would not. Run with `npm run test:golden`.
 */
const kit = requireReferenceDir();
const BIN = join(kit, 'bin', 'gwt-mini');
const OUT_DIR = join(kit, 'out-v2add');

type Case = {
  name: string;
  input: { format: string };
  fixture: { variant: 'V1' | 'V2'; logo_size: number; position: { x: number; y: number } } | null;
  eligible_for: string[];
};
const cases = manifest.cases as Case[];

const readPng = (path: string): ImageBuffer => decodePng(new Uint8Array(readFileSync(path)));

function compare(
  actual: ImageBuffer,
  expected: ImageBuffer,
  region: { x: number; y: number; size: number },
): { insideMax: number; outsideDiffering: number } {
  let insideMax = 0;
  let outsideDiffering = 0;
  for (let y = 0; y < actual.height; y += 1) {
    for (let x = 0; x < actual.width; x += 1) {
      const inside =
        x >= region.x && x < region.x + region.size && y >= region.y && y < region.y + region.size;
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

describe('reference kit', () => {
  it('is a generated kit, not just a directory that happens to exist', () => {
    // Checking only that the variable is set would let a stale or wrong
    // path turn a misconfigured machine into a green run.
    const manifestPath = join(kit, 'golden', 'manifest.json');
    expect(existsSync(manifestPath), `missing ${manifestPath}`).toBe(true);

    const kitManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      toolchain: { binary_sha256: string; binary_version: string };
    };
    expect(kitManifest.toolchain.binary_sha256).toBe(manifest.toolchain.binary_sha256);
    expect(kitManifest.toolchain.binary_version).toBe(manifest.toolchain.binary_version);
    expect(existsSync(BIN), `missing ${BIN}`).toBe(true);
  });
});

describe('removeWatermarkRegion on full images', () => {
  const eligible = cases.filter((c) => c.eligible_for.includes('force_remove'));
  const executed: string[] = [];
  const skipped: Array<[string, string]> = [];

  for (const entry of eligible) {
    const fixture = entry.fixture;
    if (fixture === null) continue;

    if (entry.input.format === 'jpg') {
      // The port deliberately has no JPEG decoder; the committed crop for
      // this case was cut from cv2-decoded pixels and covers it in CI.
      skipped.push([entry.name, 'JPEG input']);
      it.skip(`${entry.name} — JPEG input, covered by the crop test`, () => {});
      continue;
    }
    executed.push(entry.name);

    it(`${entry.name}`, () => {
      const image = readPng(join(kit, 'fixtures', 'watermarked', `${entry.name}.png`));
      const golden = readPng(join(kit, 'golden', 'force', `${entry.name}.png`));

      const { alpha, w, h } = effectiveAlphaMap(fixture.variant, image.width, image.height);
      expect(w, 'resolved template matches the fixture geometry').toBe(fixture.logo_size);
      removeWatermarkRegion(image, alpha, w, h, fixture.position);

      const { insideMax, outsideDiffering } = compare(image, golden, {
        ...fixture.position,
        size: fixture.logo_size,
      });
      expect(outsideDiffering).toBe(0);
      expect(insideMax).toBeLessThanOrEqual(1);
    });
  }

  it('accounts for every eligible case', () => {
    expect(eligible).toHaveLength(11);
    expect(executed.length + skipped.length).toBe(11);
    // Only the JPEG case remains: the port has no JPEG decoder by design,
    // and its crop (cut from cv2-decoded pixels) covers it in CI. The
    // derived-size case now runs, M3 having wired effectiveAlphaMap.
    expect(skipped.map(([n]) => n)).toEqual(['v2-large-2752x1536-q90']);
  });
});

describe('addWatermarkRegion on full images', () => {
  const addV1 = cases.filter((c) => c.eligible_for.includes('add_v1'));

  it.each(addV1.map((c) => c.name))('%s reproduces the watermarked fixture', (name) => {
    const entry = addV1.find((c) => c.name === name);
    const fixture = entry?.fixture;
    if (!fixture) throw new Error(`${name}: missing fixture`);

    const image = readPng(join(kit, 'fixtures', 'originals', `${name}.png`));
    const expected = readPng(join(kit, 'fixtures', 'watermarked', `${name}.png`));
    const { alpha, w, h } = effectiveAlphaMap(fixture.variant, image.width, image.height);
    addWatermarkRegion(image, alpha, w, h, fixture.position);

    const { insideMax, outsideDiffering } = compare(image, expected, {
      ...fixture.position,
      size: fixture.logo_size,
    });
    expect(outsideDiffering).toBe(0);
    expect(insideMax).toBeLessThanOrEqual(1);
  });

  it('accounts for every add_v1 case', () => {
    expect(addV1).toHaveLength(2);
  });
});

/**
 * Extension contract: the oracle here is C++ **remove**, not upstream add
 * equivalence.
 *
 * Upstream's CLI cannot add a watermark at all, and its engine's
 * `add_watermark` implements only the V1 geometry — there is no upstream
 * add-V2 behaviour to compare against. So the property tested is a round
 * trip: whatever this port composites, the reference binary must be able
 * to take back off and land on the original. A green run here says the
 * TypeScript forward blend is the exact inverse of the C++ reverse blend;
 * it does not say upstream would have produced the same watermarked image.
 */
describe('add V2 round trip through the reference binary (TS extension)', () => {
  const addV2 = cases.filter((c) => c.eligible_for.includes('add_v2_ext'));
  const executed: string[] = [];
  const skipped: string[] = [];

  beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
  });

  for (const entry of addV2) {
    const fixture = entry.fixture;
    if (fixture === null) continue;
    executed.push(entry.name);

    it(`${entry.name}: C++ remove recovers the original`, () => {
      const original = readPng(join(kit, 'fixtures', 'originals', `${entry.name}.png`));
      const composited: ImageBuffer = {
        data: original.data.slice(),
        width: original.width,
        height: original.height,
        channels: 3,
      };
      const { alpha, w, h } = effectiveAlphaMap('V2', original.width, original.height);
      addWatermarkRegion(composited, alpha, w, h, fixture.position);

      const added = join(OUT_DIR, `${entry.name}-added.png`);
      const restored = join(OUT_DIR, `${entry.name}-restored.png`);
      writeFileSync(added, encodePng(composited));
      execFileSync(BIN, ['--no-banner', '--force', '--no-legacy', '-i', added, '-o', restored], {
        timeout: 120_000,
      });

      const { insideMax, outsideDiffering } = compare(readPng(restored), original, {
        ...fixture.position,
        size: fixture.logo_size,
      });
      expect(outsideDiffering).toBe(0);
      expect(insideMax).toBeLessThanOrEqual(1);
    });
  }

  it('accounts for every add_v2_ext case', () => {
    expect(addV2).toHaveLength(8);
    expect(executed.length + skipped.length).toBe(8);
    expect(skipped).toEqual([]);
    expect(executed).toHaveLength(8);
  });
});
