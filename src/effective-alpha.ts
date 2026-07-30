/**
 * Which alpha template a given image actually gets.
 *
 * Ported from GeminiWatermarkTool `src/core/watermark_engine.cpp`
 * (`WatermarkEngine::effective_alpha_map` and `create_interpolated_alpha`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * The four calibrated maps cover the canonical sizes. One branch needs
 * more: V2's 36x36 template only fits 1024-class outputs, and larger
 * "small" outputs carry a proportionally scaled logo, so upstream
 * resamples those from the 96px source instead.
 */
import { getSourceAlphaMap, getSourceAlphaMapEdge } from './alpha-maps.js';
import { getWatermarkConfig, getWatermarkSize } from './position.js';
import { resizeArea, resizeBilinear } from './resize.js';
import type { WatermarkSize, WatermarkVariant } from './types.js';

/** Edge length of the 96px sources every derived size comes from. */
const SOURCE_EDGE = 96;

/** A square alpha template and its edge length. */
export interface EffectiveAlphaMap {
  alpha: Float32Array;
  w: number;
  h: number;
}

function squareEdge(alpha: Float32Array): number {
  const edge = Math.round(Math.sqrt(alpha.length));
  if (edge * edge !== alpha.length) {
    throw new RangeError(`alpha map of ${alpha.length} values is not square`);
  }
  return edge;
}

/**
 * Resample the variant's 96px source to a square target.
 *
 * The kernel choice is upstream's: `INTER_LINEAR` when the target grows,
 * `INTER_AREA` when it shrinks, and an untouched copy at exactly 96.
 *
 * Downscales go through the general area path even at 48, where an exact
 * 2x2 box mean would also be available. That is deliberate: measured
 * against the cv2 dump, the separable general path reproduces all 2304
 * values of the 96->48 map bit for bit, while summing each 2x2 block in
 * one go lands one ulp away on 186 of them. Same arithmetic, different
 * accumulation order — and equivalence outranks the shortcut
 * (`resizeAreaIntegerFactor` remains available for callers that want it).
 */
function createInterpolatedAlpha(target: number, variant: WatermarkVariant): Float32Array {
  const source = getSourceAlphaMap(variant, 'large');
  if (target === SOURCE_EDGE) return source;
  return target > SOURCE_EDGE
    ? resizeBilinear(source, SOURCE_EDGE, SOURCE_EDGE, target, target)
    : resizeArea(source, SOURCE_EDGE, SOURCE_EDGE, target, target);
}

/**
 * The alpha template the engine would use for an image of these dimensions.
 *
 * `size` defaults to the dimension-derived class. Passing it explicitly
 * reproduces upstream's forced-size behaviour, quirk included: the size
 * given here selects the template, while the *position* the caller blends
 * at comes from the dimension-derived config — which is exactly why a
 * forced size can place a mismatched template (see
 * `docs/plan/DEVIATIONS.md` D3). Resolving the template is all this
 * function does; it does not attempt to reconcile the two.
 *
 * Returns a fresh buffer each call, like `getSourceAlphaMap`.
 */
export function effectiveAlphaMap(
  variant: WatermarkVariant,
  imageWidth: number,
  imageHeight: number,
  size?: WatermarkSize,
): EffectiveAlphaMap {
  const resolved = size ?? getWatermarkSize(imageWidth, imageHeight);

  // The base map is only decoded once it is known to be the answer. The
  // C++ compares against `base.cols` on a reference it already holds; the
  // edge accessor is the equivalent that avoids building a 36x36 array
  // just to discard it on the derived path, which M4 takes often.
  if (resolved === 'small' && variant === 'V2') {
    const config = getWatermarkConfig(imageWidth, imageHeight, variant);
    if (config.logoSize !== getSourceAlphaMapEdge(variant, resolved)) {
      const alpha = createInterpolatedAlpha(config.logoSize, variant);
      const edge = squareEdge(alpha);
      return { alpha, w: edge, h: edge };
    }
  }

  const base = getSourceAlphaMap(variant, resolved);
  const edge = squareEdge(base);
  return { alpha: base, w: edge, h: edge };
}
