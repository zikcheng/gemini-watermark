/**
 * The gate that decides whether an image gets modified at all.
 *
 * Ported from the threshold check in GeminiWatermarkTool
 * `src/core/watermark_engine.cpp` `process_image`,
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * Kept as a standalone predicate rather than buried inside the detector
 * because it is the safety property the whole pipeline exists to provide:
 * a caller who drops a holiday photo into a batch job must get it back
 * untouched. Isolating it means it can be tested at `<`, `==` and `>`
 * without constructing an image, and lets a caller re-apply the same
 * comparison to a result they already hold.
 *
 * The detector's own stage predicates (circuit breaker, spatial rescue,
 * score fusion, snap trust) join this file in M4 commit 2.
 */

/**
 * Whether a detection confidence clears the caller's threshold.
 *
 * The comparison is `>=`, so a confidence exactly equal to the threshold
 * passes — matching `detection.confidence >= detection_threshold` upstream.
 *
 * This is the *only* gate. `DetectionResult.internalDetected` reports a
 * separate, fixed 0.35 label that upstream uses for logging; upstream is
 * explicit that OR-ing that label into this decision would make any
 * threshold above 0.35 a no-op, so it is deliberately not consulted here.
 */
export function passesThreshold(confidence: number, threshold: number): boolean {
  return confidence >= threshold;
}
