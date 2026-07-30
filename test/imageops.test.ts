import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  matchTemplateCcoeffNormed,
  meanStdDev,
  sobelMagnitude,
  toGrayscale,
} from '../src/imageops.js';
import { getSourceAlphaMap } from '../src/alpha-maps.js';
import type { ImageBuffer, WatermarkSize } from '../src/types.js';
import {
  DumpReader,
  casePath,
  withinDualTolerance,
} from './helpers/imageops-dump.js';
import { decodePng } from './helpers/png.js';

/**
 * Operator equivalence against the pinned cv2, via the committed dumps.
 *
 * Two shapes of input appear. Real cases name a PNG under
 * `test/data/cases/`, which the test decodes to RGB — the same pixels cv2
 * read as BGR, since `decodePng` and `cv2.imread` differ only in channel
 * order. Synthetic cases have their input bytes in the dump itself, in
 * cv2's BGR layout, so the test reverses each pixel's channels to get the
 * RGB buffer this port works in.
 */
const PLAN_ABS_TOL = 1e-6;
const PLAN_REL_TOL = 1e-5;

/** `absErr <= 1e-6 + 1e-5 * |expected|` — PLAN.md, cv2-dump operators. */
function expectWithinPlanTolerance(actual: number, expected: number, what: string): void {
  const ok = withinDualTolerance(actual, expected, PLAN_ABS_TOL, PLAN_REL_TOL);
  expect(
    ok,
    `${what}: |${actual} - ${expected}| = ${Math.abs(actual - expected)} exceeds ` +
      `${PLAN_ABS_TOL} + ${PLAN_REL_TOL}*|expected|`,
  ).toBe(true);
}

interface GrayInput {
  label: string;
  source: { kind: string; path?: string };
  height: number;
  width: number;
  channel_order: string;
  output: string;
}

const grayDump = new DumpReader('bgr2gray');
const grayInputs = grayDump.entries<GrayInput>('inputs');

/** The RGB buffer this port would receive for one dump input. */
function rgbInput(entry: GrayInput): ImageBuffer {
  expect(entry.channel_order, 'dump input is documented as BGR').toBe('BGR');

  if (entry.source.kind === 'case_file' && entry.source.path !== undefined) {
    // decodePng yields RGB; cv2 read the same file as BGR.
    return decodePng(new Uint8Array(readFileSync(casePath(entry.source.path))));
  }

  // Synthetic input: stored as cv2 saw it, so reverse each pixel.
  const bgr = grayDump.uint8(`${entry.label}-input`);
  const data = new Uint8Array(bgr.data.length);
  for (let i = 0; i < bgr.data.length; i += 3) {
    data[i] = bgr.data[i + 2] ?? 0;
    data[i + 1] = bgr.data[i + 1] ?? 0;
    data[i + 2] = bgr.data[i] ?? 0;
  }
  return { data, width: entry.width, height: entry.height, channels: 3 };
}

describe('toGrayscale vs cv2 COLOR_BGR2GRAY', () => {
  it.each(grayInputs.map((entry) => [entry.label, entry] as const))(
    '%s is byte-identical',
    (_label, entry) => {
      const expected = grayDump.uint8(entry.output);
      const actual = toGrayscale(rgbInput(entry));

      expect(actual).toHaveLength(expected.data.length);
      // Byte-exact is the bar here, not a tolerance: the operator is
      // integer arithmetic on both sides. A mismatch means the channel
      // order or a coefficient is wrong — check those before considering
      // a platform difference (M3.md).
      let differing = 0;
      let firstAt = -1;
      for (let i = 0; i < expected.data.length; i += 1) {
        if (actual[i] !== expected.data[i]) {
          differing += 1;
          if (firstAt < 0) firstAt = i;
        }
      }
      expect(
        differing,
        differing === 0
          ? ''
          : `first mismatch at index ${firstAt}: got ${String(actual[firstAt])}, ` +
            `expected ${String(expected.data[firstAt])}`,
      ).toBe(0);
    },
  );

  it('exercises the whole 0..255 range on the synthetic input', () => {
    // This case and the real crops catch different faults, which is why
    // both are here. The synthetic image is built so no two channels ever
    // share a value at the same pixel, so a channel mix-up moves every
    // pixel: swapping R and B changes all 256 of them, against 27.4%,
    // 65.1% and 96.9% on the photographic crops. A sub-LSB coefficient
    // drift (9798 -> 9799) is the opposite kind of fault — it only shows
    // where a pixel already sits on a rounding boundary, which is a
    // property of content, not of size: the largest crop (12544 px) misses
    // it entirely while both smaller ones catch it.
    const entry = grayInputs.find((e) => e.label === 'synthetic-16x16');
    expect(entry, 'dump must carry the synthetic full-range case').toBeDefined();
    const image = rgbInput(entry as GrayInput);
    for (let channel = 0; channel < 3; channel += 1) {
      const seen = new Set<number>();
      for (let i = channel; i < image.data.length; i += 3) seen.add(image.data[i] ?? -1);
      expect(seen.size).toBe(256);
    }
  });

  it('leaves the alpha channel of an RGBA buffer out of the luma', () => {
    const rgb: ImageBuffer = {
      data: Uint8Array.from([10, 20, 30, 200, 100, 150]),
      width: 2,
      height: 1,
      channels: 3,
    };
    const rgba: ImageBuffer = {
      data: Uint8Array.from([10, 20, 30, 7, 200, 100, 150, 250]),
      width: 2,
      height: 1,
      channels: 4,
    };
    expect(Array.from(toGrayscale(rgba))).toEqual(Array.from(toGrayscale(rgb)));
  });

  it('rejects malformed buffers', () => {
    expect(() =>
      toGrayscale({ data: new Uint8Array(5), width: 2, height: 2, channels: 3 }),
    ).toThrow(/holds 5 bytes, expected 12/);
    expect(() =>
      toGrayscale({
        data: new Uint8Array(4),
        width: 2,
        height: 2,
        channels: 1 as unknown as 3,
      }),
    ).toThrow(/channels is 1/);
  });
});

interface StatSample {
  label: string;
  source: { kind: string; path?: string };
  dtype: string;
  mean: number;
  stddev: number;
}

describe('meanStdDev vs cv2', () => {
  const statsDump = new DumpReader('mean-stddev');
  const samples = statsDump.entries<StatSample>('samples');
  const sobelDump = new DumpReader('sobel-magnitude');

  it.each(samples.map((s) => [s.label, s] as const))(
    '%s matches within the dual tolerance',
    (_label, sample) => {
      let data: Float32Array | Uint8Array;
      if (sample.dtype === 'float32') {
        // The one float input: the V2 96px alpha map, dumped alongside the
        // Sobel arrays.
        data = sobelDump.float32('v2-96-alpha').data;
      } else {
        const entry = grayInputs.find((e) => e.label === sample.label);
        expect(entry, `no grayscale input for ${sample.label}`).toBeDefined();
        // Upstream measures the uint8 gray, not the /255 float — feeding
        // the float here would divide the deviation by 255.
        data = toGrayscale(rgbInput(entry as GrayInput));
      }

      const actual = meanStdDev(data);
      expectWithinPlanTolerance(actual.mean, sample.mean, `${sample.label} mean`);
      expectWithinPlanTolerance(actual.std, sample.stddev, `${sample.label} std`);
    },
  );

  it('uses the population divisor, as OpenCV does', () => {
    // [0,2] has population std 1 and sample std sqrt(2); nothing else
    // distinguishes the two definitions so directly.
    const { mean, std } = meanStdDev(Uint8Array.from([0, 2]));
    expect(mean).toBe(1);
    // Population std is 1 here; the sample form would give sqrt(2). The
    // exact assertion above already separates them.
    expect(std).toBe(1);
  });

  it('reports zero deviation for constant data', () => {
    const { mean, std } = meanStdDev(new Float32Array(16).fill(0.25));
    expect(mean).toBe(0.25);
    expect(std).toBe(0);
  });

  it('rejects an empty input', () => {
    expect(() => meanStdDev(new Float32Array(0))).toThrow(RangeError);
    expect(() => meanStdDev(new Uint8Array(0))).toThrow(/at least one sample/);
  });
});

interface SobelInput {
  label: string;
  input: string;
  output: string;
}

describe('sobelMagnitude vs cv2 Sobel + magnitude', () => {
  const dump = new DumpReader('sobel-magnitude');
  const inputs = dump.entries<SobelInput>('inputs');

  it.each(inputs.map((entry) => [entry.label, entry] as const))(
    '%s matches within the dual tolerance',
    (_label, entry) => {
      // The input comes from the dump, not from recomputing gray/255 here.
      // OpenCV scales in a float32 work type and this port divides in
      // float64, which disagree by one ulp on about half the byte values
      // (DEVIATIONS D4) — recomputing would fold that difference into the
      // operator's error budget and test the wrong thing.
      const source = dump.float32(entry.input);
      const expected = dump.float32(entry.output);

      const actual = sobelMagnitude(source.data, source.width, source.height);
      expect(actual).toHaveLength(expected.data.length);

      let worst = 0;
      let worstAt = -1;
      for (let i = 0; i < expected.data.length; i += 1) {
        const want = expected.data[i] ?? 0;
        const got = actual[i] ?? 0;
        if (!withinDualTolerance(got, want, PLAN_ABS_TOL, PLAN_REL_TOL)) {
          const error = Math.abs(got - want);
          if (error > worst) {
            worst = error;
            worstAt = i;
          }
        }
      }
      expect(
        worstAt,
        worstAt < 0
          ? ''
          : `worst mismatch at ${worstAt}: got ${String(actual[worstAt])}, ` +
            `expected ${String(expected.data[worstAt])}`,
      ).toBe(-1);
    },
  );

  it('reflects the border without repeating the edge sample', () => {
    // BORDER_REFLECT_101 on a horizontal ramp: the left column sees
    // [1, 0, 1] across, so its horizontal gradient cancels to zero, while
    // BORDER_REPLICATE would see [0, 0, 1] and leave a non-zero edge.
    const width = 4;
    const height = 3;
    const ramp = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) ramp[y * width + x] = x;
    }
    const magnitude = sobelMagnitude(ramp, width, height);
    expect(magnitude[width]).toBe(0);
    expect(magnitude[width + 1]).toBeGreaterThan(0);
  });

  it('rejects a buffer that disagrees with its dimensions', () => {
    expect(() => sobelMagnitude(new Float32Array(5), 2, 2)).toThrow(
      /holds 5 values, expected 4/,
    );
  });
});

interface NccCase {
  label: string;
  note: string;
  source: { kind: string; path?: string; template?: string };
  image_shape: number[];
  template_shape: number[];
  result: string;
  min: number;
  max: number;
  nonfinite_count: number;
}

describe('matchTemplateCcoeffNormed vs cv2 TM_CCOEFF_NORMED', () => {
  const dump = new DumpReader('match-template-ccoeff-normed');
  const cases = dump.entries<NccCase>('cases');
  const NCC_ABS_TOL = 1e-4;

  const real = cases.filter((c) => c.source.kind === 'case_file');
  const degenerate = cases.filter((c) => c.source.kind !== 'case_file');

  /**
   * The alpha template cv2 was given, taken from the port's own baked maps.
   *
   * The dump names the capture file rather than storing the template, and
   * M1 already proved the baked module reproduces those captures byte for
   * byte — so this is the same data, and using it exercises the seam
   * between the two modules as a bonus.
   */
  function alphaTemplateFor(entry: NccCase): {
    data: Float32Array;
    width: number;
    height: number;
  } {
    const [height = 0, width = 0] = entry.template_shape;
    const size: WatermarkSize = width === 96 ? 'large' : 'small';
    expect(entry.source.template, 'dump names a V2 capture').toMatch(/^bg_b_/);
    const data = getSourceAlphaMap('V2', size);
    expect(data).toHaveLength(width * height);
    return { data, width, height };
  }

  /** The synthetic operands for one degenerate case. */
  function degenerateOperands(entry: NccCase): {
    image: { data: Float32Array; width: number; height: number };
    template: { data: Float32Array; width: number; height: number };
  } {
    const template = entry.label.includes('varied-template')
      ? dump.float32('degenerate-varied-template')
      : dump.float32('degenerate-constant-template');

    if (entry.label.startsWith('single-pixel-perturbation')) {
      return { image: dump.float32('degenerate-perturbed-image'), template };
    }
    if (entry.label === 'varied-image-constant-template') {
      // The one operand the dump does not store: cv2 was handed the 4x4
      // ramp upscaled 3x by nearest-neighbour repetition, so it is rebuilt
      // from the stored ramp.
      //
      // Its *values* carry no weight in this case — the template is
      // constant, so the implementation returns 1 everywhere before it
      // ever reads the image, and zeroing or transposing this
      // reconstruction leaves all 32 tests green. Only its dimensions
      // matter, and those the result-shape assertion pins. The array is
      // slated to be dumped properly at M3 close, at which point this
      // rebuild goes away.
      const ramp = dump.float32('degenerate-varied-template');
      const [rows = 0, cols = 0] = ramp.shape;
      const width = cols * 3;
      const height = rows * 3;
      const data = new Float32Array(width * height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          data[y * width + x] =
            ramp.data[Math.floor(y / 3) * cols + Math.floor(x / 3)] ?? 0;
        }
      }
      return { image: { data, width, height }, template };
    }
    return { image: dump.float32('degenerate-flat-image'), template };
  }

  it.each(real.map((c) => [c.label, c] as const))(
    '%s (real pair) matches within 1e-4',
    (label, entry) => {
      const image = dump.float32(`${label}-gray-f32`);
      const template = alphaTemplateFor(entry);
      const expected = dump.float32(entry.result);

      const actual = matchTemplateCcoeffNormed(
        image.data,
        image.width,
        image.height,
        template.data,
        template.width,
        template.height,
      );

      expect(actual).toHaveLength(expected.data.length);
      let worst = 0;
      for (let i = 0; i < expected.data.length; i += 1) {
        worst = Math.max(worst, Math.abs((actual[i] ?? 0) - (expected.data[i] ?? 0)));
      }
      expect(worst, `worst absolute error ${worst}`).toBeLessThanOrEqual(NCC_ABS_TOL);
    },
  );

  it.each(degenerate.map((c) => [c.label, c] as const))(
    '%s reproduces the measured degenerate behaviour exactly',
    (_label, entry) => {
      const { image, template } = degenerateOperands(entry);
      const expected = dump.float32(entry.result);
      const actual = matchTemplateCcoeffNormed(
        image.data,
        image.width,
        image.height,
        template.data,
        template.width,
        template.height,
      );

      // Two different bars, applied per element. Where cv2 returned the
      // guard's constants — exactly 0 or exactly 1 — the port must return
      // the same constant, not something close: that is the calibrated
      // semantics, and a near miss would mean the guard is wrong or
      // missing. Everywhere else cv2 genuinely computed a correlation, so
      // the usual NCC tolerance applies (this dump's near-degenerate case
      // mixes both: 65 guard zeros and 16 computed values).
      let guarded = 0;
      let computed = 0;
      let worst = 0;
      for (let i = 0; i < expected.data.length; i += 1) {
        const want = expected.data[i] ?? 0;
        const got = actual[i] ?? 0;
        if (want === 0 || want === 1) {
          guarded += 1;
          expect(got, `window ${i} should be exactly ${want}`).toBe(want);
        } else {
          computed += 1;
          worst = Math.max(worst, Math.abs(got - want));
        }
      }
      expect(worst, `worst computed error ${worst}`).toBeLessThanOrEqual(NCC_ABS_TOL);
      expect(guarded + computed).toBe(expected.data.length);
      expect(actual.every((v) => Number.isFinite(v)), 'no NaN or Infinity').toBe(true);
      expect(entry.nonfinite_count, 'cv2 produced no non-finite values either').toBe(0);
    },
  );

  it('answers 1 for a constant template and 0 for a flat window', () => {
    // The asymmetry stated explicitly, independent of the dump plumbing:
    // whichever side loses its variance decides the answer, and the
    // template is checked first.
    const varied = Float32Array.from({ length: 36 }, (_, i) => i / 36);
    const flat = new Float32Array(36).fill(0.5);
    const constantTemplate = new Float32Array(4).fill(0.5);
    const variedTemplate = Float32Array.from([0, 0.25, 0.5, 1]);

    expect(Array.from(matchTemplateCcoeffNormed(varied, 6, 6, constantTemplate, 2, 2))).toEqual(
      new Array(25).fill(1),
    );
    expect(Array.from(matchTemplateCcoeffNormed(flat, 6, 6, variedTemplate, 2, 2))).toEqual(
      new Array(25).fill(0),
    );
    expect(Array.from(matchTemplateCcoeffNormed(flat, 6, 6, constantTemplate, 2, 2))).toEqual(
      new Array(25).fill(1),
    );
  });

  it('scores a perfect self-match at 1', () => {
    const image = Float32Array.from({ length: 25 }, (_, i) => (i * 7) % 11);
    const template = new Float32Array(9);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) template[y * 3 + x] = image[(y + 1) * 5 + (x + 1)] ?? 0;
    }
    const result = matchTemplateCcoeffNormed(image, 5, 5, template, 3, 3);
    expect(Math.abs((result[1 * 3 + 1] ?? 0) - 1)).toBeLessThan(1e-6);
  });

  it('rejects operands that do not fit', () => {
    expect(() =>
      matchTemplateCcoeffNormed(new Float32Array(4), 2, 2, new Float32Array(9), 3, 3),
    ).toThrow(/does not fit inside image 2x2/);
    expect(() =>
      matchTemplateCcoeffNormed(new Float32Array(3), 2, 2, new Float32Array(1), 1, 1),
    ).toThrow(/image holds 3 values, expected 4/);
  });
});
