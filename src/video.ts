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
 * `meanBg` smooth, so it can be recovered by biharmonic inpainting
 * (solving the plate equation over the watermark support with the
 * surrounding ring as the boundary), leaving alpha as the only unknown.
 * Biharmonic rather than harmonic by measurement: a membrane cannot
 * continue a boundary *slope*, and on the 16:9 sample — where a soft
 * shadow ramp crosses the corner — the harmonic estimate left a faint
 * sparkle-shaped residue in the output's temporal mean
 * (residual/template NCC 0.16); the plate solution removed it (NCC ≈ 0)
 * at equal edge-band noise. A support mask is refined once from a
 * first-round estimate, and the result is sanity-checked against the V1
 * template: if the correlation gate fails (static background, too few
 * frames), calibration falls back to the template scaled by an
 * edge-calibrated gain.
 *
 * Removal then reverse-blends each frame and, by default, smooths the
 * thin band along the sparkle's edges where the division amplifies
 * codec noise — see `SMOOTH_*` for how those numbers were chosen.
 *
 * Everything here is deterministic per-pixel math on `ImageBuffer`s; the
 * ffmpeg decode/encode glue lives in `tools/video/`, outside the core.
 */

import { getSourceAlphaMap } from './alpha-maps.js';
import { removeWatermarkRegion } from './blend.js';
import { quantizeU8 } from './quantize.js';
import type { ImageBuffer, Point, ProcessStatus } from './types.js';

/** Channels smoothed. The A channel of an RGBA buffer is never written. */
const COLOR_CHANNELS = 3;

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
 * Fill iteration caps and convergence threshold. Gauss–Seidel on a
 * 140×140 window converges to <1e-4 max-delta in well under the caps;
 * they only bound pathological inputs. The biharmonic pass gets more
 * sweeps because the plate stencil propagates information more slowly,
 * and over-relaxation (SOR) compensates for most of that.
 */
const FILL_MAX_SWEEPS = 4000;
const BIHARMONIC_MAX_SWEEPS = 8000;
const BIHARMONIC_RELAXATION = 1.5;
const FILL_TOLERANCE = 1e-4;

/**
 * Background this close to the logo's 255 makes `alpha = (mean − bg) /
 * (255 − bg)` ill-conditioned; such pixels fall back to the channel
 * average (or 0), matching how the measurement scripts handled them.
 */
const MIN_ALPHA_DENOMINATOR = 8;

/**
 * Template-gradient magnitude above which a cell belongs to the
 * sparkle's edge band — the thin outline where removal's `1/(1−alpha)`
 * amplifies codec noise and where the fallback's gain search listens
 * for residual edge structure.
 */
const EDGE_BAND_THRESHOLD = 0.02;

/**
 * Edge-band smoothing, applied after the reverse blend (on by default,
 * `smoothEdges: false` disables). Each band pixel is pulled toward its
 * 5×5 Gaussian-blurred value by a weight proportional to the local
 * alpha gradient. The numbers come from a parameter sweep on the sample
 * videos, scored by mean |Laplacian| per frame inside the band versus a
 * control ring of untouched background: unsmoothed measures roughly 2×
 * the ring (5.8 vs 3.2 and 4.7 vs 2.6); this setting lands at the
 * ring's own level (3.3 and 3.1); stronger settings dip *below* it,
 * i.e. the band becomes visibly smoother than its surroundings.
 */
const SMOOTH_SIGMA = 1.0;
const SMOOTH_KERNEL_RADIUS = 2;
const SMOOTH_WEIGHT_SCALE = 6;
const SMOOTH_WEIGHT_MAX = 0.7;
/** The smoothed region: the logo box grown by this on every side. */
const SMOOTH_PAD = 4;

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
  /**
   * On the `'template'` path, the opacity the fallback alpha actually
   * uses (edge-calibrated, least-squares as backstop); on the
   * `'estimated'` path, the diagnostic least-squares fit of the
   * estimate against the V1-48 map.
   */
  templateGain: number;
  source: VideoCalibrationSource;
}

/** Options for {@link removeVideoWatermark}. */
export interface VideoRemoveOptions {
  /**
   * Smooth the sparkle's edge band after the reverse blend, hiding the
   * codec noise the division amplifies there. Default true; disable for
   * the pure algebraic inversion.
   */
  smoothEdges?: boolean;
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

/**
 * Solve the biharmonic (plate) equation over `mask` pixels in place,
 * seeded with the harmonic solution so the slow 13-point stencil starts
 * near the answer. Unlike a membrane, a plate continues the boundary's
 * slope into the hole, which is what recovers a background whose shading
 * ramps *through* the watermark. The stencil needs a 2-pixel apron, so
 * masked pixels within 2 of the window edge would keep their harmonic
 * value — the support never reaches there (it sits centered, ≥15px in).
 */
function biharmonicFill(field: Float64Array, mask: Uint8Array, edge: number): void {
  harmonicFill(field, mask, edge);
  for (let sweep = 0; sweep < BIHARMONIC_MAX_SWEEPS; sweep += 1) {
    let delta = 0;
    for (let row = 2; row < edge - 2; row += 1) {
      for (let col = 2; col < edge - 2; col += 1) {
        const i = row * edge + col;
        if (mask[i] === 0) continue;
        // ∇⁴f = 0  ⇒  f = [8·(edge neighbours) − 2·(diagonals) − (distance-2)] / 20
        const target =
          (8 *
            ((field[i - 1] ?? 0) +
              (field[i + 1] ?? 0) +
              (field[i - edge] ?? 0) +
              (field[i + edge] ?? 0)) -
            2 *
              ((field[i - edge - 1] ?? 0) +
                (field[i - edge + 1] ?? 0) +
                (field[i + edge - 1] ?? 0) +
                (field[i + edge + 1] ?? 0)) -
            ((field[i - 2] ?? 0) +
              (field[i + 2] ?? 0) +
              (field[i - 2 * edge] ?? 0) +
              (field[i + 2 * edge] ?? 0))) /
          20;
        const current = field[i] ?? 0;
        const next = current + BIHARMONIC_RELAXATION * (target - current);
        const drift = Math.abs(next - current);
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
 * One estimation round: biharmonic-fill each channel's temporal mean
 * over `support`, then read alpha out of the blend equation, averaging
 * the channels that are well-conditioned.
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
    biharmonicFill(filled, support, edge);
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
 * Fallback opacity via a 1-D edge search instead of trusting the noisy
 * least-squares fit. Reverse blending is affine in the observed value
 * per pixel, so removing from the temporal *mean* equals the mean of
 * removed frames — the search runs entirely on the stored window sums.
 * `C(g)` correlates the removed mean's gradients with the template's
 * over the edge band; the correct gain zeroes it ("turn the opacity up
 * until the sparkle's outline vanishes"), found by bisection since
 * `C` decreases monotonically in `g`. On synthetic static probes this
 * lands within 0.06 of the injected opacity where least squares was
 * off by 0.12 (harsh texture), and within 0.006 on smooth backgrounds.
 * Returns undefined when `C(0) ≤ 0` — no watermark-signed edge energy
 * to calibrate against.
 */
function edgeSearchGain(
  means: readonly [Float64Array, Float64Array, Float64Array],
  template: Float32Array,
  edge: number,
): number | undefined {
  const pad = (edge - VIDEO_LOGO_SIZE) / 2;
  const logoAlpha = (row: number, col: number): number =>
    row >= 0 && row < VIDEO_LOGO_SIZE && col >= 0 && col < VIDEO_LOGO_SIZE
      ? (template[row * VIDEO_LOGO_SIZE + col] ?? 0)
      : 0;

  const correlation = (gain: number): number => {
    let acc = 0;
    for (let row = 0; row < VIDEO_LOGO_SIZE; row += 1) {
      for (let col = 0; col < VIDEO_LOGO_SIZE; col += 1) {
        const tx = (logoAlpha(row, col + 1) - logoAlpha(row, col - 1)) / 2;
        const ty = (logoAlpha(row + 1, col) - logoAlpha(row - 1, col)) / 2;
        if (Math.hypot(tx, ty) <= EDGE_BAND_THRESHOLD) continue;
        for (let c = 0; c < 3; c += 1) {
          const mean = means[c] as Float64Array;
          const removed = (r: number, q: number): number => {
            const a = gain * logoAlpha(r, q);
            return ((mean[(r + pad) * edge + (q + pad)] ?? 0) - a * 255) / (1 - a);
          };
          const rx = (removed(row, col + 1) - removed(row, col - 1)) / 2;
          const ry = (removed(row + 1, col) - removed(row - 1, col)) / 2;
          acc += rx * tx + ry * ty;
        }
      }
    }
    return acc;
  };

  let peak = 0;
  for (let i = 0; i < template.length; i += 1) {
    const value = template[i] ?? 0;
    if (value > peak) peak = value;
  }
  if (!(peak > 0) || correlation(0) <= 0) return undefined;
  let low = 0;
  let high = ALPHA_CEILING / peak;
  for (let step = 0; step < 60; step += 1) {
    const mid = (low + high) / 2;
    if (correlation(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Shared accumulator behind {@link createVideoCalibrator} and
 * {@link processVideo}: window sums plus the geometry they were built
 * for. Plain module functions rather than closure methods so the
 * one-call pipeline can reach the non-throwing calibration path.
 */
interface CalibratorState {
  width: number;
  height: number;
  config: VideoWatermarkConfig;
  sums: [Float64Array, Float64Array, Float64Array];
  frames: number;
}

function createCalibratorState(width: number, height: number): CalibratorState {
  const config = getVideoWatermarkConfig(width, height);
  const edge = config.windowSize;
  // One f64 accumulator per channel; a 10-minute 24fps video sums 14400
  // frames of at most 255, far inside f64's exact-integer range.
  return {
    width,
    height,
    config,
    sums: [
      new Float64Array(edge * edge),
      new Float64Array(edge * edge),
      new Float64Array(edge * edge),
    ],
    frames: 0,
  };
}

function accumulateFrame(state: CalibratorState, frame: ImageBuffer): void {
  const { width, height, config } = state;
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
  const edge = config.windowSize;
  const originX = config.windowOrigin.x;
  const originY = config.windowOrigin.y;
  const { data, channels } = frame;
  const [r, g, b] = state.sums;
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
  state.frames += 1;
}

/**
 * The calibration computation. Returns `calibration: null` — with the
 * diagnostic NCC — when nothing watermark-shaped is in the corner;
 * {@link VideoCalibrator.calibrate} turns that into a `RangeError`,
 * {@link processVideo} into a `'skipped'` result. Throws only on
 * invalid use (no frames accumulated).
 */
function computeCalibration(
  state: CalibratorState,
): { calibration: VideoCalibration | null; templateNcc: number } {
  const { config, sums, frames } = state;
  const edge = config.windowSize;
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
  let usedGain = gain;
  if (ncc < TEMPLATE_NCC_GATE) {
    if (ncc < TEMPLATE_NCC_FLOOR || !(gain > 0)) {
      return { calibration: null, templateNcc: ncc };
    }
    // The edge search reads the opacity off the sparkle outline and
    // is much less exposed to the fill bias that pollutes both the
    // per-pixel estimate and its least-squares gain; the fit only
    // remains as the backstop for a search with no bracket.
    usedGain = edgeSearchGain(means, template, edge) ?? gain;
    alpha = new Float32Array(template.length);
    for (let i = 0; i < template.length; i += 1) {
      alpha[i] = (template[i] ?? 0) * usedGain;
    }
    source = 'template';
  }

  return {
    calibration: {
      alpha,
      logoSize: VIDEO_LOGO_SIZE,
      position: config.position,
      frames,
      templateNcc: ncc,
      templateGain: usedGain,
      source,
    },
    templateNcc: ncc,
  };
}

/**
 * Create a calibrator for frames of the given dimensions. Feed every
 * frame (or a uniform temporal subsample — the estimator only needs the
 * temporal mean) to `addFrame`, then call `calibrate` once.
 */
export function createVideoCalibrator(width: number, height: number): VideoCalibrator {
  const state = createCalibratorState(width, height);
  return {
    get frameCount(): number {
      return state.frames;
    },
    addFrame(frame: ImageBuffer): void {
      accumulateFrame(state, frame);
    },
    calibrate(): VideoCalibration {
      const { calibration } = computeCalibration(state);
      if (calibration === null) {
        throw new RangeError(
          'video watermark calibration failed: the temporal estimate does ' +
            'not correlate with the watermark template — is there a Veo ' +
            'watermark in the bottom-right corner?',
        );
      }
      return calibration;
    },
  };
}

/**
 * Per-calibration smoothing plan: the weight map and Gaussian kernel
 * depend only on the alpha map, and the scratch buffer lets the
 * per-frame pass run allocation-free. Cached per calibration object.
 */
interface SmoothPlan {
  /** Region edge: logo box grown by SMOOTH_PAD on each side. */
  size: number;
  /** Per-pixel blend weight toward the blurred value; 0 leaves it. */
  weights: Float64Array;
  /** Normalized (2·radius+1)² Gaussian taps. */
  kernel: Float64Array;
  /** Snapshot of the region's RGB, source for every blur tap. */
  scratch: Float64Array;
}

const smoothPlans = new WeakMap<VideoCalibration, SmoothPlan>();

function getSmoothPlan(calibration: VideoCalibration): SmoothPlan {
  const cached = smoothPlans.get(calibration);
  if (cached !== undefined) return cached;

  const logo = calibration.logoSize;
  const size = logo + 2 * SMOOTH_PAD;
  const radius = SMOOTH_KERNEL_RADIUS;
  const kernel = new Float64Array((2 * radius + 1) ** 2);
  let total = 0;
  let tap = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const value = Math.exp(-(dx * dx + dy * dy) / (2 * SMOOTH_SIGMA * SMOOTH_SIGMA));
      kernel[tap] = value;
      total += value;
      tap += 1;
    }
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] = (kernel[i] ?? 0) / total;

  const { alpha } = calibration;
  const logoAlpha = (row: number, col: number): number =>
    row >= 0 && row < logo && col >= 0 && col < logo ? (alpha[row * logo + col] ?? 0) : 0;
  const weights = new Float64Array(size * size);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const gx = (logoAlpha(row - SMOOTH_PAD, col - SMOOTH_PAD + 1) -
        logoAlpha(row - SMOOTH_PAD, col - SMOOTH_PAD - 1)) / 2;
      const gy = (logoAlpha(row - SMOOTH_PAD + 1, col - SMOOTH_PAD) -
        logoAlpha(row - SMOOTH_PAD - 1, col - SMOOTH_PAD)) / 2;
      const weight = Math.hypot(gx, gy) * SMOOTH_WEIGHT_SCALE;
      weights[row * size + col] = weight > SMOOTH_WEIGHT_MAX ? SMOOTH_WEIGHT_MAX : weight;
    }
  }

  const plan: SmoothPlan = {
    size,
    weights,
    kernel,
    scratch: new Float64Array(size * size * COLOR_CHANNELS),
  };
  smoothPlans.set(calibration, plan);
  return plan;
}

/** Blend edge-band pixels toward their Gaussian blur, in place. */
function smoothEdgeBand(frame: ImageBuffer, calibration: VideoCalibration): void {
  const plan = getSmoothPlan(calibration);
  const { size, weights, kernel, scratch } = plan;
  const radius = SMOOTH_KERNEL_RADIUS;
  const { data, channels, width } = frame;
  // In-bounds by construction: the calibration window pad (46) exceeds
  // SMOOTH_PAD on every side, and the config validated that placement.
  const originX = calibration.position.x - SMOOTH_PAD;
  const originY = calibration.position.y - SMOOTH_PAD;

  for (let row = 0; row < size; row += 1) {
    const frameRow = (originY + row) * width;
    for (let col = 0; col < size; col += 1) {
      const offset = (frameRow + originX + col) * channels;
      const cell = (row * size + col) * COLOR_CHANNELS;
      scratch[cell] = data[offset] ?? 0;
      scratch[cell + 1] = data[offset + 1] ?? 0;
      scratch[cell + 2] = data[offset + 2] ?? 0;
    }
  }

  for (let row = 0; row < size; row += 1) {
    const frameRow = (originY + row) * width;
    for (let col = 0; col < size; col += 1) {
      const weight = weights[row * size + col] ?? 0;
      if (weight <= 0) continue;
      const offset = (frameRow + originX + col) * channels;
      for (let c = 0; c < COLOR_CHANNELS; c += 1) {
        let blurred = 0;
        let tap = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          let rr = row + dy;
          if (rr < 0) rr = 0;
          else if (rr >= size) rr = size - 1;
          for (let dx = -radius; dx <= radius; dx += 1) {
            let cc = col + dx;
            if (cc < 0) cc = 0;
            else if (cc >= size) cc = size - 1;
            blurred += (kernel[tap] ?? 0) * (scratch[(rr * size + cc) * COLOR_CHANNELS + c] ?? 0);
            tap += 1;
          }
        }
        const current = scratch[(row * size + col) * COLOR_CHANNELS + c] ?? 0;
        data[offset + c] = quantizeU8((1 - weight) * current + weight * blurred);
      }
    }
  }
}

/**
 * Reverse-blend one frame in place using a calibration produced for the
 * same dimensions, then (by default) smooth the sparkle's edge band.
 * The blend is a thin wrapper over {@link removeWatermarkRegion}; the
 * A channel of RGBA frames is untouched by both passes.
 *
 * @throws RangeError when the frame does not match the calibration
 */
export function removeVideoWatermark(
  frame: ImageBuffer,
  calibration: VideoCalibration,
  options: VideoRemoveOptions = {},
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
  if (options.smoothEdges !== false) {
    smoothEdgeBand(frame, calibration);
  }
}

/** Options for {@link processVideo}. */
export interface ProcessVideoOptions {
  /** Forwarded to {@link removeVideoWatermark}. Default true. */
  smoothEdges?: boolean;
}

/**
 * Outcome of the one-call video pipeline, shaped after the image
 * pipeline's `ProcessResult`: `'skipped'` means every frame is
 * byte-identical to what was passed in.
 */
export interface ProcessVideoResult {
  status: ProcessStatus;
  /** Frames examined (and, when processed, modified). */
  frames: number;
  /**
   * The calibration's diagnostic NCC against the V1-48 map — reported
   * on the skip path too, where it is what the skip decision read.
   */
  templateNcc: number;
  /** Present when processed. */
  calibration?: VideoCalibration;
}

/**
 * The whole pipeline in one call, for callers holding a decoded frame
 * sequence in memory — the video analogue of `processImage`. Runs the
 * temporal calibration over `frames`, and either reverse-blends every
 * frame in place (`'processed'`) or, when nothing watermark-shaped is
 * in the corner, leaves every frame untouched (`'skipped'`) — the
 * skip-not-throw semantics of the image pipeline, and the reason no
 * pixel is written until calibration has succeeded.
 *
 * The two-pass {@link createVideoCalibrator} + {@link removeVideoWatermark}
 * form remains for callers streaming frames through bounded memory
 * (decode twice, hold one frame at a time), like `tools/video/` does.
 *
 * @throws RangeError on an empty sequence, mismatched frame dimensions,
 *   or frames too small for the watermark geometry — invalid input
 *   throws; only "no watermark found" skips.
 */
export function processVideo(
  frames: readonly ImageBuffer[],
  options: ProcessVideoOptions = {},
): ProcessVideoResult {
  const head = frames[0];
  if (head === undefined) {
    throw new RangeError('processVideo needs at least one frame');
  }
  const state = createCalibratorState(head.width, head.height);
  for (const frame of frames) {
    accumulateFrame(state, frame);
  }
  const { calibration, templateNcc } = computeCalibration(state);
  if (calibration === null) {
    return { status: 'skipped', frames: frames.length, templateNcc };
  }
  const removeOptions: VideoRemoveOptions =
    options.smoothEdges === undefined ? {} : { smoothEdges: options.smoothEdges };
  for (const frame of frames) {
    removeVideoWatermark(frame, calibration, removeOptions);
  }
  return {
    status: 'processed',
    frames: frames.length,
    templateNcc,
    calibration,
  };
}
