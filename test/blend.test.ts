import { describe, expect, it } from 'vitest';

import { getSourceAlphaMap } from '../src/alpha-maps.js';
import { addWatermarkRegion, removeWatermarkRegion } from '../src/blend.js';
import { quantizeU8, roundHalfToEven } from '../src/quantize.js';
import type { ImageBuffer, Point, WatermarkSize, WatermarkVariant } from '../src/types.js';
import oracle from './data/imageops/quantize-u8.json';

const rgb = (width: number, height: number, fill = 0): ImageBuffer => ({
  data: new Uint8Array(width * height * 3).fill(fill),
  width,
  height,
  channels: 3,
});

const flatAlpha = (edge: number, value: number): Float32Array =>
  new Float32Array(edge * edge).fill(value);

/**
 * An alpha map whose every cell is distinct, so an output byte identifies
 * which cell produced it. Combined with `add` onto a black image the byte
 * is just `quantizeU8(alpha * 255)`, which makes the alpha-side offset
 * under clipping directly observable instead of merely plausible.
 */
const rampAlpha = (edge: number): Float32Array =>
  Float32Array.from({ length: edge * edge }, (_, i) => (i + 1) / (edge * edge + 1));

describe('quantizeU8 — the cv2 saturate_cast<uchar> law', () => {
  // The oracle's `input` values are the exact float32 the pinned cv2 saw,
  // widened to double. Writing `255.4` here instead would test a different
  // number: 255.4 is not representable in float32, and the JS literal is a
  // third value again (see the dump's meta).
  it.each(oracle.samples)('quantizes $label to $output', ({ input, output }) => {
    expect(quantizeU8(input)).toBe(output);
  });

  it('covers every tie and both saturation ends', () => {
    // Guards the guard: if the dump ever loses its boundary cases, this
    // test still says what the law has to do.
    const labels = oracle.samples.map((s) => s.label);
    expect(labels).toEqual(
      expect.arrayContaining(['0.5', '1.5', '2.5', '254.5', '-0.6', '256.4']),
    );
  });

  it('sends ties to the even neighbour, unlike Math.round', () => {
    expect([0.5, 1.5, 2.5, 3.5].map(roundHalfToEven)).toEqual([0, 2, 2, 4]);
    expect([0.5, 1.5, 2.5, 3.5].map(Math.round)).toEqual([1, 2, 3, 4]);
  });

  it('rounds negative ties to even too (domain behaviour only)', () => {
    // Blending clamps to [0, 255] before quantizing, so negative inputs
    // never reach this from blend.ts. They are part of the function's
    // contract regardless.
    expect([-0.5, -1.5, -2.5].map(roundHalfToEven)).toEqual([0, -2, -2]);
    expect([-0.5, -1.5, -2.5].map(quantizeU8)).toEqual([0, 0, 0]);
  });
});

describe('alpha skip threshold', () => {
  // Filling with 0 keeps the blend visible after quantization: at these
  // alphas 0.002*255 = 0.51 rounds to 1, whereas a mid-grey fill would give
  // 200.11 -> 200 and a real blend would look identical to a skip.
  it.each([
    [0.0019, 0, 'below the threshold, left untouched'],
    [0.002, 1, 'exactly at the threshold, blended'],
    [0.0021, 1, 'above the threshold, blended'],
  ])('alpha %f -> %i (%s)', (alpha, expected) => {
    const image = rgb(1, 1, 0);
    addWatermarkRegion(image, flatAlpha(1, alpha), 1, 1, { x: 0, y: 0 });
    expect(image.data[0]).toBe(expected);
  });

  it('compares against the threshold in float32, matching upstream', () => {
    // Alpha always arrives as float32. float32(0.002) is slightly above the
    // double 0.002, so it must blend; one ulp below it must skip. This is
    // the boundary where a double-vs-float mismatch would first show.
    const atThreshold = rgb(1, 1, 0);
    addWatermarkRegion(atThreshold, new Float32Array([Math.fround(0.002)]), 1, 1, {
      x: 0,
      y: 0,
    });
    expect(atThreshold.data[0]).toBe(1);

    const justBelow = rgb(1, 1, 0);
    addWatermarkRegion(
      justBelow,
      new Float32Array([Math.fround(Math.fround(0.002) - 2.4e-10)]),
      1,
      1,
      { x: 0, y: 0 },
    );
    expect(justBelow.data[0]).toBe(0);
  });

  it('leaves skipped pixels byte-identical on removal too', () => {
    const image = rgb(1, 1, 137);
    removeWatermarkRegion(image, flatAlpha(1, 0.001), 1, 1, { x: 0, y: 0 });
    expect(Array.from(image.data)).toEqual([137, 137, 137]);
  });
});

describe('MAX_ALPHA ceiling — removal only', () => {
  // No calibrated source map reaches this: they peak at alpha 0.51. Only a
  // synthetic alpha can exercise the branch, which is why it is here and
  // not in the golden comparisons.
  const alpha = 0.995;

  it('removal divides by 1 - 0.99, not 1 - 0.995', () => {
    // The fill matters. At a mid-grey both the clamped and unclamped
    // results run far negative and saturate to 0, so the branch would be
    // invisible; 254 is high enough that both land in range and differ.
    const image = rgb(1, 1, 254);
    removeWatermarkRegion(image, flatAlpha(1, alpha), 1, 1, { x: 0, y: 0 });

    const clamped = quantizeU8((254 - 0.99 * 255) / (1 - 0.99));
    const unclamped = quantizeU8((254 - alpha * 255) / (1 - alpha));
    expect(clamped).not.toBe(unclamped);
    expect(image.data[0]).toBe(clamped);
  });

  it('addition uses the alpha as given, with no ceiling', () => {
    const image = rgb(1, 1, 0);
    addWatermarkRegion(image, flatAlpha(1, alpha), 1, 1, { x: 0, y: 0 });

    const withAlpha = quantizeU8(alpha * 255);
    const withCeiling = quantizeU8(0.99 * 255);
    expect(withAlpha).not.toBe(withCeiling);
    expect(image.data[0]).toBe(withAlpha);
  });
});

/**
 * Both directions get the full clipping matrix. blend.ts keeps the two
 * loops deliberately duplicated, so a fault in one is invisible to tests
 * that only drive the other — and the golden crops cannot cover this,
 * since their region sits comfortably inside the crop and never clips.
 */
describe.each([
  // Removal on a black image would drive every cell to 0 and destroy the
  // reverse lookup below; 200 keeps 13 of the 16 ramp cells unsaturated
  // and distinct, which is more than enough to pin the offset.
  ['removeWatermarkRegion', removeWatermarkRegion, 200] as const,
  ['addWatermarkRegion', addWatermarkRegion, 0] as const,
])('clipping to the image bounds — %s', (_name, blend, fill) => {
  const edge = 4;
  const expected = (alpha: Float32Array, index: number): number => {
    const a = alpha[index] ?? 0;
    return blend === removeWatermarkRegion
      ? quantizeU8((fill - a * 255) / (1 - a))
      : quantizeU8(a * 255 + (1 - a) * fill);
  };

  it.each([
    ['off the left edge', { x: -2, y: 0 }, 2, 4],
    ['off the top edge', { x: 0, y: -2 }, 4, 2],
    ['off the right edge', { x: 2, y: 0 }, 2, 4],
    ['off the bottom edge', { x: 0, y: 2 }, 4, 2],
  ])('blends only the overlap %s', (_label, position: Point, cols, rows) => {
    const image = rgb(edge, edge, fill);
    const alpha = rampAlpha(edge);
    blend(image, alpha, edge, edge, position);

    let blended = 0;
    for (let y = 0; y < edge; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const inside =
          x >= Math.max(0, position.x) &&
          x < Math.min(edge, position.x + edge) &&
          y >= Math.max(0, position.y) &&
          y < Math.min(edge, position.y + edge);
        const actual = image.data[(y * edge + x) * 3];
        if (!inside) {
          expect(actual).toBe(fill);
          continue;
        }
        blended += 1;
        // The alpha cell is offset by the position, exactly as upstream's
        // `alpha_roi(x1 - x, y1 - y, ...)` does.
        const alphaIndex = (y - position.y) * edge + (x - position.x);
        expect(actual).toBe(expected(alpha, alphaIndex));
      }
    }
    expect(blended).toBe(cols * rows);
  });

  it('is a no-op when the region misses the image entirely', () => {
    const image = rgb(edge, edge, 7);
    const before = Array.from(image.data);
    addWatermarkRegion(image, rampAlpha(edge), edge, edge, { x: 100, y: 100 });
    removeWatermarkRegion(image, rampAlpha(edge), edge, edge, { x: -edge, y: 0 });
    expect(Array.from(image.data)).toEqual(before);
  });
});

describe('channel handling', () => {
  it('blends all three colour channels of an RGB buffer', () => {
    const image = rgb(1, 1, 0);
    image.data.set([10, 20, 30]);
    addWatermarkRegion(image, flatAlpha(1, 0.5), 1, 1, { x: 0, y: 0 });
    expect(Array.from(image.data)).toEqual([
      quantizeU8(0.5 * 255 + 0.5 * 10),
      quantizeU8(0.5 * 255 + 0.5 * 20),
      quantizeU8(0.5 * 255 + 0.5 * 30),
    ]);
  });

  it('passes the alpha channel of an RGBA buffer through byte for byte', () => {
    const image: ImageBuffer = {
      data: Uint8Array.from([10, 20, 30, 42, 40, 50, 60, 99]),
      width: 2,
      height: 1,
      channels: 4,
    };
    addWatermarkRegion(image, new Float32Array([0.5, 0.5]), 2, 1, { x: 0, y: 0 });
    expect(image.data[3]).toBe(42);
    expect(image.data[7]).toBe(99);
    expect(image.data[0]).not.toBe(10);
    expect(image.data[4]).not.toBe(40);
  });
});

describe('input validation', () => {
  const alpha = flatAlpha(2, 0.5);
  const origin: Point = { x: 0, y: 0 };

  it('rejects a data buffer that disagrees with the dimensions', () => {
    const image: ImageBuffer = {
      data: new Uint8Array(5),
      width: 2,
      height: 2,
      channels: 3,
    };
    expect(() => removeWatermarkRegion(image, alpha, 2, 2, origin)).toThrow(RangeError);
    expect(() => removeWatermarkRegion(image, alpha, 2, 2, origin)).toThrow(
      /holds 5 bytes, expected 12 \(2x2x3\)/,
    );
  });

  it('rejects a channel count that is neither RGB nor RGBA', () => {
    const image = { ...rgb(2, 2), channels: 1 as unknown as 3 };
    expect(() => addWatermarkRegion(image, alpha, 2, 2, origin)).toThrow(
      /channels is 1, expected 3 \(RGB\) or 4 \(RGBA\)/,
    );
  });

  it('rejects an alpha buffer that disagrees with its dimensions', () => {
    expect(() => addWatermarkRegion(rgb(2, 2), new Float32Array(3), 2, 2, origin)).toThrow(
      /alpha holds 3 values, expected 4 \(2x2\)/,
    );
  });

  it('rejects a non-integer position rather than silently doing nothing', () => {
    // Upstream's position is a cv::Point; a fractional coordinate has no
    // meaning there, and without this check the clipping arithmetic would
    // quietly produce an empty region.
    for (const bad of [{ x: 1.5, y: 0 }, { x: 0, y: -2.25 }, { x: Number.NaN, y: 0 }]) {
      expect(() => removeWatermarkRegion(rgb(4, 4), alpha, 2, 2, bad)).toThrow(RangeError);
      expect(() => addWatermarkRegion(rgb(4, 4), alpha, 2, 2, bad)).toThrow(
        /position must have integer coordinates/,
      );
    }
  });
});

describe('add then remove round trip', () => {
  /**
   * Deterministic content: a 32-bit LCG (Numerical Recipes constants).
   * `Math.random` is unusable here — a test that fails one run in fifty is
   * worse than no test.
   */
  function lcgBytes(count: number, seed: number): Uint8Array {
    let state = seed >>> 0;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out[i] = state >>> 24;
    }
    return out;
  }

  const maps: ReadonlyArray<[WatermarkVariant, WatermarkSize, number]> = [
    ['V1', 'small', 48],
    ['V1', 'large', 96],
    ['V2', 'small', 36],
    ['V2', 'large', 96],
  ];

  it.each(maps)('%s %s recovers the original within one level', (variant, size, edge) => {
    const alpha = getSourceAlphaMap(variant, size);
    const original = lcgBytes(edge * edge * 3, 0x9e3779b9);
    const image: ImageBuffer = {
      data: original.slice(),
      width: edge,
      height: edge,
      channels: 3,
    };

    addWatermarkRegion(image, alpha, edge, edge, { x: 0, y: 0 });
    expect(Array.from(image.data)).not.toEqual(Array.from(original));
    removeWatermarkRegion(image, alpha, edge, edge, { x: 0, y: 0 });

    // The ±1 bound comes from the data, not the algebra: these maps peak
    // near alpha 0.51, where 1/(1-alpha) only doubles the half-level
    // quantization error. A synthetic alpha near the 0.99 ceiling would
    // amplify it a hundredfold and this bound would not hold.
    let worst = 0;
    for (let i = 0; i < original.length; i += 1) {
      worst = Math.max(worst, Math.abs((image.data[i] ?? 0) - (original[i] ?? 0)));
    }
    expect(worst).toBeLessThanOrEqual(1);
  });
});
