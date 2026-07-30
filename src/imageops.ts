/**
 * The image primitives the detector needs, reimplemented from OpenCV.
 *
 * Ported from the OpenCV calls in GeminiWatermarkTool
 * `src/core/watermark_engine.cpp` `detect_one_variant`
 * (`cv::cvtColor(..., COLOR_BGR2GRAY)`, `cv::Sobel` + `cv::magnitude`,
 * `cv::matchTemplate(..., TM_CCOEFF_NORMED)` and `cv::meanStdDev`),
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

/**
 * Reflect an out-of-range index back inside, OpenCV's `BORDER_REFLECT_101`.
 *
 * The edge sample itself is not repeated: -1 maps to 1 and `n` maps to
 * `n - 2`, so the border pixel's own value never enters twice. That is the
 * default border for `cv::Sobel`, which upstream leaves unset.
 */
function reflect101(index: number, n: number): number {
  if (n === 1) return 0;
  if (index < 0) return -index;
  if (index >= n) return 2 * (n - 1) - index;
  return index;
}

/**
 * 3x3 Sobel gradient magnitude, `sqrt(gx^2 + gy^2)`.
 *
 * Stage 2 of detection runs this over both the grayscale ROI and the alpha
 * template, then correlates the two edge maps
 * (`Sobel(src, CV_32F, 1, 0, 3)` / `(0, 1, 3)` then `magnitude`, with every
 * other parameter left at its default: scale 1, delta 0, BORDER_DEFAULT).
 *
 * The separable kernels OpenCV builds for `ksize=3` combine to
 * `gx = [[-1,0,1],[-2,0,2],[-1,0,1]]` and its transpose for `gy`. The
 * magnitude is sign-agnostic, so the orientation convention cannot change
 * the result — verified against the dump either way.
 *
 * @throws RangeError when the buffer length disagrees with the dimensions
 */
export function sobelMagnitude(
  gray: Float32Array,
  width: number,
  height: number,
): Float32Array {
  if (gray.length !== width * height) {
    throw new RangeError(
      `gray holds ${gray.length} values, expected ${width * height} ` +
        `(${width}x${height})`,
    );
  }

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    // Border reflection resolved per row and per column rather than per
    // tap: three row offsets and three column offsets cover all nine.
    const yUp = reflect101(y - 1, height) * width;
    const yMid = y * width;
    const yDown = reflect101(y + 1, height) * width;

    for (let x = 0; x < width; x += 1) {
      const xLeft = reflect101(x - 1, width);
      const xRight = reflect101(x + 1, width);

      const tl = gray[yUp + xLeft] ?? 0;
      const tc = gray[yUp + x] ?? 0;
      const tr = gray[yUp + xRight] ?? 0;
      const ml = gray[yMid + xLeft] ?? 0;
      const mr = gray[yMid + xRight] ?? 0;
      const bl = gray[yDown + xLeft] ?? 0;
      const bc = gray[yDown + x] ?? 0;
      const br = gray[yDown + xRight] ?? 0;

      const gx = tr - tl + 2 * (mr - ml) + br - bl;
      const gy = bl - tl + 2 * (bc - tc) + br - tr;
      out[yMid + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

/**
 * Normalized cross-correlation, OpenCV's `TM_CCOEFF_NORMED`.
 *
 * For every placement of the template, both patches are mean-centred and
 * their correlation is divided by the product of their energies:
 * `sum(T' * I') / sqrt(sum(T'^2) * sum(I'^2))`. The result is
 * `(ih - th + 1) x (iw - tw + 1)`.
 *
 * The loop is the naive O(n^4) form. The regions in this project are tiny
 * — a 96x96 template over a 112x112 ROI is 17x17 placements — and a
 * transparent implementation is worth more here than a DFT.
 *
 * **Zero-variance behaviour is calibrated against the dump, not reasoned
 * out.** `test/data/imageops/match-template-ccoeff-normed.json` measures
 * what the pinned cv2 does, and it is asymmetric: a constant *template*
 * scores 1 everywhere regardless of the image, while a flat region under a
 * varying template scores 0. Neither produces NaN. The template test comes
 * first, so both-constant scores 1.
 *
 * The comparison is against exact zero rather than an epsilon because
 * exact zero is the *right* test here, not merely a tolerable one.
 * `regionEnergy` is a sum of squares: every term is non-negative, so
 * there is no cancellation to leave a small non-zero residue where the
 * true value is zero. And for a region that really is flat, the float64
 * arithmetic is exact — the samples are float32, a sum of at most 2^29 of
 * them still fits the 53-bit significand, so the mean rounds back to the
 * sample value itself and every difference is exactly 0. Measured across
 * ordinary values, 1/255 and a denormal alike.
 *
 * An epsilon would not be a safety net so much as a second, different
 * rule: the near-degenerate case's non-flat placements carry an energy of
 * 9.4e-3, some ten orders of magnitude above any epsilon one would pick,
 * so it would change nothing here while quietly diverging elsewhere.
 *
 * This exactness holds on the operand domain the detector actually uses;
 * see `docs/plan/DEVIATIONS.md` D6 for where cv2's own (relative)
 * criterion and this one would part company, and why that region is
 * unreachable from uint8 pixels.
 *
 * @throws RangeError when a buffer disagrees with its dimensions, or the
 *   template does not fit inside the image
 */
export function matchTemplateCcoeffNormed(
  image: Float32Array,
  imageWidth: number,
  imageHeight: number,
  template: Float32Array,
  templateWidth: number,
  templateHeight: number,
): Float32Array {
  if (image.length !== imageWidth * imageHeight) {
    throw new RangeError(
      `image holds ${image.length} values, expected ${imageWidth * imageHeight} ` +
        `(${imageWidth}x${imageHeight})`,
    );
  }
  if (template.length !== templateWidth * templateHeight) {
    throw new RangeError(
      `template holds ${template.length} values, expected ` +
        `${templateWidth * templateHeight} (${templateWidth}x${templateHeight})`,
    );
  }
  if (templateWidth > imageWidth || templateHeight > imageHeight) {
    throw new RangeError(
      `template ${templateWidth}x${templateHeight} does not fit inside image ` +
        `${imageWidth}x${imageHeight}`,
    );
  }

  const resultWidth = imageWidth - templateWidth + 1;
  const resultHeight = imageHeight - templateHeight + 1;
  const result = new Float32Array(resultWidth * resultHeight);
  const templateArea = templateWidth * templateHeight;

  // Template statistics do not depend on where the template sits, so they
  // are computed once instead of on every placement.
  let templateSum = 0;
  for (let i = 0; i < templateArea; i += 1) templateSum += template[i] ?? 0;
  const templateMean = templateSum / templateArea;

  let templateEnergy = 0;
  for (let i = 0; i < templateArea; i += 1) {
    const centred = (template[i] ?? 0) - templateMean;
    templateEnergy += centred * centred;
  }

  if (templateEnergy === 0) {
    return result.fill(1);
  }
  const templateNorm = Math.sqrt(templateEnergy);

  for (let top = 0; top < resultHeight; top += 1) {
    for (let left = 0; left < resultWidth; left += 1) {
      let regionSum = 0;
      for (let ty = 0; ty < templateHeight; ty += 1) {
        const row = (top + ty) * imageWidth + left;
        for (let tx = 0; tx < templateWidth; tx += 1) {
          regionSum += image[row + tx] ?? 0;
        }
      }
      const regionMean = regionSum / templateArea;

      let covariance = 0;
      let regionEnergy = 0;
      for (let ty = 0; ty < templateHeight; ty += 1) {
        const row = (top + ty) * imageWidth + left;
        const templateRow = ty * templateWidth;
        for (let tx = 0; tx < templateWidth; tx += 1) {
          const regionCentred = (image[row + tx] ?? 0) - regionMean;
          const templateCentred = (template[templateRow + tx] ?? 0) - templateMean;
          covariance += regionCentred * templateCentred;
          regionEnergy += regionCentred * regionCentred;
        }
      }

      result[top * resultWidth + left] =
        regionEnergy === 0 ? 0 : covariance / (templateNorm * Math.sqrt(regionEnergy));
    }
  }
  return result;
}
