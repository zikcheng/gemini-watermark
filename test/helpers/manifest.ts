/**
 * The reference binary's own verbose log, typed and split into the shape
 * the port can be held against.
 *
 * `test/data/manifest.json` records what `gwt-mini` actually did to each
 * fixture: every `detect_one_variant` call it made, with the three stage
 * scores at the 3 decimals the log printed, and where removal landed. That
 * makes it the decision oracle for M4 — and the assertions built on it are
 * shared by two suites that differ only in where the pixels come from
 * (`test/detect-manifest.test.ts` rebuilds them from committed patches,
 * `test/golden/detect-full.test.ts` reads full-size kit images), so they
 * live here rather than being written twice and drifting apart.
 *
 * This is the one helper that imports `expect`. The alternative — returning
 * mismatch lists for the caller to assert on — would hide which field
 * failed behind a diff of two arrays, and the point of these assertions is
 * that a single wrong pixel coordinate names itself.
 */
import { expect } from 'vitest';

import type {
  DetectionResult,
  ProcessResult,
  WatermarkSize,
  WatermarkVariant,
} from '../../src/types.js';
import manifest from '../data/manifest.json';

/**
 * PLAN.md's budget for manifest scores: `absErr <= 2e-3`, no relative term.
 * It is not a fudge factor but the log's precision — `{:.3f}` printing
 * rounds to 5e-4, and a circuit-breaker confidence is reconstructed from an
 * already-rounded spatial (DEVIATIONS D2), which widens it further.
 */
export const MANIFEST_ABS_TOL = 2e-3;

/** One `detect_one_variant` call, as the log recorded it. */
export interface ManifestDetection {
  variant: WatermarkVariant;
  spatial: number;
  /** Absent on the circuit-breaker path, where stages 2 and 3 never ran. */
  gradient?: number;
  variance?: number;
  confidence: number;
  circuit_breaker: boolean;
  /** Upstream's internal 0.35 label, not the caller's gate. */
  detected: boolean;
  /** Present only on the re-detection removal runs internally. */
  snap_region?: { x: number; y: number; w: number; h: number };
  removal_position?: { x: number; y: number };
}

export interface ManifestRun {
  argv: string[];
  /** 0 processed, 1 skipped, 2 error (kit README §7). */
  exit_code: number;
  detections?: ManifestDetection[];
  removal_position?: { x: number; y: number };
  alpha_map?: { width: number; height: number };
  removal_size?: 'Small' | 'Large';
  removal_variant?: WatermarkVariant;
  output_written: boolean;
  output_decoded_sha256?: string;
}

export interface ManifestCase {
  name: string;
  eligible_for: string[];
  input: { format: string; width: number; height: number };
  runs: { default: ManifestRun; force?: ManifestRun; forced_size?: ManifestRun };
}

/**
 * Which downstream suite a case is applicable to (`eligible_for` in the
 * manifest, set by the kit when it generated the case).
 */
export type EligibleTag =
  | 'detection'
  | 'default_e2e'
  | 'force_remove'
  | 'add_v1'
  | 'add_v2_ext'
  | 'forced_size';

/** The cases carrying a given tag, in manifest order. */
export function casesFor(tag: EligibleTag): ManifestCase[] {
  return (manifest.cases as ManifestCase[]).filter((c) => c.eligible_for.includes(tag));
}

/** The cases tagged for detection, in manifest order. */
export function detectionCases(): ManifestCase[] {
  return casesFor('detection');
}

/**
 * Separate the gate attempts from the re-detection removal performs.
 *
 * The kit README (§3 of the porting notes) states the order the default run
 * records: V2 gate, then — if it passed — V2's internal re-detection;
 * otherwise the V1 gate, then V1's internal re-detection if *that* passed.
 * So a processed case ends with exactly one entry that is not an attempt,
 * and a skipped case ends with none. `exit_code` says which: 0 processed,
 * 1 skipped.
 *
 * The two are worth separating because only the gate attempts are contract
 * (`ProcessResult.attempts` excludes the internal pass) — but both are
 * `detect_one_variant` calls on the *unmodified* image, since removal
 * blends only after detecting, so both are equally assertable against
 * `detectWatermark`.
 */
export function splitDetections(entry: ManifestCase): {
  gates: ManifestDetection[];
  internal: ManifestDetection | undefined;
  all: ManifestDetection[];
} {
  const all = entry.runs.default.detections ?? [];
  if (entry.runs.default.exit_code === 0) {
    return { gates: all.slice(0, -1), internal: all[all.length - 1], all };
  }
  return { gates: all, internal: undefined, all };
}

/** Was the image modified by the default run? */
export function wasProcessed(entry: ManifestCase): boolean {
  return entry.runs.default.exit_code === 0;
}

/**
 * `absErr <= 2e-3` against the manifest, written out rather than through
 * `toBeCloseTo` — which measures decimal places and would accept the wrong
 * things at these magnitudes (PLAN.md tolerance principles).
 */
export function expectScoreMatches(actual: number, expected: number, what: string): void {
  expect(
    Math.abs(actual - expected),
    `${what}: |${actual} - ${expected}| exceeds ${MANIFEST_ABS_TOL}`,
  ).toBeLessThanOrEqual(MANIFEST_ABS_TOL);
}

/**
 * Hold one `DetectionResult` against one logged detection.
 *
 * Decisions are exact: variant, the circuit-breaker path, and — when the
 * log recorded one — the post-snap region down to the pixel. Only the three
 * scores and the fused confidence get a tolerance, and only because the log
 * printed them at 3 decimals.
 */
export function expectDetectionMatches(
  actual: DetectionResult,
  expected: ManifestDetection,
  label: string,
): void {
  expect(actual.variant, `${label} variant`).toBe(expected.variant);
  expect(actual.circuitBreaker, `${label} circuitBreaker`).toBe(expected.circuit_breaker);
  expectScoreMatches(actual.scores.spatial, expected.spatial, `${label} spatial`);
  expectScoreMatches(actual.confidence, expected.confidence, `${label} confidence`);

  if (expected.circuit_breaker) {
    // Stages 2 and 3 never ran, so the manifest carries no value for them —
    // and the port must report the same absence-of-evidence zeros rather
    // than measurements.
    expect(expected.gradient, `${label} manifest omits gradient`).toBeUndefined();
    expect(expected.variance, `${label} manifest omits variance`).toBeUndefined();
    expect(actual.scores.gradient, `${label} gradient`).toBe(0);
    expect(actual.scores.variance, `${label} variance`).toBe(0);
  } else {
    expectScoreMatches(actual.scores.gradient, expected.gradient ?? NaN, `${label} gradient`);
    expectScoreMatches(actual.scores.variance, expected.variance ?? NaN, `${label} variance`);
  }

  // `internalDetected` compares a double against 0.35 where upstream
  // compares a float, so the two disagree on a 5.96e-9 window just below
  // the constant (see `meetsInternalLabel`). Assert the label only after
  // confirming this confidence is nowhere near that window — guarding the
  // assumption instead of inheriting it.
  expect(
    Math.abs(actual.confidence - 0.35),
    `${label} confidence ${actual.confidence} is clear of the 0.35 label boundary`,
  ).toBeGreaterThan(MANIFEST_ABS_TOL);
  expect(actual.internalDetected, `${label} internalDetected`).toBe(expected.detected);

  if (expected.snap_region !== undefined) {
    expect(
      { x: actual.region.x, y: actual.region.y, w: actual.region.width, h: actual.region.height },
      `${label} post-snap region`,
    ).toEqual(expected.snap_region);
  }
}

/**
 * Hold a whole `processImage` run against the default run's record.
 *
 * Pixel comparison is the caller's job (only the golden suite has the
 * images); everything decided before a pixel moves is checked here.
 */
export function expectPipelineMatches(result: ProcessResult, entry: ManifestCase): void {
  const run = entry.runs.default;
  const { gates, internal } = splitDetections(entry);
  const processed = wasProcessed(entry);

  expect(result.status, `${entry.name} status`).toBe(processed ? 'processed' : 'skipped');
  expect(result.attempts, `${entry.name} gate attempt count`).toHaveLength(gates.length);
  for (const [index, expected] of gates.entries()) {
    const attempt = result.attempts[index];
    expect(attempt, `${entry.name} attempt ${index} present`).toBeDefined();
    expectDetectionMatches(
      attempt as DetectionResult,
      expected,
      `${entry.name} attempt ${index} (${expected.variant})`,
    );
  }

  if (!processed) {
    // A skip describes no modified image, so it reports no geometry.
    expect(result.variant, `${entry.name} variant`).toBeUndefined();
    expect(result.size, `${entry.name} size`).toBeUndefined();
    expect(result.region, `${entry.name} region`).toBeUndefined();
    expect(run.output_written, `${entry.name} wrote no output`).toBe(false);
    // The highest-scoring attempt is reported, ties going to the later one
    // (cli_app.cpp:293 replaces only on a strict improvement, starting from
    // the V1 retry) — see the tie note in docs/api-contract.md.
    const best = gates.reduce((a, b) => (b.confidence >= a.confidence ? b : a));
    expectScoreMatches(result.confidence, best.confidence, `${entry.name} reported confidence`);
    return;
  }

  const passing = gates[gates.length - 1];
  expect(passing, `${entry.name} has a passing gate attempt`).toBeDefined();
  expectScoreMatches(
    result.confidence,
    (passing as ManifestDetection).confidence,
    `${entry.name} reported confidence`,
  );

  expect(result.variant, `${entry.name} removal variant`).toBe(run.removal_variant);
  expect(result.size, `${entry.name} removal size`).toBe(
    run.removal_size === 'Small' ? ('small' satisfies WatermarkSize) : 'large',
  );
  // The exact pixel the binary blended at, and the exact template it used:
  // this is what the ±3px snap, the ROI clamping and the derived-size
  // resolution all have to land on together.
  expect(
    { x: result.region?.x, y: result.region?.y },
    `${entry.name} removal position`,
  ).toEqual(run.removal_position);
  expect(
    { width: result.region?.width, height: result.region?.height },
    `${entry.name} alpha map size`,
  ).toEqual({ width: run.alpha_map?.width, height: run.alpha_map?.height });
  expect(
    { x: result.region?.x, y: result.region?.y, w: result.region?.width, h: result.region?.height },
    `${entry.name} matches the internal re-detection's snap region`,
  ).toEqual(internal?.snap_region);
}
