/**
 * The three-stage watermark detector.
 *
 * Ported from GeminiWatermarkTool `src/core/watermark_engine.cpp`
 * (`WatermarkEngine::detect_one_variant`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * Detection is the safety gate: it decides whether an image is modified at
 * all, so a user who feeds in an unwatermarked photo gets it back
 * untouched. Three weighted stages vote — spatial correlation against the
 * alpha template, correlation of the two edge maps, and how much the
 * region's texture is dampened relative to the strip above it — with a
 * circuit breaker that abandons the last two when the first is hopeless,
 * and a rescue that lets a strong anchored match carry a weak fusion.
 *
 * This function tests **one** variant. Trying V2 and falling back to V1 is
 * orchestration, and lives in `processImage`.
 */
import { effectiveAlphaMap } from './effective-alpha.js';
import {
  fuseConfidence,
  meetsInternalLabel,
  snapTrusted,
  spatialCircuitBroken,
} from './gating.js';
import {
  matchTemplateCcoeffNormed,
  meanStdDev,
  sobelMagnitude,
  toGrayscale,
} from './imageops.js';
import { getWatermarkConfig, getWatermarkSize, getWatermarkTopLeft } from './position.js';
import type {
  DetectOptions,
  DetectionResult,
  ImageBuffer,
  Rect,
  WatermarkSize,
  WatermarkVariant,
} from './types.js';

/**
 * How far the V2 small sweep looks either side of the formula position.
 *
 * V2 small positions are inferred from a guessed canonical source and land
 * within a pixel or three; a narrow sweep absorbs that rounding noise
 * without giving content artefacts room to outscore the real watermark.
 */
const SNAP_PAD = 3;

/** Stage 3 needs a reference strip taller than this to be meaningful. */
const MIN_REFERENCE_HEIGHT = 8;

/** ...and a reference deviation above this, or the ratio says nothing. */
const MIN_REFERENCE_STDDEV = 5.0;

function validate(image: ImageBuffer): void {
  if (image.channels !== 3 && image.channels !== 4) {
    throw new RangeError(
      `image.channels is ${String(image.channels)}, expected 3 (RGB) or 4 (RGBA)`,
    );
  }
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    throw new RangeError(
      `image dimensions must be positive integers, got ${image.width}x${image.height}`,
    );
  }
  const expected = image.width * image.height * image.channels;
  if (image.data.length !== expected) {
    throw new RangeError(
      `image.data holds ${image.data.length} bytes, expected ${expected} ` +
        `(${image.width}x${image.height}x${image.channels})`,
    );
  }
}

/** Copy a rectangle out of an image as its own buffer. */
function cropped(image: ImageBuffer, x: number, y: number, w: number, h: number): ImageBuffer {
  const { channels } = image;
  const rowBytes = w * channels;
  const data = new Uint8Array(h * rowBytes);
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * image.width + x) * channels;
    data.set(image.data.subarray(from, from + rowBytes), row * rowBytes);
  }
  return { data, width: w, height: h, channels };
}

/** Crop a rectangle out of a single-channel float map. */
function croppedAlpha(
  alpha: Float32Array,
  alphaWidth: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Float32Array {
  const out = new Float32Array(w * h);
  for (let row = 0; row < h; row += 1) {
    const from = (y + row) * alphaWidth + x;
    out.set(alpha.subarray(from, from + w), row * w);
  }
  return out;
}

/** Peak value and its position, matching `cv::minMaxLoc`'s max side. */
function peak(values: Float32Array, width: number): { value: number; x: number; y: number } {
  let best = -Infinity;
  let at = 0;
  for (let i = 0; i < values.length; i += 1) {
    // Strictly greater, so the first of equal peaks wins — the scan order
    // OpenCV uses, which matters when a flat region ties.
    const value = values[i] ?? 0;
    if (value > best) {
      best = value;
      at = i;
    }
  }
  return { value: best, x: at % width, y: Math.floor(at / width) };
}

/**
 * Run the three-stage detector for one variant.
 *
 * @throws RangeError when the buffer shape, channel count or dimensions
 *   are invalid
 */
export function detectWatermark(
  image: ImageBuffer,
  options: DetectOptions = {},
): DetectionResult {
  validate(image);

  const variant: WatermarkVariant = options.variant ?? 'V2';
  const size: WatermarkSize = options.size ?? getWatermarkSize(image.width, image.height);

  // The config is dimension-derived and ignores a forced size — that
  // asymmetry is what makes forced sizes misplace the template, and it is
  // reproduced rather than reconciled (DEVIATIONS D3).
  const config = getWatermarkConfig(image.width, image.height, variant);
  const formula = getWatermarkTopLeft(config, image.width, image.height);
  const template = effectiveAlphaMap(variant, image.width, image.height, size);

  const needsSnap = variant === 'V2' && size === 'small';
  const snapPad = needsSnap ? SNAP_PAD : 0;

  let region: Rect = {
    x: formula.x,
    y: formula.y,
    width: template.w,
    height: template.h,
  };
  const empty: DetectionResult = {
    variant,
    size,
    region,
    confidence: 0,
    scores: { spatial: 0, gradient: 0, variance: 0 },
    circuitBreaker: false,
    internalDetected: false,
  };

  const x1 = Math.max(0, formula.x - snapPad);
  const y1 = Math.max(0, formula.y - snapPad);
  const x2 = Math.min(image.width, formula.x + template.w + snapPad);
  const y2 = Math.min(image.height, formula.y + template.h + snapPad);
  // The watermark sits entirely outside the image. Upstream logs
  // "Detection: ROI out of bounds" and returns the zeroed result with the
  // formula region intact; no fixture reaches this, but the branch is real.
  if (x1 >= x2 || y1 >= y2) return empty;

  const roiWidth = x2 - x1;
  const roiHeight = y2 - y1;

  // Grayscale first, then scale — quantising to uint8 before the float
  // conversion is the order upstream uses, and stage 3 needs the uint8
  // form anyway (CLAUDE.md rule 2).
  const grayRegion = toGrayscale(cropped(image, x1, y1, roiWidth, roiHeight));
  const grayFloat = new Float32Array(grayRegion.length);
  for (let i = 0; i < grayRegion.length; i += 1) grayFloat[i] = (grayRegion[i] ?? 0) / 255;

  // Snap mode slides the whole template across a widened region; otherwise
  // the template is cropped to whatever part of it the image contains.
  const alphaRegion = needsSnap
    ? template.alpha
    : croppedAlpha(template.alpha, template.w, x1 - formula.x, y1 - formula.y, roiWidth, roiHeight);
  const alphaWidth = needsSnap ? template.w : roiWidth;
  const alphaHeight = needsSnap ? template.h : roiHeight;

  // —— Stage 1: spatial correlation against the alpha template ——
  const spatialMatch = matchTemplateCcoeffNormed(
    grayFloat,
    roiWidth,
    roiHeight,
    alphaRegion,
    alphaWidth,
    alphaHeight,
  );
  const best = peak(spatialMatch, roiWidth - alphaWidth + 1);
  const spatial = best.value;

  if (needsSnap && snapTrusted(spatial)) {
    region = { x: x1 + best.x, y: y1 + best.y, width: template.w, height: template.h };
  }

  if (spatialCircuitBroken(spatial)) {
    return {
      variant,
      size,
      region,
      // Deliberately unclamped, as upstream leaves it — a negative
      // correlation yields a negative confidence.
      confidence: spatial * 0.5,
      scores: { spatial, gradient: 0, variance: 0 },
      circuitBreaker: true,
      internalDetected: false,
    };
  }

  // —— Stage 2: correlation of the two edge maps ——
  const imageEdges = sobelMagnitude(grayFloat, roiWidth, roiHeight);
  const alphaEdges = sobelMagnitude(alphaRegion, alphaWidth, alphaHeight);
  const gradientMatch = matchTemplateCcoeffNormed(
    imageEdges,
    roiWidth,
    roiHeight,
    alphaEdges,
    alphaWidth,
    alphaHeight,
  );
  const gradient = peak(gradientMatch, roiWidth - alphaWidth + 1).value;

  // —— Stage 3: texture dampening against the strip above ——
  let variance = 0;
  const referenceHeight = Math.min(y1, config.logoSize);
  if (referenceHeight > MIN_REFERENCE_HEIGHT) {
    const reference = toGrayscale(
      cropped(image, x1, y1 - referenceHeight, roiWidth, referenceHeight),
    );
    // Both statistics come from the uint8 grays, not the scaled floats;
    // using the floats would divide every deviation by 255 and change
    // every score.
    const watermarked = meanStdDev(grayRegion);
    const above = meanStdDev(reference);
    if (above.std > MIN_REFERENCE_STDDEV) {
      const ratio = 1 - watermarked.std / above.std;
      variance = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    }
  }

  const confidence = fuseConfidence(spatial, gradient, variance);
  return {
    variant,
    size,
    region,
    confidence,
    scores: { spatial, gradient, variance },
    circuitBreaker: false,
    internalDetected: meetsInternalLabel(confidence),
  };
}
