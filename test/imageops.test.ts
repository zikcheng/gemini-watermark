import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { meanStdDev, toGrayscale } from '../src/imageops.js';
import type { ImageBuffer } from '../src/types.js';
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
