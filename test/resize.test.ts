import { describe, expect, it } from 'vitest';

import { getSourceAlphaMap } from '../src/alpha-maps.js';
import { effectiveAlphaMap } from '../src/effective-alpha.js';
import { getWatermarkConfig } from '../src/position.js';
import { resizeArea, resizeAreaIntegerFactor, resizeBilinear } from '../src/resize.js';
import { DumpReader, withinDualTolerance } from './helpers/imageops-dump.js';

const DUMP_ABS_TOL = 1e-6;
const DUMP_REL_TOL = 1e-5;

const dump = new DumpReader('resize-alpha');
const source = dump.float32('v2-96-alpha');

interface ResizeOutput {
  size: number;
  interpolation: 'INTER_AREA' | 'INTER_LINEAR';
  output: string;
}
const outputs = dump.entries<ResizeOutput>('outputs');

/** Worst absolute error, plus how many samples fall outside the budget. */
function compare(
  actual: Float32Array,
  expected: Float32Array,
): { worst: number; outside: number; exact: number } {
  let worst = 0;
  let outside = 0;
  let exact = 0;
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i] ?? 0;
    const got = actual[i] ?? 0;
    worst = Math.max(worst, Math.abs(got - want));
    if (!withinDualTolerance(got, want, DUMP_ABS_TOL, DUMP_REL_TOL)) outside += 1;
    if (got === want) exact += 1;
  }
  return { worst, outside, exact };
}

describe('resize kernels vs cv2', () => {
  it.each(outputs.map((o) => [o.size, o] as const))(
    '96 -> %i matches the dump',
    (_size, entry) => {
      const expected = dump.float32(entry.output);
      const actual =
        entry.interpolation === 'INTER_LINEAR'
          ? resizeBilinear(source.data, source.width, source.height, entry.size, entry.size)
          : resizeArea(source.data, source.width, source.height, entry.size, entry.size);

      expect(actual).toHaveLength(entry.size * entry.size);
      const { worst, outside } = compare(actual, expected.data);
      expect(outside, `${outside} samples outside the budget, worst ${worst}`).toBe(0);
    },
  );

  it('covers both kernels and the exact-half case', () => {
    // Guards the guard: if the dump ever loses a size, the parametrised
    // test above would silently shrink.
    expect(outputs.map((o) => o.size).sort((a, b) => a - b)).toEqual([42, 48, 53, 101]);
    expect(outputs.filter((o) => o.interpolation === 'INTER_LINEAR').map((o) => o.size)).toEqual([
      101,
    ]);
  });

  it('reproduces 96 -> 48 bit for bit through the general area path', () => {
    // The exact-half case is the one derived size the port actually ships
    // (the V2 half-scale class), so it is worth stating that the general
    // path is not merely within tolerance here but identical.
    const expected = dump.float32('v2-96-to-48');
    const { exact } = compare(
      resizeArea(source.data, source.width, source.height, 48, 48),
      expected.data,
    );
    expect(exact).toBe(expected.data.length);
  });

  it('the integer-factor shortcut agrees with the general path to within an ulp', () => {
    // Same arithmetic, different accumulation order: the general path sums
    // separably (rows then columns) as cv2 does, while this one sums each
    // 2x2 block in one go. That costs bit-exactness on 186 of 2304 values,
    // which is why effectiveAlphaMap wires the general path — see the note
    // in src/effective-alpha.ts.
    const general = resizeArea(source.data, 96, 96, 48, 48);
    const fast = resizeAreaIntegerFactor(source.data, 96, 96, 2);
    const { worst, outside } = compare(fast, general);
    expect(outside).toBe(0);
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-7);
  });

  it('averages each block in the integer-factor path', () => {
    const src = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(Array.from(resizeAreaIntegerFactor(src, 4, 4, 2))).toEqual([3.5, 5.5, 11.5, 13.5]);
  });

  it('samples at half-pixel centres when upscaling', () => {
    // Doubling puts the destination centres at source coordinates
    // -0.25, 0.25, 0.75, 1.25 — the first clamps to the edge sample, so a
    // two-pixel ramp becomes [0, 0.25, 0.75, 1].
    const src = Float32Array.from([0, 1]);
    expect(Array.from(resizeBilinear(src, 2, 1, 4, 1))).toEqual([0, 0.25, 0.75, 1]);
  });

  it('rejects malformed arguments', () => {
    expect(() => resizeArea(new Float32Array(3), 2, 2, 1, 1)).toThrow(
      /source holds 3 values, expected 4/,
    );
    expect(() => resizeBilinear(new Float32Array(4), 2, 2, 0, 1)).toThrow(
      /target size must be positive integers/,
    );
    expect(() => resizeAreaIntegerFactor(new Float32Array(9), 3, 3, 2)).toThrow(
      /does not divide 3x3 evenly/,
    );
  });
});

describe('effectiveAlphaMap', () => {
  it.each([
    [200, 500, 36, 'the canonical V2 small template, used as is'],
    [1190, 500, 42, 'derived by area'],
    [1362, 500, 48, 'the half-scale class'],
    [1558, 500, 53, 'derived by area'],
    [2982, 500, 101, 'derived by linear upscale'],
  ] as const)(
    'V2 %ix%i resolves to a %ipx template — %s',
    (width, height, edge, _why) => {
      const variant = 'V2';
      const map = effectiveAlphaMap(variant, width, height);
      expect(map.w).toBe(edge);
      expect(map.h).toBe(edge);
      expect(map.alpha).toHaveLength(edge * edge);
      // The resolver must agree with the geometry the position module
      // derives, since the engine blends the two together.
      expect(getWatermarkConfig(width, height, variant).logoSize).toBe(edge);
    },
  );

  it.each([
    [1190, 500, 42],
    [1362, 500, 48],
    [1558, 500, 53],
    [2982, 500, 101],
  ] as const)('V2 %ix%i reproduces the cv2 %ipx map', (w, h, edge) => {
    const expected = dump.float32(`v2-96-to-${edge}`);
    const { outside, worst } = compare(effectiveAlphaMap('V2', w, h).alpha, expected.data);
    expect(outside, `worst ${worst}`).toBe(0);
  });

  it('returns the untouched source map where no resampling is needed', () => {
    for (const [variant, width, height, edge] of [
      ['V1', 800, 600, 48],
      ['V1', 1500, 1200, 96],
      ['V2', 1024, 572, 36],
      ['V2', 1500, 1200, 96],
    ] as const) {
      const map = effectiveAlphaMap(variant, width, height);
      const size = edge === 96 ? 'large' : 'small';
      expect(map.w).toBe(edge);
      expect(Array.from(map.alpha)).toEqual(Array.from(getSourceAlphaMap(variant, size)));
    }
  });

  it('honours a forced size, reproducing the upstream mismatch', () => {
    // Forcing a size selects the template but not the position, which is
    // how upstream ends up blending a mismatched template — DEVIATIONS D3.
    // `--force-small` on a large V2 image is the striking one: the size
    // resolves back through the dimension-derived config to 96, so it is a
    // no-op rather than the 36px template the flag name suggests.
    expect(effectiveAlphaMap('V2', 2752, 1536, 'small').w).toBe(96);
    expect(effectiveAlphaMap('V2', 1024, 572, 'large').w).toBe(96);
    expect(effectiveAlphaMap('V1', 800, 600, 'large').w).toBe(96);
    expect(effectiveAlphaMap('V1', 1500, 1200, 'small').w).toBe(48);
  });

  it('hands out a fresh buffer each call', () => {
    const first = effectiveAlphaMap('V2', 1362, 500);
    const original = first.alpha[0];
    first.alpha[0] = 999;
    const second = effectiveAlphaMap('V2', 1362, 500);
    expect(second.alpha).not.toBe(first.alpha);
    expect(second.alpha[0]).toBe(original);
  });
});
