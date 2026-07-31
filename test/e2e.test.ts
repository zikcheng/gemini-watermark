/**
 * The public contract, exercised the way a consumer would exercise it.
 *
 * Everything the library does here arrives through `src/index.ts` and
 * nothing else — no reaching into `detect.ts` for a score, no
 * `effectiveAlphaMap` to check which template was chosen. That restriction
 * is the point rather than a formality: the other suites prove the pieces
 * are right, and this one proves the pieces are *reachable* and behave as
 * documented from outside. A regression that leaves every internal
 * assertion green while breaking the exported surface — a missing export,
 * an option that stops being honoured, an error type that changes — shows
 * up here and only here.
 *
 * Coverage is driven by the manifest's `eligible_for` tags rather than by a
 * hand-written list, and every tag's count is closed at the end of its
 * section, so a case that quietly stops being exercised fails the suite
 * instead of shrinking it.
 *
 * Images are the committed patches rebuilt to full size, so this runs in
 * CI. `test/golden/e2e-full.test.ts` repeats it on the real images and adds
 * the one oracle that needs the reference binary.
 */
import { describe, expect, it } from 'vitest';

import { processImage } from '../src/index.js';
import type { ImageBuffer, ProcessOptions, Rect } from '../src/index.js';
import { caseImage, caseMeta } from './helpers/cases.js';
import { casesFor, type ManifestCase } from './helpers/manifest.js';
import { compareRegion, firstDifference } from './helpers/pixels.js';
import { dropAlpha, firstDisturbedAlpha, toRgba } from './helpers/rgba.js';

/** Manifest tallies, so a shrunk corpus fails instead of passing quietly. */
const EXPECTED = {
  default_e2e: 14,
  force_remove: 11,
  add_v1: 2,
  add_v2_ext: 8,
  forced_size: 3,
} as const;

/** The watermark rectangle a case's fixture describes. */
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

/** Which profile the kit's `--force` run pinned for this case. */
function forcedVariant(entry: ManifestCase): 'V1' | 'V2' {
  const variant = entry.runs.force?.removal_variant;
  if (variant === undefined) throw new Error(`${entry.name}: no force run recorded`);
  return variant;
}

/**
 * Inside the region the two may differ by one level per channel — the
 * float-width allowance of CLAUDE.md rule 4 — and outside it they may not
 * differ at all, since neither side should have written there.
 */
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

describe('processImage with no options', () => {
  const entries = casesFor('default_e2e');
  const executed: string[] = [];

  for (const entry of entries) {
    const run = entry.runs.default;
    const processed = run.exit_code === 0;

    it(`${entry.name} ${processed ? 'removes the watermark' : 'leaves the image alone'}`, () => {
      const image = caseImage(entry.name, 'watermarked');
      const before = Uint8Array.from(image.data);
      const result = processImage(image);
      executed.push(entry.name);

      if (!processed) {
        // The safety property the gate exists for. A consumer running a
        // batch job over a mixed folder gets the untouched files back
        // byte for byte, not re-encoded and not nudged.
        expect(result.status).toBe('skipped');
        expect(result.region, 'a skip describes no region').toBeUndefined();
        const changed = firstDifference(image.data, before);
        expect(changed, `${entry.name}: byte ${changed} was modified`).toBe(-1);
        return;
      }

      expect(result.status).toBe('processed');
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(run.removal_position);
      expect({ width: result.region?.width, height: result.region?.height }).toEqual({
        width: run.alpha_map?.width,
        height: run.alpha_map?.height,
      });
      expectMatchesGolden(
        image,
        caseImage(entry.name, 'golden_default'),
        result.region as Rect,
        entry.name,
      );
    });
  }

  it('covers every default_e2e case', () => {
    expect(entries).toHaveLength(EXPECTED.default_e2e);
    expect(new Set(executed).size).toBe(EXPECTED.default_e2e);
  });
});

// —— The alpha channel ————————————————————————————————————————————————

describe('the alpha channel of an RGBA buffer', () => {
  /**
   * Two promises in one sentence of the contract, and they fail in
   * different ways, so they are asserted separately.
   *
   * *Never written* is the obvious one: the A bytes come back as planted.
   * *Never read* is the one a careless stride would break — a detector that
   * walked 4-channel pixels as though they were 3-channel would compute a
   * different luma, and the removal would land somewhere else. Comparing
   * the colour channels against an RGB run of the same pixels catches that,
   * because the two runs can only agree if A never entered the arithmetic.
   */
  const entries = casesFor('default_e2e');
  const executed: string[] = [];

  for (const entry of entries) {
    it(`${entry.name} passes A through and never reads it`, () => {
      const rgb = caseImage(entry.name, 'watermarked');
      const rgba = toRgba(rgb);
      expect(rgba.channels).toBe(4);

      const fromRgb = processImage(rgb);
      const fromRgba = processImage(rgba);
      executed.push(entry.name);

      expect(fromRgba.status, 'the same verdict').toBe(fromRgb.status);
      expect(fromRgba.confidence, 'from the same scores').toBe(fromRgb.confidence);
      expect(fromRgba.region, 'at the same place').toEqual(fromRgb.region);

      const disturbed = firstDisturbedAlpha(rgba);
      expect(disturbed, `${entry.name}: A of pixel ${disturbed} was written`).toBe(-1);

      const colours = firstDifference(dropAlpha(rgba).data, rgb.data);
      expect(colours, `${entry.name}: colour byte ${colours} differs from the RGB run`).toBe(-1);
    });
  }

  it('covers every default_e2e case', () => {
    expect(new Set(executed).size).toBe(EXPECTED.default_e2e);
  });
});

// —— Forward add ———————————————————————————————————————————————————————

describe('processImage in add mode', () => {
  const v1 = casesFor('add_v1');
  const v2 = casesFor('add_v2_ext');
  const executed: string[] = [];
  const rgbaChecked: string[] = [];

  /**
   * The oracle is the kit's own watermarked fixture, which was composited
   * from the same alpha maps and position formulas this port implements.
   * So a match says the public add resolves the same geometry and blends
   * the same way the kit's generator did.
   *
   * For V1 that is also upstream equivalence, since `add_watermark` exists
   * upstream and the kit's V1 fixtures follow it. For V2 it is **not**: the
   * upstream engine has no V2 add at all, so there is nothing here to be
   * equivalent to, and this assertion must not be read as claiming
   * otherwise. The extension's real oracle is the C++ round trip in
   * `test/golden/e2e-full.test.ts` — the binary removing what this adds.
   */
  for (const [variant, entries] of [
    ['V1', v1],
    ['V2', v2],
  ] as const) {
    for (const entry of entries) {
      it(`${entry.name} composites the ${variant} watermark the kit did`, () => {
        const image = caseImage(entry.name, 'original');
        const result = processImage(image, { mode: 'add', variant });
        executed.push(`${variant}:${entry.name}`);

        expect(result.status, 'add is unconditional').toBe('processed');
        expect(result.confidence, 'nothing was detected').toBe(0);
        expect(result.attempts).toEqual([]);
        expect(result.variant).toBe(variant);

        const region = fixtureRegion(entry.name);
        expect(result.region, 'lands where the fixture says').toEqual(region);
        expectMatchesGolden(
          image,
          caseImage(entry.name, 'watermarked'),
          region,
          `${entry.name} add ${variant}`,
        );
      });
    }
  }

  /**
   * The A-channel promise is not path-specific, so neither is the test.
   *
   * Removal and addition write pixels through different loops, and a
   * channel-count mistake in one says nothing about the other — an add
   * that widened its stride to 4 would leave every removal assertion
   * green. Both variants run, because the two add paths resolve their
   * geometry differently and only share the blend.
   */
  for (const [variant, entries] of [
    ['V1', v1],
    ['V2', v2],
  ] as const) {
    for (const entry of entries) {
      it(`${entry.name} add ${variant} passes A through and never reads it`, () => {
        const rgb = caseImage(entry.name, 'original');
        const rgba = toRgba(rgb);

        const fromRgb = processImage(rgb, { mode: 'add', variant });
        const fromRgba = processImage(rgba, { mode: 'add', variant });
        rgbaChecked.push(`${variant}:${entry.name}`);

        expect(fromRgba.region, 'composited at the same place').toEqual(fromRgb.region);
        expect(fromRgba.size).toBe(fromRgb.size);

        const disturbed = firstDisturbedAlpha(rgba);
        expect(disturbed, `${entry.name}: A of pixel ${disturbed} was written`).toBe(-1);

        const colours = firstDifference(dropAlpha(rgba).data, rgb.data);
        expect(colours, `${entry.name}: colour byte ${colours} differs from the RGB run`).toBe(-1);
      });
    }
  }

  it('an explicit size moves the add position, unlike a forced removal', () => {
    // The one asymmetry between adding and removing, and it is upstream's:
    // `add_watermark` builds its config from the size actually used, while
    // `remove_watermark` keeps the dimension-derived position and only
    // swaps the template (DEVIATIONS D3). Nothing above can see the
    // difference, because every add case resolves to its natural size and
    // the two configs then coincide — forcing is what separates them.
    const name = 'v1-small-800x600'; // 800x600 is the small class
    const forced = processImage(caseImage(name, 'original'), { mode: 'add', size: 'large' });
    expect(forced.size).toBe('large');
    // 800 - 64 - 96 and 600 - 64 - 96, the large config's own margins. A
    // dimension-derived config would place the same 96px template at
    // 800 - 32 - 48 = 720, 600 - 32 - 48 = 520.
    expect(forced.region).toEqual({ x: 640, y: 440, width: 96, height: 96 });

    const natural = processImage(caseImage(name, 'original'), { mode: 'add' });
    expect(natural.region).toEqual({ x: 720, y: 520, width: 48, height: 48 });
  });

  it('covers every add_v1 and add_v2_ext case, RGB and RGBA alike', () => {
    expect(v1).toHaveLength(EXPECTED.add_v1);
    expect(v2).toHaveLength(EXPECTED.add_v2_ext);
    expect(executed).toHaveLength(EXPECTED.add_v1 + EXPECTED.add_v2_ext);
    expect(new Set(executed).size).toBe(executed.length);
    expect(new Set(rgbaChecked).size).toBe(EXPECTED.add_v1 + EXPECTED.add_v2_ext);
  });
});

// —— Forced removal ————————————————————————————————————————————————————

describe('processImage with force', () => {
  const entries = casesFor('force_remove');
  const executed: string[] = [];

  for (const entry of entries) {
    it(`${entry.name} removes without consulting the gate`, () => {
      const image = caseImage(entry.name, 'watermarked');
      const result = processImage(image, {
        force: true,
        variant: forcedVariant(entry),
        // Ignored rather than rejected: forcing turns detection off, so
        // there is no confidence for a threshold to compare against.
        threshold: 0.99,
      });
      executed.push(entry.name);

      expect(result.status).toBe('processed');
      expect(result.attempts, 'no gate ran, so nothing was attempted').toEqual([]);
      expect(result.confidence).toBe(0);
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(
        entry.runs.force?.removal_position,
      );
      expectMatchesGolden(
        image,
        caseImage(entry.name, 'golden_force'),
        result.region as Rect,
        `${entry.name} force`,
      );
    });
  }

  it('forces the one case the default run skips', () => {
    // `v2-large-2752x1536-hard` is the fixture upstream's own detector
    // misses. Its default run leaves it alone; forcing removes it anyway,
    // which is the entire reason the flag exists.
    const name = 'v2-large-2752x1536-hard';
    expect(casesFor('default_e2e').find((c) => c.name === name)?.runs.default.exit_code).toBe(1);

    const image = caseImage(name, 'watermarked');
    const before = Uint8Array.from(image.data);
    expect(processImage(image).status, 'skips by default').toBe('skipped');
    expect(firstDifference(image.data, before)).toBe(-1);

    expect(processImage(image, { force: true, variant: 'V2' }).status).toBe('processed');
    expect(firstDifference(image.data, before), 'force changed nothing').not.toBe(-1);
  });

  it('covers every force_remove case', () => {
    expect(entries).toHaveLength(EXPECTED.force_remove);
    expect(new Set(executed).size).toBe(EXPECTED.force_remove);
  });
});

// —— Explicit variant ——————————————————————————————————————————————————

describe('processImage with an explicit variant', () => {
  // `v1-small-800x600` carries a V1 watermark, and its default run needs
  // the V2→V1 fallback to find it. Naming a variant turns that fallback
  // off, which is visible in both directions on this one image.
  const name = 'v1-small-800x600';

  it('V1 finds it in one attempt', () => {
    const image = caseImage(name, 'watermarked');
    const result = processImage(image, { variant: 'V1' });

    expect(result.status).toBe('processed');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V1']);
    expectMatchesGolden(
      image,
      caseImage(name, 'golden_default'),
      result.region as Rect,
      `${name} explicit V1`,
    );
  });

  it('V2 skips, because the retry that would have found it is disabled', () => {
    const image = caseImage(name, 'watermarked');
    const before = Uint8Array.from(image.data);
    const result = processImage(image, { variant: 'V2' });

    expect(result.status).toBe('skipped');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V2']);
    expect(firstDifference(image.data, before)).toBe(-1);
  });

  it('autoFallback: false does the same without naming one', () => {
    const result = processImage(caseImage(name, 'watermarked'), { autoFallback: false });
    expect(result.status).toBe('skipped');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V2']);
  });
});

// —— Forced size ————————————————————————————————————————————————————————

describe('processImage with a forced size', () => {
  /**
   * The size override picks the template while the position keeps coming
   * from the dimension-derived config, so the two can disagree and the
   * removal lands misaligned. That is upstream behaviour reproduced as-is
   * (DEVIATIONS D3), and the golden images are of the misaligned output.
   */
  const overrides: Record<string, 'small' | 'large'> = {
    'v1-small-800x600': 'large',
    'v2-small-1024x572': 'large',
    'v2-large-2752x1536': 'small',
  };
  const entries = casesFor('forced_size');
  const executed: string[] = [];

  /** Throws during collection if the kit grows a case this list forgot. */
  function forcedSize(name: string): 'small' | 'large' {
    const size = overrides[name];
    if (size === undefined) throw new Error(`${name}: no size override recorded for it`);
    return size;
  }

  for (const entry of entries) {
    const size = forcedSize(entry.name);

    it(`${entry.name} forced ${size} reproduces the recorded output`, () => {
      const run = entry.runs.forced_size;
      expect(run, 'and a recorded run').toBeDefined();

      const image = caseImage(entry.name, 'watermarked');
      const result = processImage(image, {
        force: true,
        variant: forcedVariant(entry),
        size,
      });
      executed.push(entry.name);

      expect(result.status).toBe('processed');
      expect(result.size).toBe(size);
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(run?.removal_position);
      expect({ width: result.region?.width, height: result.region?.height }).toEqual({
        width: run?.alpha_map?.width,
        height: run?.alpha_map?.height,
      });
      expectMatchesGolden(
        image,
        caseImage(entry.name, 'golden_forced_size'),
        result.region as Rect,
        `${entry.name} forced ${String(size)}`,
      );
    });
  }

  it.each([
    ['v1-small-800x600', 'V1'],
    ['v2-small-1024x572', 'V2'],
  ] as const)('%s forced large is genuinely misaligned', (name, variant) => {
    // The template grows to 96px while the position stays where a 48px (or
    // 36px) logo belongs, so the output differs from the natural forced
    // run. These are the two cases where the override actually bites.
    const forced = caseImage(name, 'watermarked');
    processImage(forced, { force: true, variant, size: 'large' });
    const natural = caseImage(name, 'watermarked');
    const naturalResult = processImage(natural, { force: true, variant });

    expect(firstDifference(forced.data, natural.data), 'the override changed nothing').not.toBe(-1);
    expect(naturalResult.region?.width, 'the natural template is smaller').toBeLessThan(96);
  });

  it('is a no-op on a large V2 image, exactly as D3 records', () => {
    // `--force-small` there resolves back through the dimension-derived
    // config to a 96px template, which is what the run would have used
    // anyway — so the bytes are identical.
    const name = 'v2-large-2752x1536';
    const forced = caseImage(name, 'watermarked');
    const result = processImage(forced, { force: true, variant: 'V2', size: 'small' });
    const natural = caseImage(name, 'watermarked');
    processImage(natural, { force: true, variant: 'V2' });

    expect(result.region?.width, 'the 36px small template was not used').toBe(96);
    expect(firstDifference(forced.data, natural.data)).toBe(-1);
  });

  it('covers every forced_size case', () => {
    expect(entries).toHaveLength(EXPECTED.forced_size);
    expect(new Set(executed).size).toBe(EXPECTED.forced_size);
  });
});

// —— Errors ————————————————————————————————————————————————————————————

describe('invalid input, per the contract error table', () => {
  const valid: ImageBuffer = { data: new Uint8Array(2 * 2 * 3), width: 2, height: 2, channels: 3 };

  it('a buffer length that disagrees with the shape is a RangeError', () => {
    const call = () => processImage({ ...valid, data: new Uint8Array(11) });
    expect(call).toThrow(RangeError);
    // Actual before expected, as the contract specifies.
    expect(call).toThrow(/holds 11 bytes, expected 12/);
  });

  it('a channel count other than 3 or 4 is a RangeError', () => {
    const call = () => processImage({ ...valid, channels: 2 as unknown as 3 });
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/channels is 2, expected 3 \(RGB\) or 4 \(RGBA\)/);
  });

  it('non-integer dimensions are a RangeError', () => {
    const call = () => processImage({ ...valid, width: 2.5 });
    expect(call).toThrow(RangeError);
    expect(call).toThrow(/must be positive integers, got 2\.5x2/);
  });

  it.each([
    ['variant', { variant: 'v2' }, /options\.variant is "v2", expected 'V1' or 'V2'/],
    ['size', { size: 'Large' }, /options\.size is "Large", expected 'small' or 'large'/],
    ['mode', { mode: 'delete' }, /options\.mode is "delete", expected 'remove' or 'add'/],
  ])('an unknown %s value is a RangeError', (_field, options, message) => {
    const call = () => processImage({ ...valid }, options as ProcessOptions);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(message);
  });

  it.each([null, undefined, 'an image', 42])('a non-object image is a TypeError (%s)', (input) => {
    expect(() => processImage(input as unknown as ImageBuffer)).toThrow(TypeError);
  });

  it('nothing is written before the input is rejected', () => {
    // A validation error must not leave the buffer half-processed; the
    // whole point of throwing is that the caller's pixels are still theirs.
    const image = caseImage('v2-large-1500x1200', 'watermarked');
    const before = Uint8Array.from(image.data);
    expect(() => processImage(image, { mode: 'delete' } as unknown as ProcessOptions)).toThrow(
      RangeError,
    );
    expect(firstDifference(image.data, before)).toBe(-1);
  });
});
