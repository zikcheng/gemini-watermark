/**
 * The image primitives the detector needs, reimplemented from OpenCV.
 *
 * Ported from the OpenCV calls in GeminiWatermarkTool
 * `src/core/watermark_engine.cpp` `detect_one_variant`
 * (`cv::cvtColor(..., COLOR_BGR2GRAY)` and `cv::meanStdDev`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * OpenCV's real numbers differ from the textbook formulas in ways that
 * silently move detection scores, so these follow measurements of the
 * pinned opencv-python (`test/data/imageops/`) rather than any derivation.
 */
import type { ImageBuffer } from './types.js';

/**
 * Fixed-point BT.601 luma weights, scaled by 2^15
 * (`R * 0.299 + G * 0.587 + B * 0.114` rounded to 15-bit integers).
 *
 * Copied from OpenCV's 8-bit `COLOR_BGR2GRAY` path, not recomputed — the
 * float formula and this integer one disagree on real images, and it is
 * this one the reference binary runs (CLAUDE.md rule 2).
 */
const R_WEIGHT = 9798;
const G_WEIGHT = 19235;
const B_WEIGHT = 3735;

/** Half of 2^15, added before the shift so the truncation rounds half up. */
const ROUND_HALF = 16384;
const SHIFT = 15;

/**
 * Convert an RGB(A) image to 8-bit grayscale, byte for byte as OpenCV does.
 *
 * The weights attach to **colours**, not to byte positions: OpenCV applies
 * them to a BGR buffer and this applies the same numbers to R, G and B of
 * an RGB buffer, so both produce the same byte. That is why nothing here
 * reverses channels — doing so would be the bug, not the fix.
 *
 * The arithmetic is integer throughout. Rounding here is a half-up shift,
 * which is neither of the port's other two rounding laws (CLAUDE.md rule 5)
 * — do not reach for `roundHalfAwayFromZero` or `quantizeU8`.
 *
 * @throws RangeError when the buffer shape or channel count is invalid
 */
export function toGrayscale(image: ImageBuffer): Uint8Array {
  const { data, width, height, channels } = image;
  if (channels !== 3 && channels !== 4) {
    throw new RangeError(
      `image.channels is ${String(channels)}, expected 3 (RGB) or 4 (RGBA)`,
    );
  }
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new RangeError(
      `image.data holds ${data.length} bytes, expected ${expected} ` +
        `(${width}x${height}x${channels})`,
    );
  }

  const pixels = width * height;
  const gray = new Uint8Array(pixels);
  // `?? 0` is unreachable — every index below is in range. It stands in for
  // a non-null assertion, which the style rules forbid under
  // noUncheckedIndexedAccess.
  for (let i = 0; i < pixels; i += 1) {
    const at = i * channels;
    const r = data[at] ?? 0;
    const g = data[at + 1] ?? 0;
    const b = data[at + 2] ?? 0;
    gray[i] = (r * R_WEIGHT + g * G_WEIGHT + b * B_WEIGHT + ROUND_HALF) >> SHIFT;
  }
  return gray;
}

/** Mean and population standard deviation of a single-channel image. */
export interface MeanStdDev {
  mean: number;
  std: number;
}

/**
 * Mean and standard deviation over every sample, matching `cv::meanStdDev`.
 *
 * OpenCV's is the **population** deviation — it divides by N, not N-1. The
 * detector's stage 3 forms a ratio of two of these, so using the sample
 * form would bias every variance score.
 *
 * Note what upstream feeds this: the **uint8** grayscale regions, not the
 * `/255` float. Passing the float version would shrink the deviation by a
 * factor of 255 and quietly change every score
 * (`meanStdDev(gray_region, ...)` in `detect_one_variant`).
 *
 * @throws RangeError on an empty input, where neither statistic is defined
 */
export function meanStdDev(data: Float32Array | Uint8Array): MeanStdDev {
  const n = data.length;
  if (n === 0) {
    throw new RangeError('meanStdDev needs at least one sample, got an empty array');
  }

  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += data[i] ?? 0;
  const mean = sum / n;

  // Two passes rather than the sum-of-squares shortcut: subtracting two
  // large nearly-equal numbers loses most of the significant digits on
  // real image data, and the dual tolerance these are checked against is
  // tight enough to see it.
  let sumSquares = 0;
  for (let i = 0; i < n; i += 1) {
    const delta = (data[i] ?? 0) - mean;
    sumSquares += delta * delta;
  }

  return { mean, std: Math.sqrt(sumSquares / n) };
}
