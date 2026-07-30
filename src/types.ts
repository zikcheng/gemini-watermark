/**
 * Shared types for the gemini-watermark engine.
 *
 * Ported from GeminiWatermarkTool (src/core/watermark_engine.hpp),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 */

/**
 * Watermark profile variant.
 *
 * V1 covers outputs from Gemini versions before 3.5; V2 covers outputs
 * from 3.5 onward. The two profiles differ in logo size, margin, and
 * alpha map — the blending math is identical.
 */
export type WatermarkVariant = 'V1' | 'V2';

/** Watermark size class, selected from image dimensions. */
export type WatermarkSize = 'small' | 'large';

/**
 * Watermark placement for a given image: distance from the right/bottom
 * edges and the logo's pixel size.
 */
export interface WatermarkPosition {
  marginRight: number;
  marginBottom: number;
  logoSize: number;
}

/** Top-left pixel coordinates of the watermark region. */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned rectangle in image coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An 8-bit RGB(A) image as a flat pixel buffer (row-major). */
export interface ImageBuffer {
  /** RGBA (4 channels) or RGB (3 channels) interleaved pixel data. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Number of channels per pixel: 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
}

/** The three stage scores behind a detection confidence. */
export interface DetectionScores {
  /** Stage 1: NCC of the grayscale region against the alpha template. */
  spatial: number;
  /**
   * Stage 2: NCC of the two Sobel magnitude maps. Zero on the
   * circuit-breaker path, where the stage never ran.
   */
  gradient: number;
  /**
   * Stage 3: how much the region's texture is dampened relative to the
   * strip above it. Zero on the circuit-breaker path.
   */
  variance: number;
}

/**
 * Result of running the three-stage detector for **one** variant.
 *
 * See `docs/api-contract.md` for the full semantics; the traps worth
 * repeating here are that `internalDetected` is not the gate, and that a
 * circuit-broken confidence is unclamped and can be negative.
 */
export interface DetectionResult {
  variant: WatermarkVariant;
  size: WatermarkSize;
  /**
   * Where the watermark was found. For V2 small this is the snapped
   * position when the ±3px sweep correlated at 0.60 or better, and the
   * formula position otherwise.
   */
  region: Rect;
  /**
   * Fused score: `0.50·spatial + 0.30·gradient + 0.20·variance` clamped to
   * [0, 1], then raised to `spatial` when `spatial >= 0.30`. On the
   * circuit-breaker path it is `spatial × 0.5` and is **not** clamped.
   */
  confidence: number;
  scores: DetectionScores;
  /** True when stage 1 aborted detection early (spatial NCC < 0.25). */
  circuitBreaker: boolean;
  /**
   * Upstream's internal `confidence >= 0.35` label — informational only.
   * The gate that decides whether an image is modified is `processImage`'s
   * `threshold`.
   */
  internalDetected: boolean;
}

/** Options for {@link DetectionResult}-producing single-variant detection. */
export interface DetectOptions {
  /** Which profile to test. Defaults to `'V2'`, the current one. */
  variant?: WatermarkVariant;
  /** Overrides the size class otherwise derived from the dimensions. */
  size?: WatermarkSize;
}

/** Whether an image was modified. There is no error status — invalid input throws. */
export type ProcessStatus = 'processed' | 'skipped';

/**
 * Outcome of the full detect-and-remove (or add) pipeline.
 *
 * On `'skipped'` the image buffer is byte-identical to what was passed in.
 */
export interface ProcessResult {
  status: ProcessStatus;
  /**
   * Confidence of the reported attempt, or 0 when no gate ran (`force`,
   * or `mode: 'add'`). When every attempt skipped, this is the
   * highest-scoring one rather than the last.
   */
  confidence: number;
  /** Present when processed. */
  variant?: WatermarkVariant;
  /** Present when processed. */
  size?: WatermarkSize;
  /** Present when processed. */
  region?: Rect;
  /**
   * The gate detections in the order they were tried — V2, then V1 if the
   * fallback ran. Excludes the re-detection removal performs internally to
   * refine the position, and is empty when no gate ran.
   */
  attempts: DetectionResult[];
}

/** Options for the full pipeline. */
export interface ProcessOptions {
  /** Default `'remove'`. `'add'` has no detection concept. */
  mode?: 'remove' | 'add';
  /** Gate for removal, compared with `>=`. Default 0.25. */
  threshold?: number;
  /** Try V1 after V2 skips. Default true; only applies when `variant` is unset. */
  autoFallback?: boolean;
  /**
   * Skip the gate entirely. `threshold` is then ignored rather than
   * rejected, the internal snap detection still runs, and no fallback is
   * attempted. Default false.
   */
  force?: boolean;
  /** Pin the profile. Setting this disables the fallback. */
  variant?: WatermarkVariant;
  /**
   * Force the size class. Reproduces the upstream quirk where the template
   * follows this while the position does not — see DEVIATIONS D3.
   */
  size?: WatermarkSize;
  /** Value the watermark blends toward. Default 255 (white). */
  logoValue?: number;
}
