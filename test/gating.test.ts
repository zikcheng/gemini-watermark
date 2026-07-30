import { describe, expect, it } from 'vitest';

import { getSourceAlphaMap } from '../src/alpha-maps.js';
import { addWatermarkRegion } from '../src/blend.js';
import { detectWatermark } from '../src/detect.js';
import {
  fuseConfidence,
  meetsInternalLabel,
  passesThreshold,
  snapTrusted,
  spatialCircuitBroken,
  spatialRescued,
} from '../src/gating.js';
import { getWatermarkConfig, getWatermarkTopLeft } from '../src/position.js';
import type { ImageBuffer } from '../src/types.js';

/**
 * The decision points, tested at their boundaries.
 *
 * Every one of these is a threshold copied from the C++ source, and every
 * one is a place where "close enough" is the wrong idea: a score exactly
 * at 0.25 either breaks the circuit or does not, and only one of those
 * matches upstream. So each gets `<`, `==` and `>` rather than a
 * representative sample.
 *
 * They are pure functions on purpose — checking them here means the
 * manifest equivalence tests in M4 commit 3 can fail for one reason
 * (the pipeline) instead of two.
 */
describe('passesThreshold — the caller-facing gate', () => {
  it.each([
    [0.2499999, 0.25, false],
    [0.25, 0.25, true],
    [0.2500001, 0.25, true],
  ])('confidence %f against threshold %f -> %s', (confidence, threshold, expected) => {
    expect(passesThreshold(confidence, threshold)).toBe(expected);
  });

  it('holds at an arbitrary threshold, not just the default', () => {
    expect(passesThreshold(0.4, 0.4)).toBe(true);
    expect(passesThreshold(0.399999, 0.4)).toBe(false);
    expect(passesThreshold(1, 0)).toBe(true);
    expect(passesThreshold(0, 0)).toBe(true);
  });

  it('treats a circuit-broken negative confidence as an ordinary number', () => {
    // These arise for real: the breaker returns spatial*0.5 unclamped, and
    // the manifest has -0.087 and -0.0375 among its gate detections.
    expect(passesThreshold(-0.087, 0.25)).toBe(false);
    expect(passesThreshold(-0.087, -0.087)).toBe(true);
    expect(passesThreshold(-0.087, -0.1)).toBe(true);
  });
});

describe('spatialCircuitBroken — 0.25', () => {
  it.each([
    [0.2499999, true],
    [0.25, false],
    [0.2500001, false],
  ])('spatial %f -> %s', (spatial, expected) => {
    expect(spatialCircuitBroken(spatial)).toBe(expected);
  });

  it('breaks on the negative correlations clean images produce', () => {
    expect(spatialCircuitBroken(-0.174)).toBe(true);
    expect(spatialCircuitBroken(0)).toBe(true);
  });
});

describe('spatialRescued — 0.30', () => {
  it.each([
    [0.2999999, false],
    [0.3, true],
    [0.3000001, true],
  ])('spatial %f -> %s', (spatial, expected) => {
    expect(spatialRescued(spatial)).toBe(expected);
  });
});

describe('meetsInternalLabel — 0.35', () => {
  it.each([
    [0.3499999, false],
    [0.35, true],
    [0.3500001, true],
  ])('confidence %f -> %s', (confidence, expected) => {
    expect(meetsInternalLabel(confidence)).toBe(expected);
  });
});

describe('snapTrusted — 0.60', () => {
  it.each([
    [0.5999999, false],
    [0.6, true],
    [0.6000001, true],
  ])('spatial %f -> %s', (spatial, expected) => {
    expect(snapTrusted(spatial)).toBe(expected);
  });
});

describe('fuseConfidence', () => {
  it('weights the three stages 0.50 / 0.30 / 0.20', () => {
    // Below the rescue threshold, so the weighted sum stands alone.
    expect(fuseConfidence(0.2, 0.1, 0.05)).toBeCloseTo(0.2 * 0.5 + 0.1 * 0.3 + 0.05 * 0.2, 12);
  });

  it('clamps the weighted sum into [0, 1] before the rescue', () => {
    expect(fuseConfidence(0, -1, -1)).toBe(0);
    expect(fuseConfidence(1, 1, 1)).toBe(1);
  });

  it('lifts a collapsed fusion to the spatial score once rescued', () => {
    // The busy-background case: stages 2 and 3 near zero drag the sum to
    // 0.20, but an anchored 0.40 spatial match is unambiguous.
    expect(fuseConfidence(0.4, 0, 0)).toBe(0.4);
    // Just below the rescue line the sum stands, collapsed or not.
    expect(fuseConfidence(0.2999999, 0, 0)).toBeCloseTo(0.14999995, 12);
  });

  it('never lowers a fusion that already beats the spatial score', () => {
    // Rescue takes the max, so a strong gradient and variance are kept.
    expect(fuseConfidence(0.5, 1, 1)).toBeCloseTo(0.75, 12);
  });

  it('reproduces the manifest circuit-broken-adjacent cases', () => {
    // v2-small-1024x572: spatial 0.327 rescues over a 0.199 fusion.
    expect(fuseConfidence(0.3273, 0.1168, 0)).toBeCloseTo(0.3273, 6);
    // v2-large-2752x1536-hard: 0.2646 is below the rescue line, so the
    // weighted sum stands — this is the case upstream itself misses.
    // 0.2646*0.5 + 0.1*0.3 + 0.0078*0.2 = 0.16386, which is the 0.164 the
    // manifest records at its three decimals.
    expect(fuseConfidence(0.2646, 0.1, 0.0078)).toBeCloseTo(0.16386, 5);
  });
});

describe('detectWatermark wiring', () => {
  // Manifest equivalence is M4 commit 3's job. This only checks that the
  // pieces are connected: shapes come back contracted, and invalid input
  // is refused rather than producing nonsense.
  const solid = (width: number, height: number, fill: number): ImageBuffer => ({
    data: new Uint8Array(width * height * 3).fill(fill),
    width,
    height,
    channels: 3,
  });

  it('returns a contracted result for both variants', () => {
    for (const variant of ['V1', 'V2'] as const) {
      const result = detectWatermark(solid(1024, 572, 120), { variant });
      expect(result.variant).toBe(variant);
      expect(result.size).toBe('small');
      expect(result.region.width).toBeGreaterThan(0);
      expect(result.region.height).toBe(result.region.width);
      expect(Number.isFinite(result.confidence)).toBe(true);
      expect(Number.isFinite(result.scores.spatial)).toBe(true);
    }
  });

  it('breaks the circuit on a flat image and reports it', () => {
    // A constant region correlates at 0 against a varying template, which
    // is below the breaker — and the confidence is that score halved.
    const result = detectWatermark(solid(1024, 572, 200));
    expect(result.circuitBreaker).toBe(true);
    expect(result.scores.spatial).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.internalDetected).toBe(false);
    expect(result.scores.gradient).toBe(0);
    expect(result.scores.variance).toBe(0);
  });

  it('lets a circuit-broken confidence go negative', () => {
    // A solid image scores exactly 0, which cannot tell an unclamped
    // result from a clamped one. This paints the inverse of the alpha map
    // into the watermark region instead, so stage 1 anti-correlates and
    // the halved score is genuinely below zero — the property upstream
    // has by omission (it never clamps this path) and that the manifest
    // shows for real at -0.087 and -0.0375.
    const width = 1024;
    const height = 572;
    const image = solid(width, height, 128);
    const alpha = getSourceAlphaMap('V2', 'small');
    const edge = 36;
    const config = getWatermarkConfig(width, height, 'V2');
    const { x, y } = getWatermarkTopLeft(config, width, height);
    for (let row = 0; row < edge; row += 1) {
      for (let col = 0; col < edge; col += 1) {
        const value = Math.round((1 - (alpha[row * edge + col] ?? 0)) * 255);
        const at = ((y + row) * width + (x + col)) * 3;
        image.data[at] = value;
        image.data[at + 1] = value;
        image.data[at + 2] = value;
      }
    }

    const result = detectWatermark(image, { variant: 'V2' });
    expect(result.circuitBreaker).toBe(true);
    expect(result.scores.spatial).toBeLessThan(0);
    expect(result.confidence).toBeLessThan(0);
    expect(result.confidence).toBeCloseTo(result.scores.spatial * 0.5, 12);
  });

  it('never sweeps for V1, even at small size', () => {
    // The sweep is V2-small only. Dropping the variant half of that
    // condition leaves every other test green — the scores shift but
    // nothing asserts on them here — so this pins it directly.
    //
    // The image carries a real V1 watermark deliberately painted two
    // pixels right and one down of the formula position. With the sweep
    // off (correct) the reported region is the formula position
    // regardless; with it on, the strong correlation at the true location
    // would pass the 0.60 trust gate and move the region there.
    const width = 800;
    const height = 600;
    const image = solid(width, height, 90);
    const config = getWatermarkConfig(width, height, 'V1');
    const formula = getWatermarkTopLeft(config, width, height);
    const alpha = getSourceAlphaMap('V1', 'small');
    addWatermarkRegion(image, alpha, 48, 48, { x: formula.x + 2, y: formula.y + 1 });

    const result = detectWatermark(image, { variant: 'V1' });
    expect(result.size).toBe('small');
    expect(result.region.x).toBe(formula.x);
    expect(result.region.y).toBe(formula.y);
    expect(result.region.width).toBe(48);
    // The offset watermark still correlates well enough that a sweep
    // would have been trusted — otherwise the assertion above would pass
    // for the wrong reason.
    expect(result.scores.spatial).toBeGreaterThan(0.6);
  });

  it('honours a forced size, template and all', () => {
    // Forcing large on a small image resolves the 96px template, the
    // quirk recorded in DEVIATIONS D3.
    expect(detectWatermark(solid(1024, 572, 120), { size: 'large' }).region.width).toBe(96);
    expect(detectWatermark(solid(1024, 572, 120)).region.width).toBe(36);
  });

  it('rejects malformed buffers', () => {
    expect(() => detectWatermark({ ...solid(4, 4, 0), width: 5 })).toThrow(RangeError);
    expect(() =>
      detectWatermark({ data: new Uint8Array(4), width: 2, height: 2, channels: 1 as unknown as 3 }),
    ).toThrow(/channels is 1/);
    expect(() => detectWatermark(solid(0, 4, 0))).toThrow(/dimensions must be positive/);
  });
});
