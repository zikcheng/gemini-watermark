/**
 * Forward and reverse alpha blending — the arithmetic core of the port.
 *
 * Ported from GeminiWatermarkTool `src/core/blend_modes.cpp`
 * (`remove_watermark_alpha_blend`, `add_watermark_alpha_blend`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * Gemini composites its watermark as
 *   `watermarked = alpha * logo + (1 - alpha) * original`
 * against a white logo, so removal solves the same equation the other way:
 *   `original = (watermarked - alpha * logo) / (1 - alpha)`
 * Reconstruction is exact and deterministic; nothing is inpainted or
 * invented.
 *
 * Both directions are kept as separate loops, mirroring the upstream file,
 * rather than folded into one parameterised loop: the two differ by the
 * `MAX_ALPHA` clamp, and hoisting that difference into a per-pixel branch
 * would be slower and less obviously faithful than repeating the frame.
 */
import { quantizeU8 } from './quantize.js';
import type { ImageBuffer, Point } from './types.js';

/**
 * Alpha below which a pixel is left untouched, treating the value as
 * capture noise rather than watermark (`alpha_threshold`, blend_modes.cpp).
 */
const ALPHA_SKIP_THRESHOLD = 0.002;

/**
 * Ceiling applied to alpha before dividing, so `1 - alpha` cannot approach
 * zero and blow the reconstruction up (`max_alpha`, blend_modes.cpp).
 * Removal only — the forward blend never divides, and upstream does not
 * clamp there.
 */
const MAX_ALPHA = 0.99;

// Coverage note for anyone reading a green golden run: this ceiling is
// never reached by real data. The four calibrated source maps peak at
// alpha 0.33 (V2 small), 0.37 (V2 large), 0.51 (V1 small) and 0.51 (V1
// large) — not one pixel exceeds 0.99. So the golden comparisons exercise
// every other branch here but say nothing about this one, and only a
// synthetic alpha can test it.

// Both constants are `float` literals upstream (`0.002f`, `0.99f`) and
// doubles here, so the comparisons are not textually identical. They are
// nonetheless equivalent on every input this can receive, which was
// checked rather than assumed:
//
//   float32(0.002) = 0.00200000009499…  >  double 0.002  (by 9.5e-11)
//   float32(0.99)  = 0.99000000953674…  >  double 0.99   (by 9.5e-09)
//
// A comparison could only diverge for an alpha inside [double, float32) —
// but each gap is smaller than one float32 ulp at that magnitude (2.3e-10
// and 6.0e-8), and the float32 constant is by definition the nearest
// float32 to the decimal, so no representable alpha lands in either
// interval. Alpha always arrives from a Float32Array, so that is the whole
// domain. The one real difference is the clamped *value* when alpha
// exceeds the ceiling: upstream divides by 1 - float32(0.99), this by
// 1 - 0.99, a 9.5e-9 gap that moves a channel by at most ~2e-4 of a level.

/** Channels blended. The A channel of an RGBA buffer is never written. */
const COLOR_CHANNELS = 3;

function validate(
  image: ImageBuffer,
  alpha: Float32Array,
  alphaWidth: number,
  alphaHeight: number,
  position: Point,
): void {
  // Upstream's position is a `cv::Point`, i.e. integers; a fractional
  // coordinate has no upstream meaning, so rejecting it is faithfulness
  // rather than an added restriction. Without this the clipping arithmetic
  // would silently produce an empty region and the call would be a no-op —
  // the worst way for a caller's mistake to surface.
  if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) {
    throw new RangeError(
      `position must have integer coordinates, got (${position.x}, ${position.y})`,
    );
  }
  if (image.channels !== 3 && image.channels !== 4) {
    throw new RangeError(
      `image.channels is ${String(image.channels)}, expected 3 (RGB) or 4 (RGBA)`,
    );
  }
  const expectedPixels = image.width * image.height * image.channels;
  if (image.data.length !== expectedPixels) {
    throw new RangeError(
      `image.data holds ${image.data.length} bytes, expected ${expectedPixels} ` +
        `(${image.width}x${image.height}x${image.channels})`,
    );
  }
  const expectedAlpha = alphaWidth * alphaHeight;
  if (alpha.length !== expectedAlpha) {
    throw new RangeError(
      `alpha holds ${alpha.length} values, expected ${expectedAlpha} ` +
        `(${alphaWidth}x${alphaHeight})`,
    );
  }
}

/**
 * Reverse the watermark blend in place over the alpha map's footprint.
 *
 * The region is clipped to the image on all four edges, so a position that
 * hangs off an edge blends the overlapping part and ignores the rest;
 * a fully disjoint region is a no-op. Pixels whose alpha is below
 * {@link ALPHA_SKIP_THRESHOLD} are left byte-identical, as is the A channel
 * of an RGBA buffer.
 *
 * @throws RangeError when the position is not integral, or the buffer
 *   shape, channel count, or alpha length disagree with the declared
 *   dimensions
 */
export function removeWatermarkRegion(
  image: ImageBuffer,
  alpha: Float32Array,
  alphaWidth: number,
  alphaHeight: number,
  position: Point,
  logoValue = 255,
): void {
  validate(image, alpha, alphaWidth, alphaHeight, position);

  const { x, y } = position;
  const x1 = Math.max(0, x);
  const y1 = Math.max(0, y);
  const x2 = Math.min(image.width, x + alphaWidth);
  const y2 = Math.min(image.height, y + alphaHeight);
  if (x1 >= x2 || y1 >= y2) return;

  const { data, channels } = image;
  // `?? 0` throughout: `noUncheckedIndexedAccess` types every typed-array
  // read as possibly undefined. Each index below is provably in range, so
  // the fallback is unreachable — it is there instead of a non-null
  // assertion, which the style rules forbid.
  for (let row = y1; row < y2; row += 1) {
    const alphaRow = (row - y) * alphaWidth - x;
    const pixelRow = row * image.width;
    for (let col = x1; col < x2; col += 1) {
      const sample = alpha[alphaRow + col] ?? 0;
      if (sample < ALPHA_SKIP_THRESHOLD) continue;

      const a = sample > MAX_ALPHA ? MAX_ALPHA : sample;
      const oneMinusAlpha = 1 - a;
      const offset = (pixelRow + col) * channels;
      for (let c = 0; c < COLOR_CHANNELS; c += 1) {
        const watermarked = data[offset + c] ?? 0;
        const original = (watermarked - a * logoValue) / oneMinusAlpha;
        data[offset + c] = quantizeU8(original);
      }
    }
  }
}

/**
 * Composite the watermark onto the image in place, the forward direction of
 * {@link removeWatermarkRegion}.
 *
 * Clipping, the alpha skip threshold and A-channel passthrough behave
 * identically. Note there is deliberately **no** `MAX_ALPHA` clamp here:
 * the forward blend never divides, and upstream applies the ceiling only on
 * the removal path.
 *
 * An add→remove round trip returns the original within ±1 per channel, but
 * that bound comes from the data, not the algebra: the real maps top out
 * near alpha 0.51, where `1/(1 - alpha)` only doubles the quantization
 * error. A synthetic alpha near the ceiling amplifies it by up to 100×, and
 * a round trip there can drift by ~25 levels. Round-trip tests should stay
 * on the real source maps unless they are deliberately probing that.
 *
 * @throws RangeError under the same conditions as {@link removeWatermarkRegion}
 */
export function addWatermarkRegion(
  image: ImageBuffer,
  alpha: Float32Array,
  alphaWidth: number,
  alphaHeight: number,
  position: Point,
  logoValue = 255,
): void {
  validate(image, alpha, alphaWidth, alphaHeight, position);

  const { x, y } = position;
  const x1 = Math.max(0, x);
  const y1 = Math.max(0, y);
  const x2 = Math.min(image.width, x + alphaWidth);
  const y2 = Math.min(image.height, y + alphaHeight);
  if (x1 >= x2 || y1 >= y2) return;

  const { data, channels } = image;
  for (let row = y1; row < y2; row += 1) {
    const alphaRow = (row - y) * alphaWidth - x;
    const pixelRow = row * image.width;
    for (let col = x1; col < x2; col += 1) {
      const a = alpha[alphaRow + col] ?? 0;
      if (a < ALPHA_SKIP_THRESHOLD) continue;

      const oneMinusAlpha = 1 - a;
      const offset = (pixelRow + col) * channels;
      for (let c = 0; c < COLOR_CHANNELS; c += 1) {
        const original = data[offset + c] ?? 0;
        const blended = a * logoValue + oneMinusAlpha * original;
        data[offset + c] = quantizeU8(blended);
      }
    }
  }
}
