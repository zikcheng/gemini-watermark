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

/** An 8-bit RGB(A) image as a flat pixel buffer (row-major). */
export interface ImageBuffer {
  /** RGBA (4 channels) or RGB (3 channels) interleaved pixel data. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Number of channels per pixel: 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
}

/** Result of the three-stage watermark detection. */
export interface DetectionResult {
  detected: boolean;
  /** Fused confidence in [0, 1]. */
  confidence: number;
  /** Detected watermark region (top-left + size). */
  region: { x: number; y: number; width: number; height: number };
  size: WatermarkSize;
  variant: WatermarkVariant;
  /** Stage 1: spatial NCC score. */
  spatialScore: number;
  /** Stage 2: gradient NCC score. */
  gradientScore: number;
  /** Stage 3: variance-dampening score. */
  varianceScore: number;
  /** True when stage 1 aborted detection early (spatial NCC < 0.25). */
  circuitBreaker: boolean;
}
