import { describe, expect, it } from 'vitest';

import { getSourceAlphaMap } from '../src/alpha-maps.js';
import { addWatermarkRegion } from '../src/blend.js';
import type { ImageBuffer } from '../src/types.js';
import {
  VIDEO_LOGO_SIZE,
  VIDEO_MARGIN,
  createVideoCalibrator,
  getVideoWatermarkConfig,
  removeVideoWatermark,
} from '../src/video.js';

/**
 * The video module is an extension with no upstream oracle (see the
 * provenance notes in src/video.ts), so these tests work the other
 * direction from the port's: build synthetic videos where the ground
 * truth is known exactly — watermark forward-blended by our own
 * `addWatermarkRegion` — and require calibration and removal to recover
 * it. The tolerances are derived, not tuned:
 *
 *   - With N frames of background noise of amplitude ±A levels, the
 *     temporal mean's noise is ≤ A/√N per channel, and the alpha read
 *     from `(mean − bg)/(255 − bg)` inherits ≤ A/(√N·(255 − bg)).
 *     For A=8, N=96, bg≤160 that is under 0.009; the harmonic-fill bias
 *     on a smooth background stays of the same order, so 0.03 per cell
 *     is a comfortable-but-honest budget.
 *   - Removal error is alpha error amplified by (255−bg)/(1−alpha) plus
 *     the ±1 quantization round trip; with peak alpha ~0.33 and the
 *     budgets above that stays within ±4 levels.
 */

/** Deterministic LCG (numerical recipes constants), byte output. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

const WIDTH = 320;
const HEIGHT = 280;

/**
 * A background frame with smooth spatial structure, temporal drift, and
 * per-pixel noise of amplitude ±8 levels. The drift term moves the
 * pattern a few pixels per frame — the motion the estimator relies on.
 */
function backgroundFrame(t: number, rng: () => number): ImageBuffer {
  const data = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const base =
        100 +
        45 * Math.sin((x + 3 * t) / 23) * Math.cos((y - 2 * t) / 31) +
        20 * Math.sin((x + y + 5 * t) / 57);
      const offset = (y * WIDTH + x) * 3;
      for (let c = 0; c < 3; c += 1) {
        const noise = (rng() % 17) - 8;
        const value = base + 8 * c + noise;
        data[offset + c] = value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value);
      }
    }
  }
  return { data, width: WIDTH, height: HEIGHT, channels: 3 };
}

/** The ground-truth video watermark: V1-48 at the measured ~0.57 opacity. */
function trueAlpha(gain = 0.573): Float32Array {
  const template = getSourceAlphaMap('V1', 'small');
  const alpha = new Float32Array(template.length);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = (template[i] ?? 0) * gain;
  return alpha;
}

describe('getVideoWatermarkConfig', () => {
  it('places the 48px logo 96px from the right and bottom edges', () => {
    expect(getVideoWatermarkConfig(1280, 720).position).toEqual({ x: 1136, y: 576 });
    expect(getVideoWatermarkConfig(720, 1280).position).toEqual({ x: 576, y: 1136 });
    expect(getVideoWatermarkConfig(1280, 720).logoSize).toBe(VIDEO_LOGO_SIZE);
  });

  it('centers the calibration window on the logo box', () => {
    const config = getVideoWatermarkConfig(1280, 720);
    const pad = (config.windowSize - config.logoSize) / 2;
    expect(config.windowOrigin).toEqual({
      x: config.position.x - pad,
      y: config.position.y - pad,
    });
  });

  it('rejects frames too small for the calibration window', () => {
    // 190 is the exact minimum: margin 96 + logo 48 + window pad 46.
    expect(() => getVideoWatermarkConfig(189, 280)).toThrow(RangeError);
    expect(() => getVideoWatermarkConfig(320, 189)).toThrow(RangeError);
    expect(() => getVideoWatermarkConfig(190, 190)).not.toThrow();
  });

  it('rejects non-integer dimensions', () => {
    expect(() => getVideoWatermarkConfig(320.5, 280)).toThrow(RangeError);
  });

  it('exposes the measured geometry constants', () => {
    expect(VIDEO_LOGO_SIZE).toBe(48);
    expect(VIDEO_MARGIN).toBe(96);
  });
});

describe('createVideoCalibrator — input validation', () => {
  it('rejects frames of the wrong dimensions', () => {
    const calibrator = createVideoCalibrator(WIDTH, HEIGHT);
    expect(() =>
      calibrator.addFrame({
        data: new Uint8Array(64 * 64 * 3),
        width: 64,
        height: 64,
        channels: 3,
      }),
    ).toThrow(RangeError);
  });

  it('rejects buffers whose byte length disagrees with the header', () => {
    const calibrator = createVideoCalibrator(WIDTH, HEIGHT);
    expect(() =>
      calibrator.addFrame({
        data: new Uint8Array(7),
        width: WIDTH,
        height: HEIGHT,
        channels: 3,
      }),
    ).toThrow(RangeError);
  });

  it('refuses to calibrate with no frames', () => {
    expect(() => createVideoCalibrator(WIDTH, HEIGHT).calibrate()).toThrow(RangeError);
  });
});

describe('temporal calibration on a synthetic video', () => {
  // Shared across assertions below; building 96 frames once keeps the
  // suite fast. The rng is shared too, so every frame's noise differs.
  const alpha = trueAlpha();
  const config = getVideoWatermarkConfig(WIDTH, HEIGHT);
  const rng = makeRng(0xdecafbad);
  const calibrator = createVideoCalibrator(WIDTH, HEIGHT);
  const cleanFrames: ImageBuffer[] = [];
  const markedFrames: ImageBuffer[] = [];
  for (let t = 0; t < 96; t += 1) {
    const frame = backgroundFrame(t, rng);
    cleanFrames.push({ ...frame, data: new Uint8Array(frame.data) });
    addWatermarkRegion(frame, alpha, VIDEO_LOGO_SIZE, VIDEO_LOGO_SIZE, config.position);
    markedFrames.push(frame);
    calibrator.addFrame(frame);
  }
  const calibration = calibrator.calibrate();

  it('trusts the temporal estimate, not the fallback', () => {
    expect(calibration.source).toBe('estimated');
    expect(calibration.frames).toBe(96);
    expect(calibration.templateNcc).toBeGreaterThan(0.99);
  });

  it('recovers the injected opacity', () => {
    expect(Math.abs(calibration.templateGain - 0.573)).toBeLessThan(0.02);
  });

  it('recovers the alpha map cell-by-cell', () => {
    let worst = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      const err = Math.abs((calibration.alpha[i] ?? 0) - (alpha[i] ?? 0));
      if (err > worst) worst = err;
    }
    expect(worst).toBeLessThan(0.03);
  });

  it('removal restores the clean frames within the noise budget', () => {
    for (const t of [0, 47, 95]) {
      const marked = markedFrames[t] as ImageBuffer;
      const clean = cleanFrames[t] as ImageBuffer;
      const restored: ImageBuffer = {
        ...marked,
        data: new Uint8Array(marked.data),
      };
      removeVideoWatermark(restored, calibration);
      let worst = 0;
      for (let i = 0; i < restored.data.length; i += 1) {
        const err = Math.abs((restored.data[i] ?? 0) - (clean.data[i] ?? 0));
        if (err > worst) worst = err;
      }
      expect(worst).toBeLessThanOrEqual(4);
    }
  });

  it('leaves pixels outside the logo box byte-identical', () => {
    const marked = markedFrames[10] as ImageBuffer;
    const restored: ImageBuffer = { ...marked, data: new Uint8Array(marked.data) };
    removeVideoWatermark(restored, calibration);
    const { x, y } = config.position;
    for (let row = 0; row < HEIGHT; row += 1) {
      for (let col = 0; col < WIDTH; col += 1) {
        const inside =
          row >= y && row < y + VIDEO_LOGO_SIZE && col >= x && col < x + VIDEO_LOGO_SIZE;
        if (inside) continue;
        const offset = (row * WIDTH + col) * 3;
        for (let c = 0; c < 3; c += 1) {
          if (restored.data[offset + c] !== marked.data[offset + c]) {
            throw new Error(`pixel (${col}, ${row}) channel ${c} changed outside the logo box`);
          }
        }
      }
    }
  });

  it('rejects removal on a frame whose geometry mismatches the calibration', () => {
    const other = backgroundFrame(0, makeRng(1));
    const bigger: ImageBuffer = {
      data: new Uint8Array(400 * 400 * 3),
      width: 400,
      height: 400,
      channels: 3,
    };
    expect(() => removeVideoWatermark(bigger, calibration)).toThrow(RangeError);
    expect(() => removeVideoWatermark(other, calibration)).not.toThrow();
  });
});

describe('template fallback', () => {
  it('falls back to the gain-fitted template when the background never moves', () => {
    // A static, textured background: the temporal mean keeps every
    // detail, and a harmonic fill cannot reproduce it — harmonic
    // functions have no interior extrema, while the background's
    // 23–57px sinusoids peak *inside* the 48px hole. The estimate
    // therefore decorrelates from the template and the gate must route
    // to the fallback. The fitted gain inherits that same fill bias, so
    // the fallback promises a plausible opacity, not an accurate one —
    // the assertions below check the mechanism and bracket the gain
    // loosely rather than claim precision this path cannot have.
    const alpha = trueAlpha();
    const config = getVideoWatermarkConfig(WIDTH, HEIGHT);
    const rng = makeRng(0xfeedface);
    const still = backgroundFrame(0, rng);
    // Sharpen the texture beyond what backgroundFrame provides: add a
    // fixed checker of ±24 levels that harmonic fill cannot reproduce.
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = (y * WIDTH + x) * 3;
        const checker = (Math.trunc(x / 3) + Math.trunc(y / 3)) % 2 === 0 ? 24 : -24;
        for (let c = 0; c < 3; c += 1) {
          const value = (still.data[offset + c] ?? 0) + checker;
          still.data[offset + c] = value < 0 ? 0 : value > 255 ? 255 : value;
        }
      }
    }
    addWatermarkRegion(still, alpha, VIDEO_LOGO_SIZE, VIDEO_LOGO_SIZE, config.position);

    const calibrator = createVideoCalibrator(WIDTH, HEIGHT);
    for (let t = 0; t < 24; t += 1) calibrator.addFrame(still);
    const calibration = calibrator.calibrate();

    expect(calibration.source).toBe('template');
    expect(calibration.templateNcc).toBeLessThan(0.98);
    // The alpha actually used is exactly template × gain — the mechanism,
    // checked cell-by-cell rather than inferred from `source`.
    const template = getSourceAlphaMap('V1', 'small');
    for (let i = 0; i < template.length; i += 1) {
      expect(calibration.alpha[i]).toBeCloseTo(
        (template[i] ?? 0) * calibration.templateGain,
        6,
      );
    }
    // Sanity bracket only: the injected opacity is 0.573 and the fill
    // bias on this background measures ~+0.12. A gain outside this range
    // would mean the fit broke, not that it drifted.
    expect(calibration.templateGain).toBeGreaterThan(0.3);
    expect(calibration.templateGain).toBeLessThan(0.9);
  });
});
