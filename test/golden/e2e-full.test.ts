/**
 * The public contract on real images, plus the one oracle only the binary
 * can provide.
 *
 * `test/e2e.test.ts` runs the same matrix in CI on reconstructed patches.
 * This repeats it at full size — where a stride error across a 2752-wide
 * row, or a dependency on pixels the patch does not carry, would show —
 * and adds the round trip that proves the V2 add extension inverts: the
 * reference C++ binary removing what this port composited, landing back on
 * the original.
 *
 * The library still arrives only through `src/index.ts`. Run with
 * `npm run test:golden`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { processImage } from '../../src/index.js';
import type { ImageBuffer, Rect } from '../../src/index.js';
import { caseMeta } from '../helpers/cases.js';
import { requireReferenceDir } from '../helpers/golden.js';
import { casesFor, type ManifestCase } from '../helpers/manifest.js';
import { compareRegion, firstDifference } from '../helpers/pixels.js';
import { decodePng, encodePng } from '../helpers/png.js';
import { dropAlpha, firstDisturbedAlpha, toRgba } from '../helpers/rgba.js';

const kit = requireReferenceDir();
const BIN = join(kit, 'bin', 'gwt-mini');
const OUT_DIR = join(kit, 'out-e2e');

/**
 * The port has no JPEG decoder by design (PLAN.md: the kit emits
 * decode-normalized PNGs, the TS side never decodes JPEG), and this is the
 * only fixture whose input is a `.jpg`. Its committed patch was cut from
 * cv2-decoded pixels, so CI covers it — the arrangement
 * `test/golden/blend-full.test.ts` already uses.
 */
const NO_DECODER = 'v2-large-2752x1536-q90';

const readPng = (path: string): ImageBuffer =>
  decodePng(new Uint8Array(readFileSync(path)));

const watermarked = (name: string): ImageBuffer =>
  readPng(join(kit, 'fixtures', 'watermarked', `${name}.png`));
const original = (name: string): ImageBuffer =>
  readPng(join(kit, 'fixtures', 'originals', `${name}.png`));
const golden = (run: string, name: string): ImageBuffer =>
  readPng(join(kit, 'golden', run, `${name}.png`));

const runnable = (tag: Parameters<typeof casesFor>[0]): ManifestCase[] =>
  casesFor(tag).filter((c) => c.name !== NO_DECODER);

function fixtureRegion(name: string): Rect {
  const { fixture } = caseMeta(name);
  if (fixture === null) throw new Error(`${name}: no fixture geometry (a clean image)`);
  return {
    x: fixture.position.x,
    y: fixture.position.y,
    width: fixture.logo_size,
    height: fixture.logo_size,
  };
}

function forcedVariant(entry: ManifestCase): 'V1' | 'V2' {
  const variant = entry.runs.force?.removal_variant;
  if (variant === undefined) throw new Error(`${entry.name}: no force run recorded`);
  return variant;
}

function expectMatchesGolden(
  actual: ImageBuffer,
  expected: ImageBuffer,
  region: Rect,
  label: string,
): void {
  const { insideMax, outsideDiffering } = compareRegion(actual, expected, region);
  expect(outsideDiffering, `${label}: channels changed outside the region`).toBe(0);
  expect(insideMax, `${label}: deviation inside the region`).toBeLessThanOrEqual(1);
}

// —— Default removal ——————————————————————————————————————————————————

describe('processImage with no options, full size', () => {
  const entries = runnable('default_e2e');
  const executed: string[] = [];

  for (const entry of entries) {
    const run = entry.runs.default;
    const processed = run.exit_code === 0;

    it(`${entry.name} ${processed ? 'matches golden/default' : 'is left untouched'}`, () => {
      const image = watermarked(entry.name);
      const before = Uint8Array.from(image.data);
      const result = processImage(image);
      executed.push(entry.name);

      if (!processed) {
        expect(result.status).toBe('skipped');
        const changed = firstDifference(image.data, before);
        expect(changed, `${entry.name}: byte ${changed} was modified`).toBe(-1);
        return;
      }

      expect(result.status).toBe('processed');
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(run.removal_position);
      expectMatchesGolden(image, golden('default', entry.name), result.region as Rect, entry.name);
    });
  }

  it('covers every default_e2e case it can decode', () => {
    expect(casesFor('default_e2e')).toHaveLength(14);
    expect(entries).toHaveLength(13);
    expect(new Set(executed).size).toBe(13);
  });
});

// —— The alpha channel ————————————————————————————————————————————————

describe('the alpha channel, full size', () => {
  // One large case is enough here: the promise is structural, CI checks all
  // fourteen, and widening a 2752x1536 image to RGBA is 17 MB of copying.
  const name = 'v2-large-2752x1536';

  it(`${name} passes A through and never reads it`, () => {
    const rgb = watermarked(name);
    const rgba = toRgba(rgb);

    const fromRgb = processImage(rgb);
    const fromRgba = processImage(rgba);

    expect(fromRgba.status).toBe(fromRgb.status);
    expect(fromRgba.confidence).toBe(fromRgb.confidence);
    expect(fromRgba.region).toEqual(fromRgb.region);
    expect(firstDisturbedAlpha(rgba), 'A was written').toBe(-1);
    expect(firstDifference(dropAlpha(rgba).data, rgb.data), 'colours diverged').toBe(-1);
  });
});

// —— Forward add ———————————————————————————————————————————————————————

describe('processImage in add mode, full size', () => {
  const v1 = runnable('add_v1');
  const v2 = runnable('add_v2_ext');
  const executed: string[] = [];

  for (const [variant, entries] of [
    ['V1', v1],
    ['V2', v2],
  ] as const) {
    for (const entry of entries) {
      it(`${entry.name} composites the ${variant} watermark the kit did`, () => {
        const image = original(entry.name);
        const result = processImage(image, { mode: 'add', variant });
        executed.push(`${variant}:${entry.name}`);

        const region = fixtureRegion(entry.name);
        expect(result.region).toEqual(region);
        expectMatchesGolden(image, watermarked(entry.name), region, `${entry.name} add ${variant}`);
      });
    }
  }

  it('covers every add case', () => {
    expect(v1).toHaveLength(2);
    expect(v2).toHaveLength(8);
    expect(executed).toHaveLength(10);
  });
});

/**
 * The extension's actual oracle: the reference binary must be able to
 * remove what this port added and land back on the original.
 *
 * Upstream's CLI cannot add a watermark at all and its engine's
 * `add_watermark` implements only the V1 geometry, so there is no upstream
 * V2 add to be equivalent to. What can be proved is that the forward blend
 * inverts the reverse one — and that is proved by the binary, not by us.
 *
 * One case, not eight. `test/golden/blend-full.test.ts` already round-trips
 * all eight at the region level, and the assertion above pins this public
 * path to the same geometry the kit used; running the binary eight more
 * times would re-prove the same inversion from the same pixels. What is
 * *not* covered by that argument is whether the public entry point itself
 * survives the trip, so one case runs the whole way through.
 *
 * That case is the derived-size one on purpose. `v2-small-1376x768` needs a
 * 48px template, which is not one of the four baked source maps: it is
 * resampled from the 96px source through `resizeArea` at call time. So this
 * single round trip covers the resampling path as well — the binary derives
 * its own 48px map by the same rule, and if the two disagreed by more than
 * quantization the restored pixels would not land back on the original.
 * Every other candidate would have exercised baked data only.
 */
describe('add V2 through the reference binary (TS extension)', () => {
  const name = 'v2-small-1376x768';

  beforeAll(() => {
    mkdirSync(OUT_DIR, { recursive: true });
  });

  it(`${name}: C++ remove recovers the original from processImage's output`, () => {
    const source = original(name);
    const composited: ImageBuffer = {
      data: source.data.slice(),
      width: source.width,
      height: source.height,
      channels: 3,
    };
    const result = processImage(composited, { mode: 'add', variant: 'V2' });
    expect(result.status).toBe('processed');

    const added = join(OUT_DIR, `${name}-added.png`);
    const restored = join(OUT_DIR, `${name}-restored.png`);
    writeFileSync(added, encodePng(composited));
    execFileSync(BIN, ['--no-banner', '--force', '--no-legacy', '-i', added, '-o', restored], {
      timeout: 120_000,
    });

    expectMatchesGolden(
      readPng(restored),
      source,
      result.region as Rect,
      `${name} add-V2 round trip`,
    );
  });
});

// —— Forced removal ————————————————————————————————————————————————————

describe('processImage with force, full size', () => {
  const entries = runnable('force_remove');
  const executed: string[] = [];

  for (const entry of entries) {
    it(`${entry.name} matches golden/force`, () => {
      const image = watermarked(entry.name);
      const result = processImage(image, { force: true, variant: forcedVariant(entry) });
      executed.push(entry.name);

      expect(result.status).toBe('processed');
      expect(result.attempts).toEqual([]);
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(
        entry.runs.force?.removal_position,
      );
      expectMatchesGolden(
        image,
        golden('force', entry.name),
        result.region as Rect,
        `${entry.name} force`,
      );
    });
  }

  it('covers every force_remove case it can decode', () => {
    expect(casesFor('force_remove')).toHaveLength(11);
    expect(entries).toHaveLength(10);
    expect(new Set(executed).size).toBe(10);
  });
});

// —— Forced size ————————————————————————————————————————————————————————

describe('processImage with a forced size, full size', () => {
  const overrides: Record<string, 'small' | 'large'> = {
    'v1-small-800x600': 'large',
    'v2-small-1024x572': 'large',
    'v2-large-2752x1536': 'small',
  };
  const entries = runnable('forced_size');
  const executed: string[] = [];

  for (const entry of entries) {
    const size = overrides[entry.name];
    if (size === undefined) throw new Error(`${entry.name}: no size override recorded for it`);

    it(`${entry.name} forced ${size} matches golden/forced_size`, () => {
      const image = watermarked(entry.name);
      const result = processImage(image, {
        force: true,
        variant: forcedVariant(entry),
        size,
      });
      executed.push(entry.name);

      expect(result.size).toBe(size);
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(
        entry.runs.forced_size?.removal_position,
      );
      // The misaligned removal is the recorded behaviour (DEVIATIONS D3),
      // so this compares against the misaligned golden image.
      expectMatchesGolden(
        image,
        golden('forced_size', entry.name),
        result.region as Rect,
        `${entry.name} forced ${size}`,
      );
    });
  }

  it('covers every forced_size case', () => {
    expect(entries).toHaveLength(3);
    expect(new Set(executed).size).toBe(3);
  });
});

// —— Coverage closure ——————————————————————————————————————————————————

describe('what full-size coverage leaves to CI', () => {
  it('accounts for the JPEG case tag by tag', () => {
    // Not a skipped test but an asserted exclusion: the one case this
    // suite cannot decode is named, its tags are named, and CI covers all
    // of them. A second undecodable case would fail here rather than
    // quietly shrink the run.
    const excluded = casesFor('default_e2e').filter((c) => c.name === NO_DECODER);
    expect(excluded.map((c) => c.name)).toEqual([NO_DECODER]);
    expect(excluded[0]?.eligible_for.slice().sort()).toEqual([
      'default_e2e',
      'detection',
      'force_remove',
    ]);
    expect(excluded[0]?.input.format).toBe('jpg');

    for (const tag of ['add_v1', 'add_v2_ext', 'forced_size'] as const) {
      expect(casesFor(tag).map((c) => c.name), `${tag} needs no exclusion`).not.toContain(
        NO_DECODER,
      );
    }
  });
});
