/**
 * gemini-watermark — deterministic Gemini visible-watermark engine.
 *
 * TypeScript port of GeminiWatermarkTool
 * (https://github.com/allenk/GeminiWatermarkTool),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 */

export type {
  DetectionResult,
  ImageBuffer,
  Point,
  WatermarkPosition,
  WatermarkSize,
  WatermarkVariant,
} from './types.js';

export { getSourceAlphaMap } from './alpha-maps.js';

export {
  getWatermarkConfig,
  getWatermarkSize,
  getWatermarkTopLeft,
  roundHalfAwayFromZero,
} from './position.js';
