/**
 * Watermark position and size configuration.
 *
 * Ported from GeminiWatermarkTool (src/core/watermark_engine.cpp:
 * get_watermark_config, get_watermark_size, v2_small_config_from_dims),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 */

import type { Point, WatermarkPosition, WatermarkSize, WatermarkVariant } from './types.js';

/**
 * Round half away from zero — the semantics of C++ std::round.
 *
 * JS Math.round rounds half toward +Infinity (Math.round(-0.5) === -0),
 * which diverges on negative halves. All margin/logo computations must
 * use this to stay bit-identical with the reference implementation.
 */
export function roundHalfAwayFromZero(v: number): number {
  return Math.sign(v) * Math.round(Math.abs(v));
}

/**
 * Size class from image dimensions: large (96px logo) only when BOTH
 * dimensions exceed 1024; 1024x1024 itself is small.
 */
export function getWatermarkSize(imageWidth: number, imageHeight: number): WatermarkSize {
  return imageWidth > 1024 && imageHeight > 1024 ? 'large' : 'small';
}

/**
 * V2 small placement, inferred from the canonical large source the image
 * was downscaled from. Small Gemini outputs are 1024-class on the long
 * side and inherit per-axis rounding from the source aspect ratio, so a
 * single fixed margin does not fit every aspect.
 *
 * Half-scale outputs (free-tier 1376/1408/1424-class) identify their
 * canonical directly: twice the long side lands on 2752/2816/2848.
 * 1024-class outputs are inferred from the short side; thresholds bisect
 * the observed canonical heights (540, 559, 572).
 */
function v2SmallConfigFromDims(width: number, height: number): WatermarkPosition {
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);

  let sourceLongDim: number;
  if (longSide > 1100) {
    const doubled = 2 * longSide;
    sourceLongDim = 2752;
    for (const cand of [2816, 2848]) {
      if (Math.abs(doubled - cand) < Math.abs(doubled - sourceLongDim)) {
        sourceLongDim = cand;
      }
    }
  } else if (shortSide >= 566) {
    sourceLongDim = 2752;
  } else if (shortSide >= 550) {
    sourceLongDim = 2816;
  } else {
    sourceLongDim = 2848;
  }

  const scale = longSide / sourceLongDim;
  const margin = roundHalfAwayFromZero(192 * scale);
  // Logo size scales with the canonical source like the margin does.
  // 1024-class outputs land at ~35-36px where the canonical 36 template
  // matches either rounding; larger "small" outputs (e.g. 1376x768, half
  // of canonical 2752x1536) carry a proportionally bigger logo (48px).
  const ideal = roundHalfAwayFromZero(96 * scale);
  return {
    marginRight: margin,
    marginBottom: margin,
    logoSize: ideal <= 40 ? 36 : ideal,
  };
}

/**
 * Watermark placement for a given image size and profile variant.
 */
export function getWatermarkConfig(
  imageWidth: number,
  imageHeight: number,
  variant: WatermarkVariant = 'V2',
): WatermarkPosition {
  const isLarge = imageWidth > 1024 && imageHeight > 1024;
  if (variant === 'V1') {
    return isLarge
      ? { marginRight: 64, marginBottom: 64, logoSize: 96 }
      : { marginRight: 32, marginBottom: 32, logoSize: 48 };
  }
  // V2: large stays at 192 margin / 96 logo, matching the canonical
  // 2752/2816/2848-wide outputs exactly; small needs aspect-aware scaling.
  if (isLarge) {
    return { marginRight: 192, marginBottom: 192, logoSize: 96 };
  }
  return v2SmallConfigFromDims(imageWidth, imageHeight);
}

/** Top-left position of the watermark region for an image. */
export function getWatermarkTopLeft(
  config: WatermarkPosition,
  imageWidth: number,
  imageHeight: number,
): Point {
  return {
    x: imageWidth - config.marginRight - config.logoSize,
    y: imageHeight - config.marginBottom - config.logoSize,
  };
}
