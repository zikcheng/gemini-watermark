/**
 * Veo video watermark support — an **extension**, not a port.
 *
 * GeminiWatermarkTool v0.3.2 has no video path, so unlike every other
 * module in `src/` there is no C++ reference to defer to. The facts this
 * module builds on were measured from Veo 720p sample videos
 * (1280×720 and 720×1280, 240 frames each, August 2026):
 *
 *   - The visible watermark is a static 48×48 sparkle whose top-left
 *     corner sits 144px from the right and bottom edges (a 96px margin
 *     plus the 48px logo) in both orientations.
 *   - Its shape matches the V1 48px source alpha map almost exactly
 *     (NCC 0.998–0.999 against the temporal estimate) but at a global
 *     opacity of roughly 0.57 — and that gain is *not* identical across
 *     videos (0.56 vs 0.59 on the two samples), so a fixed template
 *     underperforms a per-video estimate.
 *   - The blend law is the image one: `frame = alpha·255 + (1−alpha)·bg`,
 *     achromatic (per-channel alpha agreement within 0.005).
 *
 * Because the gain varies, removal is two-pass and self-calibrating:
 * pass 1 feeds every decoded frame to a {@link VideoCalibrator}, which
 * estimates the alpha map from temporal statistics; pass 2 reverse-blends
 * each frame with the estimated map via {@link removeVideoWatermark}.
 *
 * The estimator: the temporal mean of the watermark window is
 * `mean = (1−alpha)·meanBg + alpha·255`, and camera/scene motion makes
 * `meanBg` smooth, so it can be recovered by harmonic inpainting (solving
 * the Laplace equation over the watermark support with the surrounding
 * ring as the boundary), leaving alpha as the only unknown. A support
 * mask is refined once from a first-round estimate, and the result is
 * sanity-checked against the V1 template: if the correlation gate fails
 * (static background, too few frames), calibration falls back to the
 * template scaled by a least-squares gain.
 *
 * Everything here is deterministic per-pixel math on `ImageBuffer`s; the
 * ffmpeg decode/encode glue lives in `tools/video/`, outside the core.
 */

import { getSourceAlphaMap } from './alpha-maps.js';
import { removeWatermarkRegion } from './blend.js';
import type { ImageBuffer, Point } from './types.js';

/** Edge of the video logo box, px. Measured: alpha support spans 48px. */
export const VIDEO_LOGO_SIZE = 48;

/** Distance from the logo box to the right and bottom frame edges, px. */
export const VIDEO_MARGIN = 96;

/**
 * Edge of the square calibration window, centered on the logo. 140px
 * leaves a ≥46px ring of pure background around the 48px logo — enough
 * boundary for the harmonic fill while staying local to the corner.
 */
const CAL_WINDOW = 140;

/**
 * First-round support guess: a centered disk of this fraction of the
 * window edge (radius ≈50px). It only needs to *cover* the sparkle;
 * the second round shrinks it to the actual support.
 */
const SUPPORT_DISK_FRACTION = 0.36;

/** Alpha above which a first-round pixel is kept as real support. */
const SUPPORT_REFINE_THRESHOLD = 0.05;

/** Dilation radius that re-adds the soft fringe around the refined core. */
const SUPPORT_DILATE_RADIUS = 4;

/**
 * Alpha at or below this is background residue from the harmonic fill,
 * zeroed so removal leaves those pixels untouched. Set at the fill-noise
 * level of quiet backgrounds (~0.008); busy backgrounds can leave
 * residue up to ~0.03 that passes this floor, but only where the
 * refined support mask kept the pixel at all, and at that amplitude
 * removal moves a channel by at most a couple of levels. The sparkle
 * fringe the floor drops contributes under one output level.
 */
const ALPHA_NOISE_FLOOR = 0.008;

/** Ceiling mirroring removal's MAX_ALPHA guard; measured peak is ~0.32. */
const ALPHA_CEILING = 0.98;

/**
 * NCC against the V1-48 template above which the temporal estimate is
 * trusted. Estimates on the sample videos measure 0.998+; a static
 * background degrades the fill and lands well below this.
 */
const TEMPLATE_NCC_GATE = 0.98;

/**
 * NCC below which the template fallback is refused too, because nothing
 * watermark-shaped is in the corner and "falling back" would inject a
 * ghost sparkle into a clean video. Synthetic probes separate cleanly:
 * a watermarked-but-static scene still correlates at ~0.75, while clean
 * corners (moving, static-textured, static-smooth) measure ≤ 0.10.
 */
const TEMPLATE_NCC_FLOOR = 0.5;

/**
 * Harmonic fill iteration cap and convergence threshold. Gauss–Seidel on
 * a 140×140 window converges to <1e-4 max-delta in well under 4000
 * sweeps; the cap only bounds pathological inputs.
 */
const FILL_MAX_SWEEPS = 4000;
const FILL_TOLERANCE = 1e-4;

/**
 * Background this close to the logo's 255 makes `alpha = (mean − bg) /
 * (255 − bg)` ill-conditioned; such pixels fall back to the channel
 * average (or 0), matching how the measurement scripts handled them.
 */
const MIN_ALPHA_DENOMINATOR = 8;

/** Placement of the video watermark and its square calibration region. */
export interface VideoWatermarkConfig {
  /** Top-left corner of the 48×48 logo box. */
  position: Point;
  logoSize: number;
  /** Where the square calibration window sits (top-left corner). */
  windowOrigin: Point;
  windowSize: number;
}

/** How {@link VideoCalibration.alpha} was produced. */
export type VideoCalibrationSource = 'estimated' | 'template';

/** Result of temporal calibration, consumed by {@link removeVideoWatermark}. */
export interface VideoCalibration {
  /** Row-major `logoSize²` alpha map. */
  alpha: Float32Array;
  logoSize: number;
  /** Top-left corner of the logo box in frame coordinates. */
  position: Point;
  /** Frames accumulated before calibration. */
  frames: number;
  /**
   * NCC of the temporal estimate against the V1 48px source map.
   * Diagnostic: values at or above the internal gate mean `alpha` *is*
   * the estimate; below it, `alpha` is the template fallback.
   */
  templateNcc: number;
  /** Least-squares opacity of the estimate relative to the V1-48 map. */
  templateGain: number;
  source: VideoCalibrationSource;
}

/** Accumulates decoded frames and produces a {@link VideoCalibration}. */
export interface VideoCalibrator {
  /** Frame dimensions must match the calibrator's; RGB and RGBA both work. */
  addFrame(frame: ImageBuffer): void;
  /** @throws RangeError when no frames have been accumulated */
  calibrate(): VideoCalibration;
  readonly frameCount: number;
}

/**
 * Watermark geometry for a Veo video frame. Both sample orientations
 * follow the same rule: a 48px logo inset 96px from the right and bottom
 * edges. Measured on 720p-class outputs; other resolutions are untested,
 * which is one reason calibration validates against the template instead
 * of trusting this blindly.
 *
 * @throws RangeError when the frame is too small to hold the window
 */
export function getVideoWatermarkConfig(
  width: number,
  height: number,
): VideoWatermarkConfig {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError(`dimensions must be integers, got ${width}x${height}`);
  }
  const position = {
    x: width - VIDEO_MARGIN - VIDEO_LOGO_SIZE,
    y: height - VIDEO_MARGIN - VIDEO_LOGO_SIZE,
  };
  const pad = (CAL_WINDOW - VIDEO_LOGO_SIZE) / 2;
  const windowOrigin = { x: position.x - pad, y: position.y - pad };
  if (windowOrigin.x < 0 || windowOrigin.y < 0) {
    throw new RangeError(
      `frame ${width}x${height} is too small for video watermark ` +
        `calibration; both dimensions must be at least ` +
        `${VIDEO_MARGIN + VIDEO_LOGO_SIZE + pad}px`,
    );
  }
  return { position, logoSize: VIDEO_LOGO_SIZE, windowOrigin, windowSize: CAL_WINDOW };
}

/**
 * Solve the Laplace equation over `mask` pixels in place, Dirichlet
 * boundary at every unmasked pixel. Window-edge pixels are never masked
 * (the support sits centered, far from the edge), so the 4-neighbour
 * stencil never reads out of bounds.
 */
function harmonicFill(field: Float64Array, mask: Uint8Array, edge: number): void {
  let boundarySum = 0;
  let boundaryCount = 0;
  for (let i = 0; i < field.length; i += 1) {
    if (mask[i] === 0) {
      boundarySum += field[i] ?? 0;
      boundaryCount += 1;
    }
  }
  const seed = boundaryCount > 0 ? boundarySum / boundaryCount : 0;
  for (let i = 0; i < field.length; i += 1) {
    if (mask[i] !== 0) field[i] = seed;
  }
  for (let sweep = 0; sweep < FILL_MAX_SWEEPS; sweep += 1) {
    let delta = 0;
    for (let row = 1; row < edge - 1; row += 1) {
      for (let col = 1; col < edge - 1; col += 1) {
        const i = row * edge + col;
        if (mask[i] === 0) continue;
        const next =
          ((field[i - 1] ?? 0) +
            (field[i + 1] ?? 0) +
            (field[i - edge] ?? 0) +
            (field[i + edge] ?? 0)) /
          4;
        const drift = Math.abs(next - (field[i] ?? 0));
        if (drift > delta) delta = drift;
        field[i] = next;
      }
    }
    if (delta < FILL_TOLERANCE) break;
  }
}

/** Keep only the largest 4-connected component of `mask`, in place. */
function keepLargestComponent(mask: Uint8Array, edge: number): void {
  const labels = new Int32Array(mask.length).fill(-1);
  const stack: number[] = [];
  let bestLabel = -1;
  let bestSize = 0;
  let nextLabel = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] === 0 || labels[start] !== -1) continue;
    let size = 0;
    labels[start] = nextLabel;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() ?? 0;
      size += 1;
      const row = Math.floor(i / edge);
      const col = i - row * edge;
      if (col > 0 && mask[i - 1] !== 0 && labels[i - 1] === -1) {
        labels[i - 1] = nextLabel;
        stack.push(i - 1);
      }
      if (col < edge - 1 && mask[i + 1] !== 0 && labels[i + 1] === -1) {
        labels[i + 1] = nextLabel;
        stack.push(i + 1);
      }
      if (row > 0 && mask[i - edge] !== 0 && labels[i - edge] === -1) {
        labels[i - edge] = nextLabel;
        stack.push(i - edge);
      }
      if (row < edge - 1 && mask[i + edge] !== 0 && labels[i + edge] === -1) {
        labels[i + edge] = nextLabel;
        stack.push(i + edge);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestLabel = nextLabel;
    }
    nextLabel += 1;
  }
  // An all-zero mask has no components: bestLabel is still -1, and so is
  // every unvisited pixel's label, so the loop below would invert the
  // mask to all-ones — flooding the fill with an empty boundary and
  // turning a clean video into a ghost-sparkle injection. Leave it empty.
  if (bestLabel < 0) return;
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = labels[i] === bestLabel ? 1 : 0;
  }
}

/** Binary dilation with a square structuring element of radius `r`. */
function dilate(mask: Uint8Array, edge: number, r: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < edge; row += 1) {
    for (let col = 0; col < edge; col += 1) {
      let hit = 0;
      for (let dy = -r; dy <= r && hit === 0; dy += 1) {
        const rr = row + dy;
        if (rr < 0 || rr >= edge) continue;
        for (let dx = -r; dx <= r; dx += 1) {
          const cc = col + dx;
          if (cc >= 0 && cc < edge && mask[rr * edge + cc] !== 0) {
            hit = 1;
            break;
          }
        }
      }
      out[row * edge + col] = hit;
    }
  }
  return out;
}

/**
 * One estimation round: harmonic-fill each channel's temporal mean over
 * `support`, then read alpha out of the blend equation, averaging the
 * channels that are well-conditioned.
 */
function estimateAlpha(
  means: readonly [Float64Array, Float64Array, Float64Array],
  support: Uint8Array,
  edge: number,
): Float64Array {
  const alpha = new Float64Array(edge * edge);
  const contributions = new Uint8Array(edge * edge);
  const filled = new Float64Array(edge * edge);
  for (let c = 0; c < 3; c += 1) {
    const mean = means[c] as Float64Array;
    filled.set(mean);
    harmonicFill(filled, support, edge);
    for (let i = 0; i < filled.length; i += 1) {
      const denominator = 255 - (filled[i] ?? 0);
      if (denominator > MIN_ALPHA_DENOMINATOR) {
        alpha[i] = (alpha[i] ?? 0) + ((mean[i] ?? 0) - (filled[i] ?? 0)) / denominator;
        contributions[i] = (contributions[i] ?? 0) + 1;
      }
    }
  }
  for (let i = 0; i < alpha.length; i += 1) {
    const n = contributions[i] ?? 0;
    alpha[i] = n > 0 ? (alpha[i] ?? 0) / n : 0;
  }
  return alpha;
}

/** Pearson correlation between two equal-length maps. */
function correlate(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i] ?? 0;
    meanB += b[i] ?? 0;
  }
  meanA /= n;
  meanB /= n;
  let cross = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    cross += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denominator = Math.sqrt(varA * varB);
  return denominator > 0 ? cross / denominator : 0;
}

/**
 * Create a calibrator for frames of the given dimensions. Feed every
 * frame (or a uniform temporal subsample — the estimator only needs the
 * temporal mean) to `addFrame`, then call `calibrate` once.
 */
export function createVideoCalibrator(width: number, height: number): VideoCalibrator {
  const config = getVideoWatermarkConfig(width, height);
  const edge = config.windowSize;
  const originX = config.windowOrigin.x;
  const originY = config.windowOrigin.y;
  // One f64 accumulator per channel; a 10-minute 24fps video sums 14400
  // frames of at most 255, far inside f64's exact-integer range.
  const sums: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(edge * edge),
    new Float64Array(edge * edge),
    new Float64Array(edge * edge),
  ];
  let frames = 0;

  return {
    get frameCount(): number {
      return frames;
    },

    addFrame(frame: ImageBuffer): void {
      if (frame.width !== width || frame.height !== height) {
        throw new RangeError(
          `frame is ${frame.width}x${frame.height}, calibrator expects ${width}x${height}`,
        );
      }
      if (frame.channels !== 3 && frame.channels !== 4) {
        throw new RangeError(`channels must be 3 or 4, got ${frame.channels}`);
      }
      const expected = width * height * frame.channels;
      if (frame.data.length !== expected) {
        throw new RangeError(
          `frame data has ${frame.data.length} bytes, expected ${expected}`,
        );
      }
      const { data, channels } = frame;
      const [r, g, b] = sums;
      for (let row = 0; row < edge; row += 1) {
        const frameRow = (originY + row) * width;
        const windowRow = row * edge;
        for (let col = 0; col < edge; col += 1) {
          const offset = (frameRow + originX + col) * channels;
          const i = windowRow + col;
          r[i] = (r[i] ?? 0) + (data[offset] ?? 0);
          g[i] = (g[i] ?? 0) + (data[offset + 1] ?? 0);
          b[i] = (b[i] ?? 0) + (data[offset + 2] ?? 0);
        }
      }
      frames += 1;
    },

    calibrate(): VideoCalibration {
      if (frames === 0) {
        throw new RangeError('cannot calibrate: no frames accumulated');
      }
      const means: [Float64Array, Float64Array, Float64Array] = [
        new Float64Array(edge * edge),
        new Float64Array(edge * edge),
        new Float64Array(edge * edge),
      ];
      for (let c = 0; c < 3; c += 1) {
        const sum = sums[c] as Float64Array;
        const mean = means[c] as Float64Array;
        for (let i = 0; i < sum.length; i += 1) mean[i] = (sum[i] ?? 0) / frames;
      }

      // Round 1: generous disk support, centered where the logo sits.
      let support: Uint8Array = new Uint8Array(edge * edge);
      const radius = edge * SUPPORT_DISK_FRACTION;
      const center = (edge - 1) / 2;
      for (let row = 0; row < edge; row += 1) {
        for (let col = 0; col < edge; col += 1) {
          const dy = row - center;
          const dx = col - center;
          if (dx * dx + dy * dy < radius * radius) support[row * edge + col] = 1;
        }
      }
      const first = estimateAlpha(means, support, edge);

      // Round 2: support refined to the sparkle actually found.
      support = new Uint8Array(edge * edge);
      for (let i = 0; i < first.length; i += 1) {
        if ((first[i] ?? 0) > SUPPORT_REFINE_THRESHOLD) support[i] = 1;
      }
      keepLargestComponent(support, edge);
      support = dilate(support, edge, SUPPORT_DILATE_RADIUS);
      const second = estimateAlpha(means, support, edge);

      // Extract the centered logo box, drop fill residue, clamp.
      const pad = (edge - VIDEO_LOGO_SIZE) / 2;
      const estimate = new Float32Array(VIDEO_LOGO_SIZE * VIDEO_LOGO_SIZE);
      for (let row = 0; row < VIDEO_LOGO_SIZE; row += 1) {
        for (let col = 0; col < VIDEO_LOGO_SIZE; col += 1) {
          const i = (row + pad) * edge + (col + pad);
          let value = support[i] !== 0 ? (second[i] ?? 0) : 0;
          if (value <= ALPHA_NOISE_FLOOR) value = 0;
          else if (value > ALPHA_CEILING) value = ALPHA_CEILING;
          estimate[row * VIDEO_LOGO_SIZE + col] = value;
        }
      }

      const template = getSourceAlphaMap('V1', 'small');
      const ncc = correlate(estimate, template);
      let cross = 0;
      let templateEnergy = 0;
      for (let i = 0; i < template.length; i += 1) {
        cross += (estimate[i] ?? 0) * (template[i] ?? 0);
        templateEnergy += (template[i] ?? 0) * (template[i] ?? 0);
      }
      const gain = templateEnergy > 0 ? cross / templateEnergy : 0;

      let alpha = estimate;
      let source: VideoCalibrationSource = 'estimated';
      if (ncc < TEMPLATE_NCC_GATE) {
        if (ncc < TEMPLATE_NCC_FLOOR || !(gain > 0)) {
          throw new RangeError(
            'video watermark calibration failed: the temporal estimate does ' +
              'not correlate with the watermark template — is there a Veo ' +
              'watermark in the bottom-right corner?',
          );
        }
        alpha = new Float32Array(template.length);
        for (let i = 0; i < template.length; i += 1) {
          alpha[i] = (template[i] ?? 0) * gain;
        }
        source = 'template';
      }

      return {
        alpha,
        logoSize: VIDEO_LOGO_SIZE,
        position: config.position,
        frames,
        templateNcc: ncc,
        templateGain: gain,
        source,
      };
    },
  };
}

/**
 * Reverse-blend one frame in place using a calibration produced for the
 * same dimensions. Thin wrapper over {@link removeWatermarkRegion}; the
 * A channel of RGBA frames is untouched.
 *
 * @throws RangeError when the frame does not match the calibration
 */
export function removeVideoWatermark(
  frame: ImageBuffer,
  calibration: VideoCalibration,
): void {
  const expected = getVideoWatermarkConfig(frame.width, frame.height);
  if (
    expected.position.x !== calibration.position.x ||
    expected.position.y !== calibration.position.y
  ) {
    throw new RangeError(
      `calibration was made for a different geometry: frame ` +
        `${frame.width}x${frame.height} puts the logo at ` +
        `(${expected.position.x}, ${expected.position.y}), calibration ` +
        `has (${calibration.position.x}, ${calibration.position.y})`,
    );
  }
  removeWatermarkRegion(
    frame,
    calibration.alpha,
    calibration.logoSize,
    calibration.logoSize,
    calibration.position,
  );
}
