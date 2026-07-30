/**
 * The two resampling kernels the alpha maps are derived with.
 *
 * Ported from the `cv::resize` calls in GeminiWatermarkTool
 * `src/core/watermark_engine.cpp` `create_interpolated_alpha`,
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * Upstream picks `INTER_LINEAR` when a target dimension grows and
 * `INTER_AREA` otherwise. Both are reimplemented here from OpenCV's
 * measured behaviour (`test/data/imageops/resize-alpha.*`), never from a
 * generic resampling library: the coverage weighting of INTER_AREA and the
 * half-pixel centres of INTER_LINEAR are exactly the kind of convention a
 * substitute would get subtly wrong (CLAUDE.md porting rule 6).
 */

function checkSource(src: Float32Array, width: number, height: number): void {
  if (src.length !== width * height) {
    throw new RangeError(
      `source holds ${src.length} values, expected ${width * height} ` +
        `(${width}x${height})`,
    );
  }
}

function checkTarget(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(
      `target size must be positive integers, got ${width}x${height}`,
    );
  }
}

/**
 * Downscale by an exact integer factor: the mean of each `factor x factor`
 * block.
 *
 * This is the case `INTER_AREA` reduces to when the source divides evenly,
 * and it is the one the port hits most — the 48px half-scale alpha class
 * is exactly 96 / 2. Kept separate because the general path's interval
 * arithmetic is needless work when every weight is 1.
 *
 * @throws RangeError when the factor does not divide both dimensions
 */
export function resizeAreaIntegerFactor(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  factor: number,
): Float32Array {
  checkSource(src, srcWidth, srcHeight);
  if (!Number.isInteger(factor) || factor < 1) {
    throw new RangeError(`factor must be a positive integer, got ${factor}`);
  }
  if (srcWidth % factor !== 0 || srcHeight % factor !== 0) {
    throw new RangeError(
      `factor ${factor} does not divide ${srcWidth}x${srcHeight} evenly`,
    );
  }

  const dstWidth = srcWidth / factor;
  const dstHeight = srcHeight / factor;
  const out = new Float32Array(dstWidth * dstHeight);
  const area = factor * factor;

  for (let dy = 0; dy < dstHeight; dy += 1) {
    for (let dx = 0; dx < dstWidth; dx += 1) {
      let sum = 0;
      for (let ky = 0; ky < factor; ky += 1) {
        const row = (dy * factor + ky) * srcWidth + dx * factor;
        for (let kx = 0; kx < factor; kx += 1) sum += src[row + kx] ?? 0;
      }
      out[dy * dstWidth + dx] = sum / area;
    }
  }
  return out;
}

/**
 * Pixel-coverage weighted downscale, OpenCV's `INTER_AREA`.
 *
 * Destination pixel `dx` draws from the source interval
 * `[dx * sw / dw, (dx + 1) * sw / dw)`, each source pixel contributing in
 * proportion to how much of it the interval covers; partial pixels at both
 * ends count fractionally. The 2-D case is the separable product of the
 * two 1-D weightings, so the horizontal pass runs once per source row and
 * the vertical pass combines those rows.
 *
 * @throws RangeError on a malformed source or a non-positive target
 */
export function resizeArea(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  checkSource(src, srcWidth, srcHeight);
  checkTarget(dstWidth, dstHeight);

  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;

  // Horizontal pass into a scratch buffer of dstWidth x srcHeight, then a
  // vertical pass. One allocation each, none inside the loops.
  const horizontal = new Float32Array(dstWidth * srcHeight);
  for (let sy = 0; sy < srcHeight; sy += 1) {
    const srcRow = sy * srcWidth;
    const dstRow = sy * dstWidth;
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const start = dx * scaleX;
      const end = (dx + 1) * scaleX;
      let sum = 0;
      let sx = Math.floor(start);
      while (sx < end && sx < srcWidth) {
        // Overlap between source pixel [sx, sx+1) and the target interval.
        const left = sx > start ? sx : start;
        const right = sx + 1 < end ? sx + 1 : end;
        const weight = right - left;
        if (weight > 0) sum += (src[srcRow + sx] ?? 0) * weight;
        sx += 1;
      }
      horizontal[dstRow + dx] = sum / scaleX;
    }
  }

  const out = new Float32Array(dstWidth * dstHeight);
  for (let dy = 0; dy < dstHeight; dy += 1) {
    const start = dy * scaleY;
    const end = (dy + 1) * scaleY;
    for (let dx = 0; dx < dstWidth; dx += 1) {
      let sum = 0;
      let sy = Math.floor(start);
      while (sy < end && sy < srcHeight) {
        const top = sy > start ? sy : start;
        const bottom = sy + 1 < end ? sy + 1 : end;
        const weight = bottom - top;
        if (weight > 0) sum += (horizontal[sy * dstWidth + dx] ?? 0) * weight;
        sy += 1;
      }
      out[dy * dstWidth + dx] = sum / scaleY;
    }
  }
  return out;
}

/**
 * Bilinear resampling with half-pixel centres, OpenCV's `INTER_LINEAR`.
 *
 * The source coordinate of destination pixel `dx` is
 * `(dx + 0.5) * sw / dw - 0.5`: both grids are treated as samples at pixel
 * *centres* rather than corners, which is what keeps the image from
 * drifting by half a pixel. Coordinates falling outside the source are
 * clamped to the edge sample.
 *
 * @throws RangeError on a malformed source or a non-positive target
 */
export function resizeBilinear(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  checkSource(src, srcWidth, srcHeight);
  checkTarget(dstWidth, dstHeight);

  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  const out = new Float32Array(dstWidth * dstHeight);

  for (let dy = 0; dy < dstHeight; dy += 1) {
    let fy = (dy + 0.5) * scaleY - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    const y1 = y0 + 1 < srcHeight ? y0 + 1 : srcHeight - 1;
    const row0 = (y0 < srcHeight ? y0 : srcHeight - 1) * srcWidth;
    const row1 = y1 * srcWidth;

    for (let dx = 0; dx < dstWidth; dx += 1) {
      let fx = (dx + 0.5) * scaleX - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const x1 = x0 + 1 < srcWidth ? x0 + 1 : srcWidth - 1;
      const xa = x0 < srcWidth ? x0 : srcWidth - 1;

      const topLeft = src[row0 + xa] ?? 0;
      const topRight = src[row0 + x1] ?? 0;
      const bottomLeft = src[row1 + xa] ?? 0;
      const bottomRight = src[row1 + x1] ?? 0;

      const top = topLeft + (topRight - topLeft) * wx;
      const bottom = bottomLeft + (bottomRight - bottomLeft) * wx;
      out[dy * dstWidth + dx] = top + (bottom - top) * wy;
    }
  }
  return out;
}
