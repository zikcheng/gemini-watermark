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

// The detector's own stage constants. Copied from `detect_one_variant`
// (watermark_engine.cpp), never re-tuned — CLAUDE.md rule 7.

/** `kSpatialThreshold`: below this, stages 2 and 3 never run. */
const SPATIAL_CIRCUIT_BREAKER = 0.25;

/** `kSpatialRescue`: a strong anchored match carries a weak fusion. */
const SPATIAL_RESCUE = 0.30;

/** `kDetectionThreshold`: the internal label, not the caller's gate. */
const INTERNAL_LABEL = 0.35;

/** The snap sweep is trusted only at this correlation or better. */
const SNAP_TRUST = 0.60;

/** Fusion weights: spatial dominates, then edges, then texture. */
const WEIGHT_SPATIAL = 0.50;
const WEIGHT_GRADIENT = 0.30;
const WEIGHT_VARIANCE = 0.20;

/**
 * Whether stage 1 correlated too weakly to be worth continuing.
 *
 * The comparison is `<`, so a spatial score exactly at 0.25 proceeds. On
 * this path upstream returns `spatial * 0.5` as the confidence **without
 * clamping**, which is why a circuit-broken result can be negative.
 */
export function spatialCircuitBroken(spatial: number): boolean {
  return spatial < SPATIAL_CIRCUIT_BREAKER;
}

/**
 * Whether an anchored spatial match is strong enough to carry the result
 * on its own.
 *
 * Busy backgrounds collapse stages 2 and 3 toward zero and drag the fused
 * score under the gate even when the spatial NCC — anchored at the formula
 * position, ±3px for V2 small — is unambiguous. Upstream calibrated this
 * against removed and clean corners: the highest negative observed was
 * 0.26, positives start at 0.30.
 */
export function spatialRescued(spatial: number): boolean {
  return spatial >= SPATIAL_RESCUE;
}

/**
 * Whether the snap sweep's best offset should be adopted.
 *
 * Below this a weak correlation can drift toward content edges, so the
 * geometry-derived formula position is the safer answer.
 */
export function snapTrusted(spatial: number): boolean {
  return spatial >= SNAP_TRUST;
}

/**
 * Combine the three stage scores into one confidence.
 *
 * Weighted sum clamped to [0, 1], then raised to the spatial score when
 * the rescue applies. Note the order: the clamp happens first, so the
 * rescue can lift the result above a clamped fusion but never above the
 * spatial score itself.
 */
export function fuseConfidence(spatial: number, gradient: number, variance: number): number {
  const fused =
    spatial * WEIGHT_SPATIAL + gradient * WEIGHT_GRADIENT + variance * WEIGHT_VARIANCE;
  const clamped = fused < 0 ? 0 : fused > 1 ? 1 : fused;
  return spatialRescued(spatial) && spatial > clamped ? spatial : clamped;
}

/**
 * Upstream's informational `confidence >= 0.35` label. Never the gate.
 *
 * This is the one threshold where the float-width difference is
 * observable rather than provably absent. Upstream compares a `float`
 * confidence against `0.35f`; this compares a double against the double
 * `0.35`, and `float32(0.35)` is `0.34999999403953552` — *below* the
 * double. A confidence landing in `[0.34999999403953552, 0.35)` is
 * therefore labelled detected by C++ and not by this. The window is
 * 5.96e-9 wide.
 *
 * Two reasons that is acceptable where the other thresholds got a proof.
 * Nothing decides on this label — it is reported, and `passesThreshold`
 * makes the actual call. And the confidence reaching it is a fused sum of
 * three correlations, not a quantized value, so unlike the alpha domain
 * there is no lattice argument to make; the closest the manifest comes is
 * 0.327, which sits 0.023 below — some four million ulps clear of the
 * disputed band.
 *
 * The practical consequence is for tests: `internalDetected` is not a
 * field to assert bit-for-bit against upstream without checking how close
 * the confidence sits to 0.35.
 */
export function meetsInternalLabel(confidence: number): boolean {
  return confidence >= INTERNAL_LABEL;
}
