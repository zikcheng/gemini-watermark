/**
 * The detection suite on whole images, against the binary's own output.
 *
 * `test/detect-manifest.test.ts` proves the same decisions in CI from the
 * committed patches. This repeats them on the full-size fixtures, where a
 * mistake the patches cannot expose would show: the patch is a window
 * around the watermark, so anything that depends on pixels outside it —
 * a stage-3 reference strip reaching further than expected, an ROI clamp
 * measured from the wrong edge, a stride error over a 2752-wide row — is
 * only really tested here.
 *
 * It also adds what the manifest cannot carry: the pixels. A green decision
 * with a wrong removal position still writes the wrong image, so
 * `processImage`'s output is compared byte for byte against
 * `golden/default/`. Run with `npm run test:golden`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectWatermark } from '../../src/detect.js';
import { processImage } from '../../src/pipeline.js';
import type { ImageBuffer } from '../../src/types.js';
import { requireReferenceDir } from '../helpers/golden.js';
import {
  detectionCases,
  expectDetectionMatches,
  expectPipelineMatches,
  splitDetections,
  wasProcessed,
} from '../helpers/manifest.js';
import { compareRegion, firstDifference } from '../helpers/pixels.js';
import { decodePng } from '../helpers/png.js';

const kit = requireReferenceDir();

const cases = detectionCases();

/**
 * The port has no JPEG decoder by design (the kit emits
 * decode-normalized PNGs, the TS side never decodes JPEG), and this is the
 * one fixture whose input is a `.jpg`. Its committed patch was cut from
 * cv2-decoded pixels, so CI covers its decisions — the same arrangement
 * `test/golden/blend-full.test.ts` already uses.
 */
const NO_DECODER = 'v2-large-2752x1536-q90';

const readPng = (path: string): ImageBuffer => decodePng(new Uint8Array(readFileSync(path)));

const watermarkedPath = (name: string): string =>
  join(kit, 'fixtures', 'watermarked', `${name}.png`);
const goldenDefaultPath = (name: string): string => join(kit, 'golden', 'default', `${name}.png`);

const runnable = cases.filter((c) => c.name !== NO_DECODER);

describe('detectWatermark on full images', () => {
  let asserted = 0;

  for (const entry of runnable) {
    const { all } = splitDetections(entry);

    it(`${entry.name} reproduces all ${all.length} logged detections`, () => {
      const image = readPng(watermarkedPath(entry.name));
      expect(image.width, `${entry.name} width`).toBe(entry.input.width);
      expect(image.height, `${entry.name} height`).toBe(entry.input.height);

      for (const [index, expected] of all.entries()) {
        const actual = detectWatermark(image, { variant: expected.variant });
        expectDetectionMatches(actual, expected, `${entry.name} detection ${index}`);
        asserted += 1;
      }
    });
  }

  it('accounts for every detection-eligible case', () => {
    expect(cases).toHaveLength(14);
    expect(runnable).toHaveLength(13);
    expect(asserted).toBe(runnable.reduce((n, c) => n + splitDetections(c).all.length, 0));
  });
});

describe('processImage on full images, against golden/default', () => {
  const compared: string[] = [];

  for (const entry of runnable) {
    const processed = wasProcessed(entry);

    it(`${entry.name} ${processed ? 'reproduces the golden output' : 'skips and touches nothing'}`, () => {
      const image = readPng(watermarkedPath(entry.name));
      const before = Uint8Array.from(image.data);

      const result = processImage(image);
      expectPipelineMatches(result, entry);

      const goldenPath = goldenDefaultPath(entry.name);
      if (!processed) {
        // A skipped run writes no file at all, so the absence is part of
        // the oracle rather than a gap in it.
        expect(existsSync(goldenPath), `${goldenPath} should not exist`).toBe(false);
        const changedAt = firstDifference(image.data, before);
        expect(changedAt, `${entry.name} modified byte ${changedAt}`).toBe(-1);
        compared.push(entry.name);
        return;
      }

      const golden = readPng(goldenPath);
      const region = result.region;
      expect(region, `${entry.name} reports a region`).toBeDefined();
      const { insideMax, outsideDiffering } = compareRegion(
        image,
        golden,
        region as NonNullable<typeof region>,
      );
      // Outside the removal region nothing may move at all; inside, CLAUDE.md
      // allows the ±1 the float-width difference can cost (DEVIATIONS D4).
      expect(outsideDiffering, `${entry.name} channels changed outside the region`).toBe(0);
      expect(insideMax, `${entry.name} max deviation inside the region`).toBeLessThanOrEqual(1);
      compared.push(entry.name);
    });
  }

  it('compared every runnable case', () => {
    expect(compared).toHaveLength(13);
    expect(new Set(compared).size).toBe(13);
    // The one case left out is the JPEG input, and only that one.
    expect(cases.map((c) => c.name).filter((n) => !compared.includes(n))).toEqual([NO_DECODER]);
  });
});

/**
 * The threshold regression from the CI suite, repeated where the pixels are
 * real. Both cases clear the default gate at 0.324 and 0.327, so a
 * threshold between them must separate them — and the one that processes
 * must still land on the golden output, not merely report success.
 */
describe('threshold regression on full images', () => {
  const lower = 'v2-small-1376x768'; // conf 0.324
  const higher = 'v2-small-1024x572'; // conf 0.327

  it('separates the two at 0.326, and the processed one still matches golden', () => {
    const low = readPng(watermarkedPath(lower));
    const lowBefore = Uint8Array.from(low.data);
    expect(processImage(low, { threshold: 0.326 }).status).toBe('skipped');
    expect(firstDifference(low.data, lowBefore), `${lower} was modified`).toBe(-1);

    const high = readPng(watermarkedPath(higher));
    const result = processImage(high, { threshold: 0.326 });
    expect(result.status).toBe('processed');
    const { insideMax, outsideDiffering } = compareRegion(
      high,
      readPng(goldenDefaultPath(higher)),
      result.region as NonNullable<typeof result.region>,
    );
    expect(outsideDiffering).toBe(0);
    expect(insideMax).toBeLessThanOrEqual(1);
  });

  it('skips both at 0.40', () => {
    for (const name of [lower, higher]) {
      const image = readPng(watermarkedPath(name));
      const before = Uint8Array.from(image.data);
      expect(processImage(image, { threshold: 0.4 }).status, name).toBe('skipped');
      expect(firstDifference(image.data, before), `${name} was modified`).toBe(-1);
    }
  });
});
