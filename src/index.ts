/**
 * gemini-watermark — deterministic Gemini visible-watermark engine.
 *
 * TypeScript port of GeminiWatermarkTool
 * (https://github.com/allenk/GeminiWatermarkTool),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * This file *is* the public surface: `docs/api-contract.md` says what each
 * export promises, and nothing outside this list is API. The port's
 * internals — the three rounding laws, the OpenCV-compatible image
 * primitives, the resampling kernels, alpha-size resolution — stay
 * unexported on purpose. They exist to match one specific OpenCV build,
 * and publishing them would turn compatibility decisions into promises.
 */

export type {
  DetectOptions,
  DetectionResult,
  DetectionScores,
  ImageBuffer,
  Point,
  ProcessOptions,
  ProcessResult,
  ProcessStatus,
  Rect,
  WatermarkPosition,
  WatermarkSize,
  WatermarkVariant,
} from './types.js';

export { getSourceAlphaMap } from './alpha-maps.js';

export { addWatermarkRegion, removeWatermarkRegion } from './blend.js';

export { detectWatermark } from './detect.js';

export { processImage } from './pipeline.js';

export { passesThreshold } from './gating.js';

export {
  getWatermarkConfig,
  getWatermarkSize,
  getWatermarkTopLeft,
} from './position.js';

// Video support is an extension beyond the upstream port — see the
// provenance notes in src/video.ts and docs/plan/DEVIATIONS.md D8.
export type {
  VideoCalibration,
  VideoCalibrationSource,
  VideoCalibrator,
  VideoRemoveOptions,
  VideoWatermarkConfig,
} from './video.js';

export {
  VIDEO_LOGO_SIZE,
  VIDEO_MARGIN,
  createVideoCalibrator,
  getVideoWatermarkConfig,
  removeVideoWatermark,
} from './video.js';
